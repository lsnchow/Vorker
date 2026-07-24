use super::*;
use std::ffi::OsString;
use std::process::Stdio;

pub(crate) fn current_shell_review_scope() -> Option<String> {
    std::env::var("VORKER_REVIEW_SCOPE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn spawn_side_agent(
    cwd: &Path,
    prompt_text: &str,
    store: &mut SideAgentStore,
    agents_dir: &Path,
) -> io::Result<SideAgentJob> {
    let model = current_review_model();
    let record = store.create_job_in_dir(cwd, prompt_text, &model, agents_dir)?;
    let output_path = PathBuf::from(&record.output_path);
    let stderr_path = PathBuf::from(&record.stderr_path);
    let events_path = PathBuf::from(&record.events_path);
    let events = std::fs::File::create(&events_path)?;
    let stderr = std::fs::File::create(&stderr_path)?;
    let mut command = build_side_agent_command(cwd, prompt_text, &model, &output_path)?;
    command
        .stdout(Stdio::from(events))
        .stderr(Stdio::from(stderr));

    match command.spawn() {
        Ok(child) => Ok(SideAgentJob {
            id: record.id,
            display_name: record.display_name,
            child,
            output_path,
            stderr_path,
            completed: false,
        }),
        Err(error) => {
            let _ = store.mark_finished(&record.id, SideAgentStatus::Failed);
            Err(error)
        }
    }
}

fn build_side_agent_command(
    cwd: &Path,
    prompt_text: &str,
    model: &str,
    output_path: &Path,
) -> io::Result<std::process::Command> {
    let mut command = std::process::Command::new(configured_codex_bin());
    command
        .arg("exec")
        .arg("--model")
        .arg(model)
        .arg("--full-auto")
        .arg("--color")
        .arg("never")
        .arg("--json")
        .arg("--skip-git-repo-check")
        .arg("--output-last-message")
        .arg(output_path)
        .arg("-C")
        .arg(cwd)
        .arg(prompt_text);

    Ok(command)
}

fn configured_codex_bin() -> OsString {
    match std::env::var_os("CODEX_BIN") {
        Some(path) if !path.is_empty() => path,
        _ => OsString::from("codex"),
    }
}

pub(crate) fn poll_side_agent_jobs(
    app: &mut App,
    jobs: &mut [SideAgentJob],
    store: &mut SideAgentStore,
) -> io::Result<()> {
    for job in jobs.iter_mut().filter(|job| !job.completed) {
        if let Some(status) = job.child.try_wait()? {
            job.completed = true;
            let stored_status = if status.success() {
                SideAgentStatus::Completed
            } else {
                SideAgentStatus::Failed
            };
            store.mark_finished(&job.id, stored_status)?;
            if status.success() {
                app.apply_system_notice(format!("Side agent {} finished with {}.", job.id, status));
            } else {
                let detail = std::fs::read_to_string(&job.stderr_path)
                    .ok()
                    .map(|text| text.trim().to_string())
                    .filter(|text| !text.is_empty())
                    .unwrap_or_else(|| status.to_string());
                app.apply_system_notice(format!("Side agent {} failed: {detail}", job.id));
            }
        }
    }
    Ok(())
}

#[must_use]
pub fn load_bootstrap_snapshot() -> Snapshot {
    Snapshot::default()
}

pub(crate) fn should_redraw_frame(previous: &str, next: &str) -> bool {
    previous != next
}

pub(crate) fn load_timeline_text(
    session_event_store: &SessionEventStore,
    thread: &StoredThread,
) -> io::Result<String> {
    let events = session_event_store.events(&thread.id)?;
    if events.is_empty() {
        Ok(render_thread_timeline(thread))
    } else {
        Ok(render_session_event_timeline_with_mode(
            &thread.name,
            &events,
            "full",
            None,
            None,
        ))
    }
}

pub(crate) fn load_timeline_text_with_mode(
    session_event_store: &SessionEventStore,
    thread: &StoredThread,
    mode: &str,
    filter: Option<&str>,
    limit: Option<usize>,
) -> io::Result<String> {
    let events = session_event_store.events(&thread.id)?;
    if events.is_empty() {
        Ok(render_thread_timeline_with_mode(
            thread, mode, filter, limit,
        ))
    } else {
        Ok(render_session_event_timeline_with_mode(
            &thread.name,
            &events,
            mode,
            filter,
            limit,
        ))
    }
}

pub(crate) fn summarize_transcript_rows(rows: &[TranscriptRow]) -> String {
    let mut lines = vec![format!("Compacted {} row(s).", rows.len())];
    for (index, row) in rows.iter().take(8).enumerate() {
        let kind = match row.kind {
            RowKind::System => "system",
            RowKind::User => "user",
            RowKind::Assistant => "assistant",
            RowKind::Tool => "tool",
        };
        let summary = row
            .text
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .chars()
            .take(100)
            .collect::<String>();
        lines.push(format!("{}. [{}] {}", index + 1, kind, summary));
    }
    if rows.len() > 8 {
        lines.push(format!("… {} more row(s) omitted", rows.len() - 8));
    }
    lines.join("\n")
}

pub(crate) fn current_shell_theme() -> &'static str {
    match std::env::var("VORKER_THEME")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "review" => "review",
        _ => "default",
    }
}

pub(crate) fn current_review_mode() -> bool {
    matches!(
        std::env::var("VORKER_REVIEW_MODE")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "review"
    )
}

#[cfg(test)]
mod tests {
    use super::{build_side_agent_command, spawn_side_agent};
    use crate::SideAgentStore;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("vorker-shell-helper-{name}-{suffix}"))
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn side_agent_spawn_honors_configured_codex_bin_environment_path() {
        let _guard = env_lock().lock().expect("env lock");
        let root = unique_temp_dir("codex-bin");
        let fake_bin_dir = root.join("bin");
        let fake_codex = fake_bin_dir.join("codex-custom");
        fs::create_dir_all(&fake_bin_dir).expect("bin dir");
        fs::write(&fake_codex, "#!/bin/sh\nexit 0\n").expect("write fake codex");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&fake_codex).expect("metadata").permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&fake_codex, perms).expect("chmod");
        }

        let original_codex_bin = std::env::var_os("CODEX_BIN");
        unsafe {
            std::env::set_var("CODEX_BIN", &fake_codex);
        }

        let command = build_side_agent_command(
            PathBuf::from("/workspace").as_path(),
            "inspect auth boundary",
            "gpt-5.4",
            root.join("out.txt").as_path(),
        )
        .expect("command");
        assert_eq!(command.get_program(), fake_codex.as_os_str());

        let mut store =
            SideAgentStore::open_at(root.join("agents.json")).expect("open side-agent store");
        let result = spawn_side_agent(
            PathBuf::from("/workspace").as_path(),
            "inspect auth boundary",
            &mut store,
            &root.join("side-agents"),
        );

        unsafe {
            match original_codex_bin {
                Some(path) => std::env::set_var("CODEX_BIN", path),
                None => std::env::remove_var("CODEX_BIN"),
            }
        }

        let mut job =
            result.expect("expected configured CODEX_BIN to be used for side-agent runtime");
        let _ = job.child.kill();
        let _ = fs::remove_dir_all(root);
    }
}
