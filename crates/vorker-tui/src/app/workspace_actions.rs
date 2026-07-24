use super::*;

#[allow(clippy::too_many_arguments)]
pub(crate) fn handle_workspace_runtime_action(
    runtime: &tokio::runtime::Runtime,
    bridge: &mut AcpBridge,
    app: &mut App,
    stdout: &mut io::Stdout,
    global_root: &Path,
    runtime_options: &RuntimeOptions,
    cwd: &mut PathBuf,
    workspace: &mut ProjectWorkspace,
    thread_store: &mut ThreadStore,
    side_agent_store: &mut SideAgentStore,
    prompt_history_store: &mut PromptHistoryStore,
    skill_store: &mut crate::SkillStore,
    session_event_store: &mut SessionEventStore,
    pending_permission_reply: &mut Option<tokio::sync::oneshot::Sender<Option<String>>>,
    action: AppCommand,
) -> io::Result<bool> {
    match action {
        AppCommand::NewThread => {
            let previous_thread = app
                .take_archived_thread()
                .unwrap_or_else(|| app.thread_record());
            thread_store.upsert(previous_thread)?;
            if let Some(reply) = pending_permission_reply.take() {
                let _ = reply.send(None);
            }
            let mut thread = thread_store.create_thread(&*cwd);
            thread.model = runtime_options.default_model.clone();
            thread.approval_mode = app.approval_mode();
            app.load_thread(thread);
            app.set_workspace_files(load_workspace_files(&*cwd));
            *thread_store = workspace.open_thread_store()?;
            replace_bridge_for_app(runtime, bridge, cwd, app, runtime_options)?;
            Ok(false)
        }
        AppCommand::ListThreads => {
            let threads = ProjectWorkspace::list_all_threads_under(global_root.to_path_buf())?;
            app.list_threads(&threads);
            Ok(false)
        }
        AppCommand::SwitchThread { thread_id } => {
            thread_store.upsert(app.thread_record())?;
            if let Some(thread) =
                ProjectWorkspace::find_thread_under(global_root.to_path_buf(), &thread_id)?
            {
                let next_cwd = PathBuf::from(&thread.cwd);
                let next_workspace =
                    ProjectWorkspace::at_root(global_root.to_path_buf(), &next_cwd)?;
                if !next_workspace.is_confirmed()
                    && !confirm_project_workspace(stdout, &next_workspace)?
                {
                    app.apply_system_notice("Thread switch cancelled.");
                    return Ok(false);
                }
                if let Err(error) = std::env::set_current_dir(&next_cwd) {
                    app.apply_system_notice(format!("Error: {error}"));
                    return Ok(false);
                }
                *cwd = next_cwd;
                *workspace = next_workspace;
                if let Some(reply) = pending_permission_reply.take() {
                    let _ = reply.send(None);
                }
                *thread_store = workspace.open_thread_store()?;
                *side_agent_store = workspace.open_side_agent_store()?;
                *prompt_history_store = workspace.open_prompt_history_store()?;
                *skill_store = workspace.open_skill_store()?;
                *session_event_store = workspace.open_session_event_store()?;
                let thread = hydrate_thread_from_events(thread, session_event_store)?;
                app.load_thread(thread);
                app.set_prompt_history(prompt_history_for_app(prompt_history_store));
                app.set_workspace_files(load_workspace_files(&*cwd));
                refresh_skill_state(app, &*cwd, skill_store)?;
                replace_bridge_for_app(runtime, bridge, cwd, app, runtime_options)?;
            } else {
                app.apply_system_notice(format!("Unknown thread id: {thread_id}"));
            }
            Ok(false)
        }
        AppCommand::ChangeDirectory { path } => {
            let next_cwd = resolve_directory_change(&*cwd, &path)?;
            let next_workspace = ProjectWorkspace::at_root(global_root.to_path_buf(), &next_cwd)?;
            if !next_workspace.is_confirmed()
                && !confirm_project_workspace(stdout, &next_workspace)?
            {
                app.apply_system_notice("Directory change cancelled.");
                return Ok(false);
            }
            thread_store.upsert(app.thread_record())?;
            std::env::set_current_dir(&next_cwd)?;
            *cwd = next_cwd;
            *workspace = next_workspace;
            if let Some(reply) = pending_permission_reply.take() {
                let _ = reply.send(None);
            }
            *thread_store = workspace.open_thread_store()?;
            *side_agent_store = workspace.open_side_agent_store()?;
            *prompt_history_store = workspace.open_prompt_history_store()?;
            *skill_store = workspace.open_skill_store()?;
            *session_event_store = workspace.open_session_event_store()?;
            let thread = thread_store.latest_for_cwd(&*cwd).unwrap_or_else(|| {
                let mut created = thread_store.create_thread(&*cwd);
                created.model = runtime_options.default_model.clone();
                created.approval_mode = app.approval_mode();
                created
            });
            let thread = hydrate_thread_from_events(thread, session_event_store)?;
            app.load_thread(thread);
            app.set_workspace_files(load_workspace_files(&*cwd));
            app.set_prompt_history(prompt_history_for_app(prompt_history_store));
            refresh_skill_state(app, &*cwd, skill_store)?;
            app.apply_system_notice(format!("Project directory set to {}.", cwd.display()));
            let cwd_label = cwd.display().to_string();
            let threads = ProjectWorkspace::list_all_threads_under(global_root.to_path_buf())?
                .into_iter()
                .filter(|thread| thread.cwd == cwd_label)
                .collect::<Vec<_>>();
            app.list_threads(&threads);
            replace_bridge_for_app(runtime, bridge, cwd, app, runtime_options)?;
            Ok(false)
        }
        _ => Ok(false),
    }
}
