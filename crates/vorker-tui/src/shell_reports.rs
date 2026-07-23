use std::path::{Path, PathBuf};

use crate::{RowKind, StoredSideAgentJob, StoredThread, TranscriptRow};

pub fn format_thread_duration(seconds: u64) -> String {
    match seconds {
        0..=59 => format!("{seconds}s"),
        60..=3599 => format!("{}m {}s", seconds / 60, seconds % 60),
        _ => format!("{}h {}m", seconds / 3600, (seconds % 3600) / 60),
    }
}

pub fn format_path_for_humans(path: &Path) -> String {
    let raw = path.display().to_string();
    if let Some(home) = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|value| value.display().to_string())
        && raw.starts_with(&home)
    {
        return raw.replacen(&home, "~", 1);
    }
    raw
}

#[allow(clippy::too_many_arguments)]
pub fn render_status_summary(
    model: &str,
    cwd: &str,
    workspace: &str,
    approvals: &str,
    thread_name: &str,
    thread_duration: &str,
    transcript_rows: usize,
    event_count: usize,
    queued_prompts: usize,
    total_agents: usize,
    running_agents: usize,
    running_agent_names: &[String],
) -> String {
    let mut lines = vec![
        "Status".to_string(),
        format!("model: {model}"),
        format!("cwd: {cwd}"),
        format!("workspace: {workspace}"),
        format!("approvals: {approvals}"),
        format!("thread: {thread_name} ({thread_duration})"),
        format!("transcript rows: {transcript_rows}"),
        format!("events: {event_count}"),
        format!("queued prompts: {queued_prompts}"),
        format!("side agents: {total_agents} total, {running_agents} running"),
    ];
    if !running_agent_names.is_empty() {
        lines.push(format!(
            "running agents: {}",
            running_agent_names.join(", ")
        ));
    }
    lines.join("\n")
}

pub fn render_agent_roster(jobs: &[StoredSideAgentJob]) -> String {
    if jobs.is_empty() {
        return "No side agents in this session.".to_string();
    }

    let mut lines = vec![
        "## Side agents".to_string(),
        format!("{} tracked", jobs.len()),
    ];
    for job in jobs {
        let finished = job
            .finished_at_epoch_seconds
            .unwrap_or_else(now_epoch_seconds_for_reports);
        let elapsed = finished.saturating_sub(job.created_at_epoch_seconds);
        lines.push(String::new());
        lines.push(format!(
            "- {} [{}]",
            job.display_name,
            job.status.label().to_ascii_lowercase()
        ));
        lines.push(format!("  id: {}", job.id));
        lines.push(format!("  model: {}", job.model));
        lines.push(format!(
            "  cwd: {}",
            format_path_for_humans(Path::new(&job.cwd))
        ));
        lines.push(format!("  elapsed: {}", format_thread_duration(elapsed)));
        lines.push(format!("  prompt: {}", job.prompt));
    }
    lines.join("\n")
}

fn now_epoch_seconds_for_reports() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn render_thread_timeline(thread: &StoredThread) -> String {
    render_thread_timeline_with_mode(thread, "full", None, None)
}

pub fn render_thread_timeline_with_mode(
    thread: &StoredThread,
    mode: &str,
    filter: Option<&str>,
    limit: Option<usize>,
) -> String {
    if thread.rows.is_empty() {
        return "Timeline is empty.".to_string();
    }

    let filtered = filter
        .map(|filter| {
            thread
                .rows
                .iter()
                .filter(|row| row_matches_filter(row, filter))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| thread.rows.clone());

    let visible = if mode.eq_ignore_ascii_case("recent") {
        let window = limit.unwrap_or(10);
        let start = filtered.len().saturating_sub(window);
        filtered[start..].to_vec()
    } else {
        filtered
    };

    if visible.is_empty() {
        return "Timeline is empty.".to_string();
    }

    let mut lines = vec![format!(
        "## Timeline\n- thread: {}\n- rows: {}\n- mode: {}",
        thread.name,
        visible.len(),
        mode
    )];
    for (index, row) in visible.iter().enumerate() {
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
    lines.join("\n")
}

fn row_matches_filter(row: &TranscriptRow, filter: &str) -> bool {
    match filter.to_ascii_lowercase().as_str() {
        "system" => row.kind == RowKind::System,
        "user" => row.kind == RowKind::User,
        "assistant" => row.kind == RowKind::Assistant,
        "tool" => row.kind == RowKind::Tool,
        _ => false,
    }
}
