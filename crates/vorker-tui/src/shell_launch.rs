use std::io;
use std::path::Path;

pub fn open_review_window(
    cwd: &Path,
    model: &str,
    scope: Option<String>,
    coach: bool,
    apply: bool,
    focus: &str,
) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let scope = scope.unwrap_or_else(|| "auto".to_string());
        let command = build_review_shell_command(cwd, model, &scope, coach, apply, focus);
        let script = format!(
            "tell application \"Terminal\" to do script \"{}\"",
            command.replace('\\', "\\\\").replace('"', "\\\"")
        );
        let status = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .status()?;
        if status.success() {
            return Ok(());
        }
        return Err(io::Error::other("failed to open review window"));
    }

    #[allow(unreachable_code)]
    Err(io::Error::other(
        "review popout is currently supported on macOS only",
    ))
}

pub fn open_ralph_window(
    cwd: &Path,
    task: &str,
    model: Option<&str>,
    no_deslop: bool,
    xhigh: bool,
) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let mut args = vec!["ralph".to_string()];
        if no_deslop {
            args.push("--no-deslop".to_string());
        }
        if xhigh {
            args.push("--xhigh".to_string());
        }
        if let Some(model) = model.filter(|model| !model.trim().is_empty()) {
            args.push("--model".to_string());
            args.push(shell_escape_arg(model));
        }
        args.push(shell_escape_arg(task));
        let command = format!(
            "cd '{}' && vorker {}",
            escape_single_quotes(&cwd.display().to_string()),
            args.join(" ")
        );
        let script = format!(
            "tell application \"Terminal\" to do script \"{}\"",
            command.replace('\\', "\\\\").replace('"', "\\\"")
        );
        let status = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .status()?;
        if status.success() {
            return Ok(());
        }
        return Err(io::Error::other("failed to open RALPH window"));
    }

    #[allow(unreachable_code)]
    Err(io::Error::other(
        "RALPH popout is currently supported on macOS only",
    ))
}

fn escape_single_quotes(input: &str) -> String {
    input.replace('\'', "'\"'\"'")
}

fn build_review_shell_command(
    cwd: &Path,
    model: &str,
    scope: &str,
    coach: bool,
    apply: bool,
    focus: &str,
) -> String {
    format!(
        "cd '{}' && VORKER_THEME=review VORKER_REVIEW_MODE=1 VORKER_REVIEW_AUTO=1 VORKER_REVIEW_SCOPE={} VORKER_REVIEW_COACH={} VORKER_REVIEW_APPLY={} VORKER_REVIEW_FOCUS={} vorker --model {}",
        escape_single_quotes(&cwd.display().to_string()),
        shell_escape_arg(scope),
        if coach { "1" } else { "0" },
        if apply { "1" } else { "0" },
        shell_escape_arg(focus),
        shell_escape_arg(model),
    )
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

#[cfg(test)]
mod tests {
    use super::build_review_shell_command;
    use std::path::Path;

    #[test]
    fn review_shell_command_escapes_scope_values_before_exporting_them() {
        let command = build_review_shell_command(
            Path::new("/workspace"),
            "gpt-5.4",
            "staged'; touch /tmp/pwned #",
            false,
            false,
            "focus",
        );

        assert!(
            command.contains("VORKER_REVIEW_SCOPE='staged'\"'\"'; touch /tmp/pwned #'"),
            "scope should be shell-escaped before interpolation:\n{command}"
        );
    }
}
