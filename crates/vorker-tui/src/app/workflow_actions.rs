use super::*;

pub(crate) fn handle_workflow_action(
    runtime: &tokio::runtime::Runtime,
    bridge: &mut AcpBridge,
    app: &mut App,
    review_job: &mut Option<ReviewJob>,
    side_agent_store: &mut SideAgentStore,
    side_agent_jobs: &mut [SideAgentJob],
    action: AppCommand,
) -> io::Result<()> {
    match action {
        AppCommand::Stop => {
            let _ = runtime.block_on(bridge.cancel());
            if let Some(job) = review_job.as_mut() {
                let _ = job.child.kill();
            }
            let mut stopped_agents = 0usize;
            for job in side_agent_jobs.iter_mut().filter(|job| !job.completed) {
                let _ = job.child.kill();
                job.completed = true;
                let _ = side_agent_store.mark_finished(&job.id, SideAgentStatus::Stopped);
                stopped_agents += 1;
            }
            *review_job = None;
            app.stop_working_timer();
            let queued = app.queued_prompt_count();
            app.apply_system_notice(format!(
                "Stopped active work. {stopped_agents} side agent(s) stopped; {queued} queued prompt(s) remain."
            ));
        }
        AppCommand::SteerPrompt { prompt_text } => {
            runtime.block_on(bridge.prompt(prompt_text))?;
            app.apply_system_notice("Sent steering guidance.");
        }
        AppCommand::QueuePrompt {
            display_text,
            prompt_text,
        } => {
            app.queue_prompt(display_text, prompt_text);
        }
        AppCommand::ListQueuedPrompts => {
            let queued = app.queued_prompts();
            if queued.is_empty() {
                app.apply_system_notice("Queue is empty.");
            } else {
                app.apply_system_notice(format!("Queued prompts ({})", queued.len()));
                for (index, prompt) in queued.iter().enumerate() {
                    app.apply_system_notice(format!("{}. {}", index + 1, prompt));
                }
            }
        }
        AppCommand::PopQueuedPrompt => {
            if let Some(prompt) = app.pop_queued_prompt() {
                app.apply_system_notice(format!("Removed queued prompt: {prompt}"));
            } else {
                app.apply_system_notice("Queue is empty.");
            }
        }
        AppCommand::ClearQueuedPrompts => {
            let cleared = app.clear_queued_prompts();
            app.apply_system_notice(format!("Cleared {cleared} queued prompt(s)."));
        }
        _ => {}
    }

    Ok(())
}
