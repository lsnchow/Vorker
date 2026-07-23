use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{self, Write};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use vorker_tui::{ProjectWorkspace, RowKind, TranscriptRow};

pub const DEFAULT_ADVERSARIAL_MODEL: &str = "gpt-5.3-codex";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewScope {
    Auto,
    WorkingTree,
    Staged,
    AllFiles,
    Branch,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AdversarialFinding {
    pub severity: String,
    pub title: String,
    pub body: String,
    pub file: String,
    pub line_start: usize,
    pub line_end: usize,
    pub confidence: f32,
    pub recommendation: String,
    #[serde(default)]
    pub teaching_note: Option<String>,
    #[serde(default)]
    pub patch_plan: Option<String>,
    #[serde(skip)]
    pub code_snippet: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AdversarialReport {
    pub verdict: String,
    pub summary: String,
    pub findings: Vec<AdversarialFinding>,
    pub next_steps: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct AdversarialRunRequest {
    pub cwd: PathBuf,
    pub base: Option<String>,
    pub scope: ReviewScope,
    pub focus: String,
    pub coach: bool,
    pub apply: bool,
    pub popout: bool,
    pub model: String,
    pub output_report_path: Option<PathBuf>,
    pub events_file_path: Option<PathBuf>,
    pub status_file_path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct AdversarialRunResult {
    pub report_markdown: String,
    pub report_path: PathBuf,
    pub apply_summary: Option<String>,
}

#[derive(Clone, Debug)]
struct ReviewContext {
    target_label: String,
    content: String,
}

pub fn run_adversarial(
    request: &AdversarialRunRequest,
) -> Result<AdversarialRunResult, Box<dyn std::error::Error + Send + Sync>> {
    let workspace = ProjectWorkspace::for_cwd(&request.cwd)?;
    workspace.confirm()?;
    write_status(&request.status_file_path, "collecting review context");
    let context = collect_review_context(&request.cwd, request.base.as_deref(), request.scope)?;
    if context.content.trim().is_empty() {
        return Err(io::Error::other("Nothing to review in the selected scope.").into());
    }

    let prompt = build_adversarial_prompt(&context, &request.focus, request.coach);
    write_status(&request.status_file_path, "running adversarial review");
    let mut report = run_codex_review(
        &request.cwd,
        &request.model,
        &prompt,
        request.events_file_path.as_ref(),
        request.coach,
    )?;
    enrich_findings_with_code(&request.cwd, &mut report);
    let report_markdown = render_markdown_report(&report, request.coach);
    write_status(&request.status_file_path, "writing review report");
    let report_path = write_report(
        &workspace,
        &report_markdown,
        request.output_report_path.clone(),
    )?;

    let apply_summary = if request.apply {
        write_status(&request.status_file_path, "applying suggested patch");
        Some(run_codex_apply(
            &request.cwd,
            &request.model,
            &report_markdown,
        )?)
    } else {
        None
    };
    write_status(&request.status_file_path, "complete");

    Ok(AdversarialRunResult {
        report_markdown,
        report_path,
        apply_summary,
    })
}

pub fn render_markdown_report(report: &AdversarialReport, coach: bool) -> String {
    let mut lines = vec![
        "# Adversarial Review".to_string(),
        String::new(),
        format!("**Verdict:** {}", report.verdict),
        String::new(),
        "## Summary".to_string(),
        report.summary.clone(),
        String::new(),
        "## Findings".to_string(),
    ];

    if report.findings.is_empty() {
        lines.push("No material adversarial findings.".to_string());
    }

    for finding in &report.findings {
        lines.push(String::new());
        lines.push(format!(
            "### [{}] {}",
            finding.severity.to_uppercase(),
            finding.title
        ));
        lines.push(format!(
            "- Location: `{}`:{}-{}",
            finding.file, finding.line_start, finding.line_end
        ));
        lines.push(format!("- Confidence: {:.2}", finding.confidence));
        lines.push(String::new());
        lines.push(finding.body.clone());
        lines.push(String::new());
        lines.push("**Recommendation**".to_string());
        lines.push(finding.recommendation.clone());
        if let Some(code) = &finding.code_snippet {
            lines.push(String::new());
            lines.push("```rust".to_string());
            lines.push(code.clone());
            lines.push("```".to_string());
        }
        if coach {
            if let Some(note) = &finding.teaching_note {
                lines.push(String::new());
                lines.push("## Coaching".to_string());
                lines.push(note.clone());
            }
            if let Some(plan) = &finding.patch_plan {
                lines.push(String::new());
                lines.push("## Suggested Patch Direction".to_string());
                lines.push(plan.clone());
            }
        }
    }

    if !report.next_steps.is_empty() {
        lines.push(String::new());
        lines.push("## Next Steps".to_string());
        for step in &report.next_steps {
            lines.push(format!("- {step}"));
        }
    }

    lines.join("\n")
}

pub fn build_popout_command(
    cwd: &str,
    model: &str,
    scope: ReviewScope,
    coach: bool,
    apply: bool,
    focus: &str,
) -> String {
    format!(
        "cd '{}' && VORKER_THEME=review VORKER_REVIEW_MODE=1 VORKER_REVIEW_AUTO=1 VORKER_REVIEW_SCOPE={} VORKER_REVIEW_COACH={} VORKER_REVIEW_APPLY={} VORKER_REVIEW_FOCUS='{}' vorker --model {}",
        escape_single_quotes(cwd),
        review_scope_label(scope),
        if coach { "1" } else { "0" },
        if apply { "1" } else { "0" },
        escape_single_quotes(focus),
        shell_escape_arg(model)
    )
}

fn build_adversarial_prompt(context: &ReviewContext, focus: &str, coach: bool) -> String {
    let coaching_block = if coach {
        "\n<coaching_mode>\nAdd optional `teaching_note` and `patch_plan` fields for each finding. Use them to explain the engineering lesson in plain English and propose the smallest safe patch direction.\n</coaching_mode>"
    } else {
        ""
    };

    format!(
        "<role>\nYou are Vorker's adversarial code reviewer.\nYour job is to break confidence in the change, not to validate it.\n</role>\n\n<task>\nReview the provided repository context as if you are trying to find the strongest reasons this change should not ship yet.\nTarget: {target}\nUser focus: {focus}\n</task>\n\n<operating_stance>\nDefault to skepticism.\nAssume the change can fail in subtle, high-cost, or user-visible ways until the evidence says otherwise.\nDo not give credit for intent, partial fixes, or follow-up work.\n</operating_stance>\n\n<attack_surface>\nPrioritize expensive or dangerous failures:\n- auth, permissions, trust boundaries\n- data loss, corruption, duplication\n- rollback safety, retries, partial failure, idempotency gaps\n- race conditions, stale state, re-entrancy\n- null, timeout, empty-state, degraded dependency behavior\n- migration hazards, compatibility regressions, observability gaps\n</attack_surface>\n\n<output_contract>\nReturn only valid JSON matching this shape:\n{{\n  \"verdict\": \"approve\" | \"needs-attention\",\n  \"summary\": string,\n  \"findings\": [{{\n    \"severity\": \"critical\" | \"high\" | \"medium\" | \"low\",\n    \"title\": string,\n    \"body\": string,\n    \"file\": string,\n    \"line_start\": number,\n    \"line_end\": number,\n    \"confidence\": number,\n    \"recommendation\": string,\n    \"teaching_note\": string | null,\n    \"patch_plan\": string | null\n  }}],\n  \"next_steps\": [string]\n}}\nKeep findings material and grounded in the provided context only.\n</output_contract>{coaching_block}\n\n<repository_context>\n{content}\n</repository_context>\n",
        target = context.target_label,
        focus = if focus.trim().is_empty() {
            "No extra focus provided."
        } else {
            focus
        },
        coaching_block = coaching_block,
        content = context.content,
    )
}

fn collect_review_context(
    cwd: &Path,
    base: Option<&str>,
    requested_scope: ReviewScope,
) -> io::Result<ReviewContext> {
    let in_git_repo = is_git_repository(cwd);
    let scope = match requested_scope {
        ReviewScope::Auto => {
            if base.is_some() {
                ReviewScope::Branch
            } else if in_git_repo {
                ReviewScope::WorkingTree
            } else {
                ReviewScope::AllFiles
            }
        }
        ReviewScope::Branch => ReviewScope::Branch,
        ReviewScope::WorkingTree => {
            if !in_git_repo {
                return Err(io::Error::other(
                    "working-tree review requires a git repository",
                ));
            }
            ReviewScope::WorkingTree
        }
        ReviewScope::Staged => {
            if !in_git_repo {
                return Err(io::Error::other("staged review requires a git repository"));
            }
            ReviewScope::Staged
        }
        ReviewScope::AllFiles => ReviewScope::AllFiles,
    };

    if scope == ReviewScope::Branch {
        let Some(base) = base else {
            return Err(io::Error::other("branch review requires --base <ref>"));
        };
        ensure_git_repository(cwd)?;
        let summary = run_git(cwd, ["diff", "--shortstat", &format!("{base}...HEAD")])?;
        let diff = run_git(cwd, ["diff", "--unified=3", &format!("{base}...HEAD")])?;
        if summary.trim().is_empty() && diff.trim().is_empty() {
            return Ok(ReviewContext {
                target_label: format!("branch diff against {base}"),
                content: String::new(),
            });
        }
        return Ok(ReviewContext {
            target_label: format!("branch diff against {base}"),
            content: format!("## Git diff summary\n{summary}\n\n## Diff\n{diff}"),
        });
    }

    if scope == ReviewScope::AllFiles {
        let content = collect_workspace_file_context(cwd)?;
        return Ok(ReviewContext {
            target_label: "workspace files".to_string(),
            content,
        });
    }

    let status = run_git(cwd, ["status", "--short", "--untracked-files=all"])?;
    let staged = run_git(cwd, ["diff", "--cached", "--unified=3"])?;
    let unstaged = if scope == ReviewScope::Staged {
        String::new()
    } else {
        run_git(cwd, ["diff", "--unified=3"])?
    };
    let untracked = collect_untracked_file_context(cwd, &status)?;
    let mut sections = Vec::new();
    if !status.trim().is_empty() {
        sections.push(format!("## Git status\n{status}"));
    }
    if !staged.trim().is_empty() {
        sections.push(format!("## Staged diff\n{staged}"));
    }
    if !unstaged.trim().is_empty() {
        sections.push(format!("## Unstaged diff\n{unstaged}"));
    }
    if !untracked.trim().is_empty() {
        sections.push(format!("## Untracked files\n{untracked}"));
    }

    Ok(ReviewContext {
        target_label: if scope == ReviewScope::Staged {
            "staged changes".to_string()
        } else {
            "current working tree".to_string()
        },
        content: sections.join("\n\n"),
    })
}

fn collect_workspace_file_context(cwd: &Path) -> io::Result<String> {
    let mut files = Vec::new();
    let mut stack = vec![cwd.to_path_buf()];
    while let Some(path) = stack.pop() {
        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let Ok(relative) = entry_path.strip_prefix(cwd) else {
                continue;
            };
            if relative.as_os_str().is_empty() {
                continue;
            }
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                let skip = relative.iter().any(|segment| {
                    matches!(
                        segment.to_string_lossy().as_ref(),
                        ".git" | "node_modules" | "target" | ".next" | "dist" | "__pycache__"
                    )
                });
                if !skip {
                    stack.push(entry_path);
                }
                continue;
            }
            let content = fs::read_to_string(&entry_path).unwrap_or_default();
            if content.is_empty() {
                continue;
            }
            files.push(format!(
                "### {}\n```text\n{}\n```",
                relative.display(),
                content.lines().take(160).collect::<Vec<_>>().join("\n")
            ));
        }
    }
    files.sort();
    Ok(files.join("\n\n"))
}

fn collect_untracked_file_context(cwd: &Path, status: &str) -> io::Result<String> {
    let mut sections = Vec::new();
    for line in status.lines() {
        let Some(path) = line.strip_prefix("?? ") else {
            continue;
        };
        let full_path = cwd.join(path);
        if !full_path.is_file() {
            continue;
        }
        let content = fs::read_to_string(&full_path).unwrap_or_default();
        if content.is_empty() {
            continue;
        }
        let preview = content.lines().take(120).collect::<Vec<_>>().join("\n");
        sections.push(format!("### {path}\n```text\n{preview}\n```"));
    }
    Ok(sections.join("\n\n"))
}

fn run_codex_review(
    cwd: &Path,
    model: &str,
    prompt: &str,
    events_file_path: Option<&PathBuf>,
    coach: bool,
) -> Result<AdversarialReport, Box<dyn std::error::Error + Send + Sync>> {
    let schema_path = temp_file_path("vorker-adversarial-schema", "json");
    let output_path = temp_file_path("vorker-adversarial-output", "json");
    fs::write(&schema_path, review_schema_json())?;

    let mut command = Command::new("codex");
    command
        .arg("exec")
        .arg("--model")
        .arg(model)
        .arg("--skip-git-repo-check")
        .arg("--json")
        .arg("--sandbox")
        .arg("read-only")
        .arg("--color")
        .arg("never")
        .arg("--output-schema")
        .arg(&schema_path)
        .arg("--output-last-message")
        .arg(&output_path)
        .arg("-C")
        .arg(cwd)
        .arg("-");
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes())?;
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("codex stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("codex stderr unavailable"))?;

    let mut buffered_stderr = String::new();
    let mut review_from_stream = None;
    let stdout_reader = BufReader::new(stdout);
    for line in stdout_reader.lines() {
        let line = line?;
        maybe_capture_stream_event(&line, events_file_path, &mut review_from_stream, coach)?;
    }
    let stderr_reader = BufReader::new(stderr);
    for line in stderr_reader.lines() {
        let line = line?;
        buffered_stderr.push_str(&line);
        buffered_stderr.push('\n');
    }
    let exit_status = child.wait()?;
    if !exit_status.success() {
        return Err(io::Error::other(buffered_stderr.trim().to_string()).into());
    }

    let report = if let Some(report) = review_from_stream {
        report
    } else {
        let raw = fs::read_to_string(&output_path)?;
        serde_json::from_str::<AdversarialReport>(&raw).map_err(|error| {
            io::Error::other(format!(
                "failed to parse adversarial review JSON: {error}\nraw output:\n{raw}"
            ))
        })?
    };
    Ok(report)
}

fn run_codex_apply(
    cwd: &Path,
    model: &str,
    report_markdown: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let output_path = temp_file_path("vorker-adversarial-apply", "md");
    let prompt = format!(
        "<task>\nApply the smallest safe patch that addresses the findings below.\nDo not refactor unrelated code.\nIf a finding is unclear or unsupported, skip it.\n</task>\n\n<report>\n{report_markdown}\n</report>\n"
    );

    let mut command = Command::new("codex");
    command
        .arg("exec")
        .arg("--model")
        .arg(model)
        .arg("--skip-git-repo-check")
        .arg("--full-auto")
        .arg("--color")
        .arg("never")
        .arg("--output-last-message")
        .arg(&output_path)
        .arg("-C")
        .arg(cwd)
        .arg("-");
    command.stdin(Stdio::piped());
    command.stdout(Stdio::null());
    command.stderr(Stdio::piped());

    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(
            io::Error::other(String::from_utf8_lossy(&output.stderr).trim().to_string()).into(),
        );
    }

    Ok(fs::read_to_string(output_path).unwrap_or_else(|_| "Applied follow-up patch.".to_string()))
}

fn enrich_findings_with_code(cwd: &Path, report: &mut AdversarialReport) {
    for finding in &mut report.findings {
        finding.code_snippet =
            load_code_snippet(cwd, &finding.file, finding.line_start, finding.line_end);
    }
}

fn load_code_snippet(cwd: &Path, file: &str, line_start: usize, line_end: usize) -> Option<String> {
    let full_path = cwd.join(file);
    let content = fs::read_to_string(full_path).ok()?;
    let lines = content.lines().collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }
    let start = line_start.saturating_sub(2).max(1);
    let end = (line_end + 2).min(lines.len());
    let snippet = lines
        .iter()
        .enumerate()
        .filter(|(index, _)| {
            let line_no = index + 1;
            line_no >= start && line_no <= end
        })
        .map(|(index, line)| format!("{:>4} | {}", index + 1, line))
        .collect::<Vec<_>>()
        .join("\n");
    Some(snippet)
}

fn write_report(
    workspace: &ProjectWorkspace,
    markdown: &str,
    override_path: Option<PathBuf>,
) -> io::Result<PathBuf> {
    let path = override_path.unwrap_or_else(|| {
        workspace
            .project_dir()
            .join("reports")
            .join(format!("adversarial-{}.md", timestamp_slug()))
    });
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, markdown)?;
    Ok(path)
}

pub fn open_popout_shell(
    cwd: &Path,
    model: &str,
    scope: ReviewScope,
    coach: bool,
    apply: bool,
    focus: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(target_os = "macos")]
    {
        let command = build_popout_command(
            &cwd.display().to_string(),
            model,
            scope,
            coach,
            apply,
            focus,
        );
        let script = format!(
            "tell application \"Terminal\" to do script \"{}\"",
            escape_applescript_string(&command)
        );
        let status = Command::new("osascript").arg("-e").arg(script).status()?;
        if !status.success() {
            return Err(io::Error::other("failed to open Terminal popout").into());
        }
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err(io::Error::other("popout is currently supported on macOS only").into())
}

fn ensure_git_repository(cwd: &Path) -> io::Result<()> {
    if is_git_repository(cwd) {
        Ok(())
    } else {
        Err(io::Error::other(
            "adversarial review requires a git repository",
        ))
    }
}

fn is_git_repository(cwd: &Path) -> bool {
    let status = Command::new("git")
        .arg("rev-parse")
        .arg("--show-toplevel")
        .current_dir(cwd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    status.map(|value| value.success()).unwrap_or(false)
}

fn run_git<I, S>(cwd: &Path, args: I) -> io::Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let output = Command::new("git").args(args).current_dir(cwd).output()?;
    if !output.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn review_schema_json() -> &'static str {
    r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "summary", "findings", "next_steps"],
  "properties": {
    "verdict": { "type": "string", "enum": ["approve", "needs-attention"] },
    "summary": { "type": "string", "minLength": 1 },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "title", "body", "file", "line_start", "line_end", "confidence", "recommendation", "teaching_note", "patch_plan"],
        "properties": {
          "severity": { "type": "string", "enum": ["critical", "high", "medium", "low"] },
          "title": { "type": "string", "minLength": 1 },
          "body": { "type": "string", "minLength": 1 },
          "file": { "type": "string", "minLength": 1 },
          "line_start": { "type": "integer", "minimum": 1 },
          "line_end": { "type": "integer", "minimum": 1 },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "recommendation": { "type": "string", "minLength": 1 },
          "teaching_note": { "type": ["string", "null"] },
          "patch_plan": { "type": ["string", "null"] }
        }
      }
    },
    "next_steps": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 }
    }
  }
}"#
}

fn temp_file_path(prefix: &str, extension: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!("{prefix}-{stamp}.{extension}"))
}

fn timestamp_slug() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn write_status(path: &Option<PathBuf>, status: &str) {
    if let Some(path) = path {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, status);
    }
}

fn review_scope_label(scope: ReviewScope) -> &'static str {
    match scope {
        ReviewScope::Auto => "auto",
        ReviewScope::WorkingTree => "working-tree",
        ReviewScope::Staged => "staged",
        ReviewScope::AllFiles => "all-files",
        ReviewScope::Branch => "branch",
    }
}

fn maybe_capture_stream_event(
    line: &str,
    events_file_path: Option<&PathBuf>,
    review_from_stream: &mut Option<AdversarialReport>,
    coach: bool,
) -> io::Result<()> {
    if !line.trim_start().starts_with('{') {
        return Ok(());
    }

    let value = match serde_json::from_str::<Value>(line) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };

    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(item) = value.get("item") else {
        return Ok(());
    };
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();

    match (event_type, item_type) {
        ("item.started", "command_execution") => {
            append_event_row(
                events_file_path,
                &TranscriptRow {
                    kind: RowKind::Tool,
                    text: "Inspecting code".to_string(),
                    detail: item
                        .get("command")
                        .and_then(Value::as_str)
                        .map(summarize_command),
                },
            )?;
        }
        ("item.completed", "agent_message") => {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                if let Ok(report) = serde_json::from_str::<AdversarialReport>(text) {
                    let rows = parse_report_into_rows(&report, coach);
                    for row in rows {
                        append_event_row(events_file_path, &row)?;
                    }
                    *review_from_stream = Some(report);
                } else {
                    append_event_row(
                        events_file_path,
                        &TranscriptRow {
                            kind: RowKind::Assistant,
                            text: text.trim().to_string(),
                            detail: None,
                        },
                    )?;
                }
            }
        }
        _ => {}
    }

    Ok(())
}

fn parse_report_into_rows(report: &AdversarialReport, coach: bool) -> Vec<TranscriptRow> {
    let mut rows = vec![
        TranscriptRow {
            kind: RowKind::System,
            text: "Adversarial Review".to_string(),
            detail: None,
        },
        TranscriptRow {
            kind: RowKind::System,
            text: "Summary".to_string(),
            detail: Some(report.summary.clone()),
        },
    ];

    for finding in &report.findings {
        let mut detail = vec![
            format!(
                "Location: `{}`:{}-{}",
                finding.file, finding.line_start, finding.line_end
            ),
            format!("Confidence: {:.2}", finding.confidence),
            String::new(),
            finding.body.clone(),
            String::new(),
            format!("Recommendation: {}", finding.recommendation),
        ];
        if let Some(code) = &finding.code_snippet {
            detail.push(String::new());
            detail.push(code.clone());
        }
        if coach {
            if let Some(note) = &finding.teaching_note {
                detail.push(String::new());
                detail.push(format!("Coaching: {note}"));
            }
            if let Some(plan) = &finding.patch_plan {
                detail.push(String::new());
                detail.push(format!("Patch direction: {plan}"));
            }
        }
        rows.push(TranscriptRow {
            kind: RowKind::Tool,
            text: format!("[{}] {}", finding.severity.to_uppercase(), finding.title),
            detail: Some(detail.join("\n")),
        });
    }

    if !report.next_steps.is_empty() {
        rows.push(TranscriptRow {
            kind: RowKind::System,
            text: "Next Steps".to_string(),
            detail: Some(report.next_steps.join("\n")),
        });
    }

    rows
}

fn append_event_row(events_file_path: Option<&PathBuf>, row: &TranscriptRow) -> io::Result<()> {
    let Some(path) = events_file_path else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let json = serde_json::to_string(row).map_err(io::Error::other)?;
    writeln!(file, "{json}")?;
    Ok(())
}

fn summarize_command(command: &str) -> String {
    command
        .replace('\n', " ")
        .split_whitespace()
        .take(10)
        .collect::<Vec<_>>()
        .join(" ")
}

fn escape_single_quotes(input: &str) -> String {
    input.replace('\'', "'\"'\"'")
}

fn shell_escape_arg(input: &str) -> String {
    if input
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/'))
    {
        input.to_string()
    } else {
        format!("'{}'", escape_single_quotes(input))
    }
}

fn escape_applescript_string(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}
