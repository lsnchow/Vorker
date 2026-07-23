use super::*;

#[allow(clippy::too_many_arguments)]
pub(crate) fn handle_local_session_action(
    runtime: &tokio::runtime::Runtime,
    bridge: &mut AcpBridge,
    app: &mut App,
    prompt_history_store: &mut PromptHistoryStore,
    skill_store: &mut crate::SkillStore,
    cwd: &Path,
    pending_permission_reply: &mut Option<tokio::sync::oneshot::Sender<Option<String>>>,
    action: AppCommand,
) -> io::Result<bool> {
    match action {
        AppCommand::ListPromptHistory => {
            let recent = prompt_history_store.recent(10);
            if recent.is_empty() {
                app.apply_system_notice("No prompt history yet.");
            } else {
                app.apply_system_notice("Prompt history:");
                for entry in recent {
                    app.apply_system_notice(format!("- {}", entry.text));
                }
            }
            Ok(false)
        }
        AppCommand::ListSkills => {
            apply_skill_listing(app);
            Ok(false)
        }
        AppCommand::SetSkillEnabled { name, enabled } => {
            let Some(skill_name) = resolve_skill_name(&app.skills, &name) else {
                app.apply_system_notice(format!("Unknown skill: {name}"));
                return Ok(false);
            };
            skill_store.set_enabled(&skill_name, enabled)?;
            refresh_skill_state(app, cwd, skill_store)?;
            app.apply_system_notice(format!(
                "{} skill {}.",
                if enabled { "Enabled" } else { "Disabled" },
                skill_name
            ));
            Ok(false)
        }
        AppCommand::SetModel { model } => {
            runtime.block_on(bridge.set_model(model))?;
            Ok(false)
        }
        AppCommand::SubmitPrompt {
            display_text,
            prompt_text,
        } => {
            prompt_history_store.append(display_text.clone())?;
            app.record_prompt_history(display_text);
            runtime.block_on(bridge.prompt(prompt_text))?;
            Ok(false)
        }
        AppCommand::CancelPrompt => {
            let _ = runtime.block_on(bridge.cancel());
            Ok(false)
        }
        AppCommand::ResolvePermission { option_id } => {
            if let Some(reply) = pending_permission_reply.take() {
                let _ = reply.send(option_id);
            }
            Ok(false)
        }
        AppCommand::ExitShell => Ok(true),
        _ => Ok(false),
    }
}
