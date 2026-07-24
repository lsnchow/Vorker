use clap::{Args, CommandFactory, Parser, Subcommand};
use std::env;
use std::io::{self, Read};
use vorker_agent::{PromptRequest, ProviderId, ProviderManager};
use vorker_cli::adversarial::{
    AdversarialRunRequest, DEFAULT_ADVERSARIAL_MODEL, ReviewScope, run_adversarial,
};
use vorker_cli::ralph::{RalphLaunchRequest, build_ralph_launch, run_ralph_launch};
use vorker_core::EventLog;
use vorker_preflight::{LocalContainerSandbox, PreflightRequest, PreflightRunner};
use vorker_tui::{RuntimeOptions, render_hyperloop_mock, render_once, run_app};

const DEFAULT_PRIMARY_MODEL: &str = "claude-opus-4.5";

#[derive(Debug, Parser)]
#[command(
    name = "vorker",
    about = "Rust-native Vorker runtime; use the Node wrapper for serve/share",
    disable_help_subcommand = true
)]
struct Cli {
    #[command(flatten)]
    shared: SharedOptions,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Args, Default)]
struct SharedOptions {
    #[arg(long)]
    cwd: Option<String>,
    #[arg(long)]
    provider: Option<String>,
    #[arg(long = "copilot-bin")]
    copilot_bin: Option<String>,
    #[arg(long = "codex-bin")]
    codex_bin: Option<String>,
    #[arg(long)]
    mode: Option<String>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long = "auto-approve", default_value_t = false)]
    auto_approve: bool,
    #[arg(long, default_value_t = false)]
    debug: bool,
    #[arg(long = "no-alt-screen", default_value_t = false)]
    no_alt_screen: bool,
    #[arg(long = "alt-screen", default_value_t = false)]
    alt_screen: bool,
}

#[derive(Debug, Subcommand)]
enum Command {
    Tui(TuiOptions),
    Adversarial(AdversarialOptions),
    Ralph(RalphOptions),
    Demo { scenario: String },
    Preflight { repo: String },
    Chat { prompt: Option<String> },
    Help,
}

#[derive(Debug, Args, Default)]
struct TuiOptions {
    #[arg(long, default_value_t = false)]
    once: bool,
}

#[derive(Debug, Args, Default)]
struct AdversarialOptions {
    #[arg(long)]
    base: Option<String>,
    #[arg(long, default_value = "auto")]
    scope: String,
    #[arg(long, default_value_t = false)]
    coach: bool,
    #[arg(long, default_value_t = false)]
    apply: bool,
    #[arg(long, default_value_t = false)]
    popout: bool,
    #[arg(long, hide = true)]
    output_report: Option<String>,
    #[arg(long, hide = true)]
    events_file: Option<String>,
    #[arg(long, hide = true)]
    status_file: Option<String>,
    #[arg(trailing_var_arg = true)]
    focus: Vec<String>,
}

#[derive(Debug, Args, Default)]
struct RalphOptions {
    #[arg(long)]
    model: Option<String>,
    #[arg(long = "no-deslop", default_value_t = false)]
    no_deslop: bool,
    #[arg(long, default_value_t = false)]
    xhigh: bool,
    #[arg(long = "alt-screen", default_value_t = false)]
    alt_screen: bool,
    #[arg(long = "dry-run", default_value_t = false)]
    dry_run: bool,
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    task: Vec<String>,
}

fn main() {
    let cli = Cli::parse();
    if let Some(cwd) = &cli.shared.cwd
        && let Err(error) = env::set_current_dir(cwd)
    {
        eprintln!("failed to change directory to {cwd}: {error}");
        std::process::exit(1);
    }

    match cli.command {
        Some(Command::Tui(tui)) => {
            let runtime_options = cli.shared.runtime_options();
            configure_tui_environment(&cli.shared);
            if tui.once {
                println!(
                    "{}",
                    render_once(120, runtime_options.default_model.clone())
                );
            } else if let Err(error) = run_app(
                cli.shared.inline_terminal(),
                cli.shared.auto_approve,
                runtime_options,
            ) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        Some(Command::Adversarial(options)) => {
            if let Err(error) = run_adversarial_command(options, &cli.shared) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        Some(Command::Ralph(options)) => {
            if let Err(error) = run_ralph_command(options, &cli.shared) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        Some(Command::Demo { scenario }) => match scenario.as_str() {
            "hyperloop" | "hyperloop-controls" => {
                println!("{}", render_hyperloop_mock(120, false));
            }
            _ => {
                eprintln!("unknown demo scenario: {scenario}");
                std::process::exit(1);
            }
        },
        Some(Command::Preflight { repo }) => {
            if let Err(error) = run_preflight(repo, cli.shared.auto_approve) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        Some(Command::Chat { prompt }) => {
            if let Err(error) = run_chat(prompt, &cli.shared) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        Some(Command::Help) => {
            let _ = Cli::command().print_help();
            println!();
        }
        None => {
            let runtime_options = cli.shared.runtime_options();
            configure_tui_environment(&cli.shared);
            if let Err(error) = run_app(
                cli.shared.inline_terminal(),
                cli.shared.auto_approve,
                runtime_options,
            ) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
}

impl SharedOptions {
    fn inline_terminal(&self) -> bool {
        self.no_alt_screen || !self.alt_screen
    }

    fn runtime_options(&self) -> RuntimeOptions {
        RuntimeOptions {
            copilot_bin: self.copilot_bin.clone(),
            default_model: Some(default_primary_model(self)),
        }
    }
}

fn configure_tui_environment(shared: &SharedOptions) {
    if let Some(codex_bin) = &shared.codex_bin {
        unsafe {
            env::set_var("CODEX_BIN", codex_bin);
        }
    }
}

fn run_ralph_command(
    options: RalphOptions,
    shared: &SharedOptions,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let task = resolve_prompt(Some(options.task.join(" ")))?;
    let home = env::var_os("HOME")
        .map(Into::into)
        .ok_or_else(|| io::Error::other("HOME is not set; cannot locate Codex auth"))?;
    let launch = build_ralph_launch(RalphLaunchRequest {
        cwd: env::current_dir()?,
        user_home: home,
        task,
        model: options.model.or_else(|| shared.model.clone()),
        no_deslop: options.no_deslop,
        no_alt_screen: !options.alt_screen,
        xhigh: options.xhigh,
        extra_args: Vec::new(),
    })?;

    if options.dry_run {
        for (key, value) in &launch.env {
            println!("{key}={value}");
        }
        println!("{} {}", launch.program, launch.args.join(" "));
        return Ok(());
    }

    let status = run_ralph_launch(&launch)?;
    if !status.success() {
        return Err(io::Error::other(format!("ralph exited with status {status}")).into());
    }
    Ok(())
}

fn run_adversarial_command(
    options: AdversarialOptions,
    shared: &SharedOptions,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cwd = env::current_dir()?;
    let model = shared
        .model
        .clone()
        .unwrap_or_else(|| DEFAULT_ADVERSARIAL_MODEL.to_string());
    let focus = options.focus.join(" ").trim().to_string();
    let result = run_adversarial(&AdversarialRunRequest {
        cwd,
        base: options.base,
        scope: parse_review_scope(&options.scope)?,
        focus,
        coach: options.coach || options.apply,
        apply: options.apply,
        popout: options.popout,
        model,
        output_report_path: options.output_report.map(Into::into),
        events_file_path: options.events_file.map(Into::into),
        status_file_path: options.status_file.map(Into::into),
    })?;

    println!("{}", result.report_markdown);
    println!("\nReport saved to {}", result.report_path.display());
    if let Some(summary) = result.apply_summary {
        println!("\n## Applied Patch Summary\n{summary}");
    }
    Ok(())
}

fn run_preflight(
    repo: String,
    auto_approve: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let runner = PreflightRunner::new(LocalContainerSandbox::detect());
    let result = runner.run(PreflightRequest::new(repo).approve_high_risk(auto_approve))?;

    let logs_root = env::current_dir()?.join(".vorker-2").join("logs");
    let event_log = EventLog::new(&logs_root, Some(logs_root.join("supervisor.ndjson")));
    for event in &result.events {
        event_log.append(event)?;
    }

    println!("preflight {}", result.report.run_id);
    println!("outcome   {}", result.report.outcome);
    println!("class     {}", result.report.repo_class);
    println!("risk      {}", result.report.risk.level);
    println!("stage     {}", result.report.stage);
    if let Some(failure) = &result.report.latest_failure {
        println!("failure   {failure}");
    }
    println!("summary   {}", result.report.summary_path);
    println!("report    {}", result.report.report_path);
    println!("artifacts {}", result.artifacts_dir.display());
    if result.report.risk.level == "high" && !auto_approve {
        println!(
            "hint      rerun with --auto-approve to allow sandbox execution for a high-risk repo"
        );
    }
    Ok(())
}

fn run_chat(
    prompt: Option<String>,
    shared: &SharedOptions,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let provider = shared
        .provider
        .as_deref()
        .unwrap_or("copilot")
        .parse::<ProviderId>()
        .map_err(io::Error::other)?;
    let prompt = resolve_prompt(prompt)?;
    let request = PromptRequest {
        prompt,
        cwd: Some(env::current_dir()?),
        model: Some(default_primary_model(shared)),
    };
    let mut spec = ProviderManager::build_prompt_command(provider, &request);
    match provider {
        ProviderId::Copilot => {
            if let Some(bin) = &shared.copilot_bin {
                spec.program = bin.clone();
            }
        }
        ProviderId::Codex => {
            if let Some(bin) = &shared.codex_bin {
                spec.program = bin.clone();
            }
        }
    }

    let output = spec.command().output()?;
    if !output.stdout.is_empty() {
        print!("{}", String::from_utf8_lossy(&output.stdout));
    }
    if !output.stderr.is_empty() {
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
    }
    if !output.status.success() {
        return Err(
            io::Error::other(format!("{} exited with status {}", provider, output.status)).into(),
        );
    }

    Ok(())
}

fn default_primary_model(shared: &SharedOptions) -> String {
    shared
        .model
        .clone()
        .or_else(|| env::var("VORKER_DEFAULT_MODEL").ok())
        .unwrap_or_else(|| DEFAULT_PRIMARY_MODEL.to_string())
}

fn parse_review_scope(
    value: &str,
) -> Result<ReviewScope, Box<dyn std::error::Error + Send + Sync>> {
    match value.trim().to_ascii_lowercase().as_str() {
        "auto" => Ok(ReviewScope::Auto),
        "working-tree" | "working_tree" => Ok(ReviewScope::WorkingTree),
        "staged" => Ok(ReviewScope::Staged),
        "all-files" | "all_files" => Ok(ReviewScope::AllFiles),
        "branch" => Ok(ReviewScope::Branch),
        other => Err(io::Error::other(format!("unknown review scope: {other}")).into()),
    }
}

fn resolve_prompt(
    prompt: Option<String>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
        return Ok(prompt);
    }

    let mut stdin = String::new();
    io::stdin().read_to_string(&mut stdin)?;
    if stdin.trim().is_empty() {
        return Err(io::Error::other("chat requires a prompt").into());
    }
    Ok(stdin)
}

#[cfg(test)]
mod tests {
    use super::{Cli, CommandFactory, SharedOptions};
    use clap::Parser;

    #[test]
    fn rust_cli_help_omits_unimplemented_stub_commands() {
        let mut command = Cli::command();
        let mut help = Vec::new();
        command.write_long_help(&mut help).expect("help");
        let help = String::from_utf8(help).expect("utf8");

        assert!(help.contains("tui"));
        assert!(help.contains("chat"));
        assert!(!help.contains("\n  repl"));
        assert!(!help.contains("\n  serve"));
        assert!(!help.contains("\n  share"));
    }

    #[test]
    fn rust_cli_rejects_removed_stub_subcommands() {
        assert!(Cli::try_parse_from(["vorker", "serve"]).is_err());
        assert!(Cli::try_parse_from(["vorker", "share"]).is_err());
        assert!(Cli::try_parse_from(["vorker", "repl"]).is_err());
    }

    #[test]
    fn runtime_options_preserve_configured_tui_binaries() {
        let shared = SharedOptions {
            copilot_bin: Some("/tmp/copilot-custom".to_string()),
            codex_bin: Some("/tmp/codex-custom".to_string()),
            model: Some("gpt-test".to_string()),
            ..SharedOptions::default()
        };

        let runtime_options = shared.runtime_options();

        assert_eq!(
            runtime_options.copilot_bin.as_deref(),
            Some("/tmp/copilot-custom")
        );
        assert_eq!(runtime_options.default_model.as_deref(), Some("gpt-test"));
        assert_eq!(shared.codex_bin.as_deref(), Some("/tmp/codex-custom"));
    }
}
