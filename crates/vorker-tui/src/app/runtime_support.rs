use super::*;
use std::time::{Duration, Instant};

const BOOT_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) fn persist_dirty_thread(
    app: &mut App,
    thread_store: &mut ThreadStore,
    session_event_store: &SessionEventStore,
) -> io::Result<()> {
    if let Some(thread) = app.take_dirty_thread() {
        let previous = thread_store.thread(&thread.id);
        let events = derive_thread_events(previous.as_ref(), &thread);
        thread_store.upsert(thread.clone())?;
        session_event_store.append(&thread.id, &events)?;
    }
    Ok(())
}

pub(crate) fn prompt_history_for_app(store: &PromptHistoryStore) -> Vec<String> {
    let mut prompts = store
        .recent(50)
        .into_iter()
        .map(|entry| entry.text)
        .collect::<Vec<_>>();
    prompts.reverse();
    prompts
}

pub(crate) fn refresh_skill_state(
    app: &mut App,
    cwd: &Path,
    store: &crate::SkillStore,
) -> io::Result<()> {
    let skills = discover_skills(&skill_roots_for(cwd))?;
    let enabled = store.enabled();
    let context = build_skill_context(&skills, &enabled)?;
    app.set_skills(skills, enabled);
    app.set_skill_context(context);
    Ok(())
}

pub(crate) fn hydrate_thread_from_events(
    thread: StoredThread,
    session_event_store: &SessionEventStore,
) -> io::Result<StoredThread> {
    let events = session_event_store.events(&thread.id)?;
    if events.is_empty() {
        Ok(thread)
    } else {
        Ok(apply_events_to_thread(&thread, &events))
    }
}

pub(crate) fn confirm_project_workspace(
    stdout: &mut io::Stdout,
    workspace: &ProjectWorkspace,
) -> io::Result<bool> {
    let cwd = workspace.cwd().display().to_string();
    let workspace_path = format_path_for_humans(&workspace.project_dir());

    loop {
        let width = size()
            .map(|(columns, _)| usize::from(columns))
            .unwrap_or(120);
        let frame = normalize_for_raw_terminal(&render_project_confirmation(
            width,
            &cwd,
            &workspace_path,
            true,
        ));
        execute!(stdout, Clear(ClearType::All), MoveTo(0, 0))?;
        write!(stdout, "{frame}")?;
        stdout.flush()?;

        if let Event::Key(key) = read()? {
            match key.code {
                KeyCode::Enter => {
                    workspace.confirm()?;
                    return Ok(true);
                }
                KeyCode::Esc => return Ok(false),
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    return Ok(false);
                }
                _ => {}
            }
        }
    }
}

pub(crate) fn run_boot_sequence(
    stdout: &mut io::Stdout,
    app: &mut App,
    bridge: &mut AcpBridge,
    pending_permission_reply: &mut Option<tokio::sync::oneshot::Sender<Option<String>>>,
) -> io::Result<()> {
    let mut tick = 0usize;
    let minimum_ticks = boot_minimum_ticks();
    let started_at = Instant::now();

    loop {
        if let Some(message) =
            drain_bridge_events_with_status(app, bridge, pending_permission_reply)
        {
            return Err(io::Error::other(format!("ACP startup failed: {message}")));
        }

        let model = app.selected_model_id().map(str::to_string);
        let ready = model.is_some();
        let detail = model
            .map(|model| format!("ready on {model}"))
            .unwrap_or_else(|| "loading model inventory".to_string());
        let status = if ready { "ready" } else { "loading" };
        let active_step = (!ready).then_some("copilot-session");
        let steps = [BootStep::new("copilot-session", "copilot", status, &detail)];
        let width = size()
            .map(|(columns, _)| usize::from(columns))
            .unwrap_or(120);
        let frame =
            normalize_for_raw_terminal(&render_boot_frame(width, tick, active_step, &steps, true));
        execute!(stdout, Clear(ClearType::All), MoveTo(0, 0))?;
        write!(stdout, "{frame}")?;
        stdout.flush()?;

        if ready && tick >= minimum_ticks {
            break;
        }

        boot_timeout_result(started_at.elapsed(), BOOT_TIMEOUT)?;

        std::thread::sleep(Duration::from_millis(80));
        tick = tick.saturating_add(1);
    }

    Ok(())
}

pub(crate) fn drain_bridge_events(
    app: &mut App,
    bridge: &mut AcpBridge,
    pending_permission_reply: &mut Option<tokio::sync::oneshot::Sender<Option<String>>>,
) {
    let _ = drain_bridge_events_with_status(app, bridge, pending_permission_reply);
}

fn drain_bridge_events_with_status(
    app: &mut App,
    bridge: &mut AcpBridge,
    pending_permission_reply: &mut Option<tokio::sync::oneshot::Sender<Option<String>>>,
) -> Option<String> {
    let mut startup_error = None;
    while let Ok(event) = bridge.evt_rx.try_recv() {
        if let Some(message) = apply_bridge_event(app, pending_permission_reply, event) {
            startup_error = Some(message);
        }
    }
    startup_error
}

fn apply_bridge_event(
    app: &mut App,
    pending_permission_reply: &mut Option<tokio::sync::oneshot::Sender<Option<String>>>,
    event: BridgeEvent,
) -> Option<String> {
    match event {
        BridgeEvent::TextChunk { text } => app.apply_assistant_chunk(&text),
        BridgeEvent::ToolCall { title } => app.apply_tool_notice(title, None),
        BridgeEvent::ToolUpdate { title, detail } => {
            if let Some(update) = tool_update_text(title, detail) {
                app.apply_tool_update(update);
            }
        }
        BridgeEvent::PermissionRequest {
            title,
            options,
            reply,
        } => {
            if app.approval_mode() == ApprovalMode::Auto {
                if let Some(option) = choose_auto_permission(&options) {
                    let _ = reply.send(Some(option.option_id.clone()));
                    app.apply_system_notice(format!("Auto-approved: {}", option.name));
                } else {
                    let _ = reply.send(None);
                    app.apply_system_notice(format!("Permission cancelled: {title}"));
                }
                return None;
            }
            if let Some(previous) = pending_permission_reply.take() {
                let _ = previous.send(None);
            }
            *pending_permission_reply = Some(reply);
            app.open_permission_prompt(
                title,
                options
                    .into_iter()
                    .map(|option| PermissionOptionView {
                        option_id: option.option_id,
                        name: option.name,
                    })
                    .collect(),
            );
        }
        BridgeEvent::SessionReady {
            current_model,
            available_models,
        } => {
            if let Some(current_model) = current_model {
                app.apply_session_ready(current_model, available_models);
            } else if let Some(first_model) = available_models.first().cloned() {
                app.apply_session_ready(first_model, available_models);
            } else {
                app.set_model_choices(available_models);
            }
        }
        BridgeEvent::ModelChanged { model } => app.apply_model_changed(model),
        BridgeEvent::PromptDone => app.finish_prompt(),
        BridgeEvent::Error { message } => {
            app.apply_system_notice(format!("Error: {message}"));
            app.finish_prompt();
            return Some(message);
        }
    }
    None
}

fn boot_timeout_result(elapsed: Duration, timeout: Duration) -> io::Result<()> {
    if elapsed >= timeout {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("ACP startup timed out after {}s", timeout.as_secs()),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{BOOT_TIMEOUT, apply_bridge_event, boot_timeout_result};
    use crate::App;
    use crate::bridge::BridgeEvent;
    use std::io;
    use tokio::sync::oneshot;
    use vorker_core::Snapshot;

    #[test]
    fn session_ready_without_current_model_selects_the_first_available_model() {
        let mut app = App::new(Snapshot::default());
        let mut pending_permission_reply = None;

        let result = apply_bridge_event(
            &mut app,
            &mut pending_permission_reply,
            BridgeEvent::SessionReady {
                current_model: None,
                available_models: vec!["gpt-5.4".to_string(), "gpt-5.3-codex".to_string()],
            },
        );

        assert_eq!(result, None);
        assert_eq!(app.selected_model_id(), Some("gpt-5.4"));
        assert_eq!(
            app.model_choices(),
            vec!["gpt-5.4".to_string(), "gpt-5.3-codex".to_string()]
        );
    }

    #[test]
    fn bridge_error_returns_a_startup_failure_signal() {
        let mut app = App::new(Snapshot::default());
        let mut pending_permission_reply = None;

        let result = apply_bridge_event(
            &mut app,
            &mut pending_permission_reply,
            BridgeEvent::Error {
                message: "copilot bootstrap failed".to_string(),
            },
        );

        assert_eq!(result.as_deref(), Some("copilot bootstrap failed"));
        assert!(
            app.render(100, false)
                .contains("Error: copilot bootstrap failed")
        );
    }

    #[test]
    fn boot_timeout_reports_a_timed_out_startup() {
        let error = boot_timeout_result(BOOT_TIMEOUT, BOOT_TIMEOUT).expect_err("timeout error");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error.to_string().contains("ACP startup timed out"));
    }

    #[test]
    fn permission_request_can_still_be_buffered_while_boot_waits() {
        let mut app = App::new(Snapshot::default());
        let mut pending_permission_reply = None;
        let (reply_tx, _reply_rx) = oneshot::channel();

        let result = apply_bridge_event(
            &mut app,
            &mut pending_permission_reply,
            BridgeEvent::PermissionRequest {
                title: "Allow tool".to_string(),
                options: Vec::new(),
                reply: reply_tx,
            },
        );

        assert_eq!(result, None);
        assert!(pending_permission_reply.is_some());
    }
}
