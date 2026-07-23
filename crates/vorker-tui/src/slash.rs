#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlashCommandId {
    Review,
    Ralph,
    Stop,
    Steer,
    Queue,
    Agent,
    Agents,
    AgentStop,
    AgentResult,
    AgentLog,
    AgentResume,
    Theme,
    Export,
    Copy,
    Diff,
    Compact,
    Timeline,
    Status,
    History,
    Skills,
    Coach,
    Apply,
    ExitReview,
    Model,
    New,
    Help,
    Permissions,
    Rename,
    List,
    Cd,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlashCommandCategory {
    Session,
    Review,
    Agent,
    Workflow,
    Config,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlashCommandVisibility {
    pub visible_in_review_mode: bool,
    pub visible_in_normal_mode: bool,
    pub allow_while_busy: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlashCommandAvailability {
    Always,
    TranscriptRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlashCommand {
    pub id: SlashCommandId,
    pub name: &'static str,
    pub description: &'static str,
    pub aliases: &'static [&'static str],
    pub category: SlashCommandCategory,
    pub visibility: SlashCommandVisibility,
    pub availability: SlashCommandAvailability,
}

#[must_use]
pub fn category_label(category: SlashCommandCategory) -> &'static str {
    match category {
        SlashCommandCategory::Session => "Session",
        SlashCommandCategory::Review => "Review",
        SlashCommandCategory::Agent => "Agent",
        SlashCommandCategory::Workflow => "Workflow",
        SlashCommandCategory::Config => "Config",
    }
}

#[must_use]
pub fn command_is_available(command: SlashCommand, transcript_available: bool) -> bool {
    match command.availability {
        SlashCommandAvailability::Always => true,
        SlashCommandAvailability::TranscriptRequired => transcript_available,
    }
}

#[must_use]
pub fn command_is_enabled_in_state(
    command: SlashCommand,
    review_mode: bool,
    busy: bool,
    transcript_available: bool,
) -> bool {
    let visible = if review_mode {
        command.visibility.visible_in_review_mode
    } else {
        command.visibility.visible_in_normal_mode
    };
    visible
        && (!busy || command.visibility.allow_while_busy)
        && command_is_available(command, transcript_available)
}

const NORMAL_ONLY: SlashCommandVisibility = SlashCommandVisibility {
    visible_in_review_mode: false,
    visible_in_normal_mode: true,
    allow_while_busy: false,
};

const NORMAL_BUSY: SlashCommandVisibility = SlashCommandVisibility {
    visible_in_review_mode: false,
    visible_in_normal_mode: true,
    allow_while_busy: true,
};

const REVIEW_ONLY: SlashCommandVisibility = SlashCommandVisibility {
    visible_in_review_mode: true,
    visible_in_normal_mode: false,
    allow_while_busy: true,
};

const SHARED: SlashCommandVisibility = SlashCommandVisibility {
    visible_in_review_mode: true,
    visible_in_normal_mode: true,
    allow_while_busy: true,
};

pub const SLASH_COMMANDS: [SlashCommand; 30] = [
    SlashCommand {
        id: SlashCommandId::Review,
        name: "/review",
        description: "run adversarial review in this shell; --coach teaches, --apply patches, --staged reviews staged files",
        aliases: &[],
        category: SlashCommandCategory::Review,
        visibility: NORMAL_ONLY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Ralph,
        name: "/ralph",
        description: "launch a RALPH persistence session",
        aliases: &[],
        category: SlashCommandCategory::Workflow,
        visibility: NORMAL_ONLY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Stop,
        name: "/stop",
        description: "stop the active prompt or review job",
        aliases: &["/clean"],
        category: SlashCommandCategory::Workflow,
        visibility: SHARED,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Steer,
        name: "/steer",
        description: "send steering guidance to the active agent",
        aliases: &[],
        category: SlashCommandCategory::Workflow,
        visibility: NORMAL_BUSY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Queue,
        name: "/queue",
        description: "queue a prompt, or use /queue list, /queue pop, and /queue clear",
        aliases: &[],
        category: SlashCommandCategory::Workflow,
        visibility: NORMAL_BUSY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Agent,
        name: "/agent",
        description: "spawn one or more Codex-backed side agents; use --count <n> to fan out",
        aliases: &[],
        category: SlashCommandCategory::Agent,
        visibility: NORMAL_ONLY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Agents,
        name: "/agents",
        description: "list Codex side agents",
        aliases: &[],
        category: SlashCommandCategory::Agent,
        visibility: NORMAL_BUSY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::AgentStop,
        name: "/agent-stop",
        description: "stop a running Codex side agent",
        aliases: &[],
        category: SlashCommandCategory::Agent,
        visibility: NORMAL_BUSY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::AgentResult,
        name: "/agent-result",
        description: "show side agent result",
        aliases: &[],
        category: SlashCommandCategory::Agent,
        visibility: NORMAL_BUSY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::AgentLog,
        name: "/agent-log",
        description: "show a side agent event and stderr log",
        aliases: &[],
        category: SlashCommandCategory::Agent,
        visibility: NORMAL_BUSY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::AgentResume,
        name: "/agent-resume",
        description: "rerun a stored side agent task from its saved prompt",
        aliases: &[],
        category: SlashCommandCategory::Agent,
        visibility: NORMAL_BUSY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Theme,
        name: "/theme",
        description: "change shell theme",
        aliases: &[],
        category: SlashCommandCategory::Config,
        visibility: NORMAL_ONLY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Export,
        name: "/export",
        description: "export the current transcript to markdown",
        aliases: &[],
        category: SlashCommandCategory::Session,
        visibility: NORMAL_BUSY,
        availability: SlashCommandAvailability::TranscriptRequired,
    },
    SlashCommand {
        id: SlashCommandId::Copy,
        name: "/copy",
        description: "copy the current transcript to the clipboard",
        aliases: &[],
        category: SlashCommandCategory::Session,
        visibility: NORMAL_BUSY,
        availability: SlashCommandAvailability::TranscriptRequired,
    },
    SlashCommand {
        id: SlashCommandId::Diff,
        name: "/diff",
        description: "show the current working tree diff",
        aliases: &[],
        category: SlashCommandCategory::Session,
        visibility: NORMAL_BUSY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Compact,
        name: "/compact",
        description: "compact the current transcript into a short summary",
        aliases: &[],
        category: SlashCommandCategory::Session,
        visibility: NORMAL_ONLY,
        availability: SlashCommandAvailability::TranscriptRequired,
    },
    SlashCommand {
        id: SlashCommandId::Timeline,
        name: "/timeline",
        description: "show a compact timeline of the current thread",
        aliases: &[],
        category: SlashCommandCategory::Session,
        visibility: NORMAL_BUSY,
        availability: SlashCommandAvailability::TranscriptRequired,
    },
    SlashCommand {
        id: SlashCommandId::Status,
        name: "/status",
        description: "show session, workspace, and agent status",
        aliases: &[],
        category: SlashCommandCategory::Session,
        visibility: NORMAL_BUSY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::History,
        name: "/history",
        description: "show recent prompt history",
        aliases: &[],
        category: SlashCommandCategory::Session,
        visibility: NORMAL_BUSY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Skills,
        name: "/skills",
        description: "list, enable, or disable agent skills",
        aliases: &["/$"],
        category: SlashCommandCategory::Config,
        visibility: NORMAL_ONLY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Coach,
        name: "/coach",
        description: "rerun review with teaching guidance",
        aliases: &[],
        category: SlashCommandCategory::Review,
        visibility: REVIEW_ONLY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Apply,
        name: "/apply",
        description: "rerun review and apply the smallest safe patch",
        aliases: &[],
        category: SlashCommandCategory::Review,
        visibility: REVIEW_ONLY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::ExitReview,
        name: "/exit-review",
        description: "leave the review window",
        aliases: &[],
        category: SlashCommandCategory::Review,
        visibility: REVIEW_ONLY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Model,
        name: "/model",
        description: "choose what model to use",
        aliases: &[],
        category: SlashCommandCategory::Config,
        visibility: SHARED,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::New,
        name: "/new",
        description: "start a fresh chat",
        aliases: &[],
        category: SlashCommandCategory::Session,
        visibility: NORMAL_ONLY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Help,
        name: "/help",
        description: "show the available shell commands",
        aliases: &["/?"],
        category: SlashCommandCategory::Session,
        visibility: SHARED,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Permissions,
        name: "/permissions",
        description: "toggle manual vs auto approvals",
        aliases: &["/approvals"],
        category: SlashCommandCategory::Config,
        visibility: NORMAL_ONLY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Rename,
        name: "/rename",
        description: "rename the current thread",
        aliases: &[],
        category: SlashCommandCategory::Session,
        visibility: NORMAL_ONLY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::List,
        name: "/list",
        description: "list or reopen saved threads",
        aliases: &[],
        category: SlashCommandCategory::Session,
        visibility: NORMAL_ONLY,
        availability: SlashCommandAvailability::Always,
    },
    SlashCommand {
        id: SlashCommandId::Cd,
        name: "/cd",
        description: "change the project directory",
        aliases: &[],
        category: SlashCommandCategory::Session,
        visibility: NORMAL_ONLY,
        availability: SlashCommandAvailability::Always,
    },
];

impl SlashCommand {
    #[must_use]
    pub fn matches_exact(self, candidate: &str) -> bool {
        self.name == candidate || self.aliases.contains(&candidate)
    }

    #[must_use]
    pub fn matches_prefix(self, query: &str) -> bool {
        let query = query.to_ascii_lowercase();
        self.name
            .trim_start_matches('/')
            .to_ascii_lowercase()
            .starts_with(&query)
            || self.aliases.iter().any(|alias| {
                alias
                    .trim_start_matches('/')
                    .to_ascii_lowercase()
                    .starts_with(&query)
            })
    }
}

#[must_use]
pub fn is_slash_mode(buffer: &str) -> bool {
    buffer.starts_with('/')
}

#[must_use]
pub fn filtered_commands(buffer: &str, review_mode: bool) -> Vec<SlashCommand> {
    filtered_commands_for_state(buffer, review_mode, false, true)
}

#[must_use]
pub fn filtered_commands_for_state(
    buffer: &str,
    review_mode: bool,
    busy: bool,
    transcript_available: bool,
) -> Vec<SlashCommand> {
    if !is_slash_mode(buffer) {
        return Vec::new();
    }

    let query = buffer
        .trim_start_matches('/')
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();

    let commands = SLASH_COMMANDS
        .into_iter()
        .filter(|command| {
            if review_mode {
                command.visibility.visible_in_review_mode
            } else {
                command.visibility.visible_in_normal_mode
            }
        })
        .filter(|command| !busy || command.visibility.allow_while_busy)
        .filter(|command| match command.availability {
            SlashCommandAvailability::Always => true,
            SlashCommandAvailability::TranscriptRequired => transcript_available,
        })
        .collect::<Vec<_>>();

    if query.is_empty() {
        return commands;
    }

    commands
        .iter()
        .copied()
        .filter(|command| command.matches_prefix(&query))
        .collect()
}

#[must_use]
pub fn help_summary(review_mode: bool, busy: bool) -> String {
    help_summary_for_state(review_mode, busy, true)
}

#[must_use]
pub fn help_summary_for_state(review_mode: bool, busy: bool, transcript_available: bool) -> String {
    let commands = SLASH_COMMANDS
        .into_iter()
        .filter(|command| {
            if review_mode {
                command.visibility.visible_in_review_mode
            } else {
                command.visibility.visible_in_normal_mode
            }
        })
        .filter(|command| !busy || command.visibility.allow_while_busy)
        .filter(|command| match command.availability {
            SlashCommandAvailability::Always => true,
            SlashCommandAvailability::TranscriptRequired => transcript_available,
        })
        .collect::<Vec<_>>();
    let mut lines = vec!["Commands:".to_string()];
    let categories = [
        SlashCommandCategory::Workflow,
        SlashCommandCategory::Agent,
        SlashCommandCategory::Session,
        SlashCommandCategory::Config,
        SlashCommandCategory::Review,
    ];
    for category in categories {
        let names = commands
            .iter()
            .filter(|command| command.category == category)
            .map(|command| command.name)
            .collect::<Vec<_>>();
        if !names.is_empty() {
            lines.push(format!("{}: {}", category_label(category), names.join(" ")));
        }
    }
    lines.join("\n")
}
