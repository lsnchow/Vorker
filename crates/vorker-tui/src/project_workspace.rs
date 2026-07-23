use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::session_event_store::apply_events_to_thread;
use crate::theme::{fit, truncate, visible_length};
use crate::{
    PromptHistoryStore, SessionEventStore, SideAgentStore, SkillStore, StoredThread, ThreadStore,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ProjectWorkspaceMeta {
    cwd: String,
    project_key: String,
    confirmed: bool,
    created_at_epoch_seconds: u64,
    last_opened_at_epoch_seconds: u64,
}

pub struct ProjectWorkspace {
    root: PathBuf,
    cwd: PathBuf,
    project_dir: PathBuf,
    meta: ProjectWorkspaceMeta,
}

impl ProjectWorkspace {
    pub fn for_cwd(cwd: &Path) -> io::Result<Self> {
        Self::at_root(default_root_path(), cwd)
    }

    pub fn at_root(root: PathBuf, cwd: &Path) -> io::Result<Self> {
        let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
        let cwd_label = cwd.display().to_string();
        let project_key = project_key_for(&cwd);
        let project_dir = root.join("projects").join(&project_key);
        let meta_path = project_dir.join("meta.json");
        let meta = if meta_path.exists() {
            let raw = fs::read_to_string(&meta_path)?;
            serde_json::from_str::<ProjectWorkspaceMeta>(&raw)
                .map_err(|error| invalid_data_error(&meta_path, error))?
        } else {
            ProjectWorkspaceMeta {
                cwd: cwd_label.clone(),
                project_key: project_key.clone(),
                confirmed: false,
                created_at_epoch_seconds: now_epoch_seconds(),
                last_opened_at_epoch_seconds: now_epoch_seconds(),
            }
        };

        Ok(Self {
            root,
            cwd,
            project_dir,
            meta,
        })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    #[must_use]
    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    #[must_use]
    pub fn project_dir(&self) -> PathBuf {
        self.project_dir.clone()
    }

    #[must_use]
    pub fn threads_path(&self) -> PathBuf {
        self.project_dir.join("threads.json")
    }

    #[must_use]
    pub fn side_agents_path(&self) -> PathBuf {
        self.project_dir.join("side-agents.json")
    }

    #[must_use]
    pub fn prompt_history_path(&self) -> PathBuf {
        self.project_dir.join("prompt-history.jsonl")
    }

    #[must_use]
    pub fn skills_path(&self) -> PathBuf {
        self.project_dir.join("skills.json")
    }

    #[must_use]
    pub fn events_dir(&self) -> PathBuf {
        self.project_dir.join("events")
    }

    #[must_use]
    pub fn side_agents_dir(&self) -> PathBuf {
        self.project_dir.join("side-agents")
    }

    #[must_use]
    pub fn meta_path(&self) -> PathBuf {
        self.project_dir.join("meta.json")
    }

    #[must_use]
    pub fn is_confirmed(&self) -> bool {
        self.meta.confirmed
    }

    pub fn confirm(&self) -> io::Result<()> {
        fs::create_dir_all(&self.project_dir)?;
        let mut meta = self.meta.clone();
        meta.confirmed = true;
        meta.last_opened_at_epoch_seconds = now_epoch_seconds();
        let data = serde_json::to_string_pretty(&meta).map_err(io::Error::other)?;
        fs::write(self.meta_path(), data)
    }

    pub fn open_thread_store(&self) -> io::Result<ThreadStore> {
        ThreadStore::open_at(self.threads_path())
    }

    pub fn open_side_agent_store(&self) -> io::Result<SideAgentStore> {
        SideAgentStore::open_at(self.side_agents_path())
    }

    pub fn open_prompt_history_store(&self) -> io::Result<PromptHistoryStore> {
        PromptHistoryStore::open_at(self.prompt_history_path())
    }

    pub fn open_skill_store(&self) -> io::Result<SkillStore> {
        SkillStore::open_at(self.skills_path())
    }

    pub fn open_session_event_store(&self) -> io::Result<SessionEventStore> {
        SessionEventStore::open_at(self.events_dir())
    }

    pub fn list_all_threads_under(root: PathBuf) -> io::Result<Vec<StoredThread>> {
        let projects_root = root.join("projects");
        let mut threads = Vec::new();
        let entries = match fs::read_dir(&projects_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };

        for entry in entries.flatten() {
            let project_dir = entry.path();
            let path = project_dir.join("threads.json");
            if !path.exists() {
                continue;
            }
            let store = ThreadStore::open_at(path)?;
            let event_store = SessionEventStore::open_at(project_dir.join("events"))?;
            threads.extend(store.list_threads().into_iter().map(|thread| {
                let events = event_store.events(&thread.id).unwrap_or_default();
                if events.is_empty() {
                    thread
                } else {
                    apply_events_to_thread(&thread, &events)
                }
            }));
        }

        threads.sort_by(|left, right| {
            right
                .updated_at_epoch_seconds
                .cmp(&left.updated_at_epoch_seconds)
                .then_with(|| left.name.cmp(&right.name))
        });
        Ok(threads)
    }

    pub fn find_thread_under(root: PathBuf, thread_id: &str) -> io::Result<Option<StoredThread>> {
        Ok(Self::list_all_threads_under(root)?
            .into_iter()
            .find(|thread| thread.id == thread_id))
    }
}

fn invalid_data_error(path: &Path, error: serde_json::Error) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("failed to parse {}: {error}", path.display()),
    )
}

#[must_use]
pub fn render_project_confirmation(
    width: usize,
    cwd: &str,
    workspace_path: &str,
    _color: bool,
) -> String {
    let body = [
        " Use Vorker in this directory?".to_string(),
        " ".to_string(),
        format!(" directory: {cwd}"),
        format!(" workspace: {workspace_path}"),
        " Enter to continue · Esc to cancel".to_string(),
    ];
    let inner_width = body
        .iter()
        .map(|line| visible_length(line))
        .max()
        .unwrap_or(0)
        .saturating_add(2)
        .min(width.clamp(70, 140).saturating_sub(2).max(20));
    let horizontal = "─".repeat(inner_width);
    let mut lines = vec![format!("╭{horizontal}╮")];
    for line in body {
        let content = fit(&truncate(&line, inner_width), inner_width);
        lines.push(format!("│{content}│"));
    }
    lines.push(format!("╰{horizontal}╯"));
    lines.join("\n")
}

fn default_root_path() -> PathBuf {
    if let Some(path) = std::env::var_os("VORKER_HOME") {
        return PathBuf::from(path);
    }

    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".vorker")
}

fn project_key_for(cwd: &Path) -> String {
    let name = cwd
        .file_name()
        .and_then(|value| value.to_str())
        .map(slugify)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "project".to_string());
    let mut hasher = DefaultHasher::new();
    cwd.display().to_string().hash(&mut hasher);
    format!("{name}-{:016x}", hasher.finish())
}

fn slugify(input: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;
    for ch in input.chars() {
        let mapped = if ch.is_ascii_alphanumeric() {
            previous_dash = false;
            ch.to_ascii_lowercase()
        } else if !previous_dash {
            previous_dash = true;
            '-'
        } else {
            continue;
        };
        slug.push(mapped);
    }
    slug.trim_matches('-').to_string()
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
