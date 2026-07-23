use std::fs;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComposerMentionBinding {
    pub token: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MentionContext {
    pub sections: Vec<String>,
    pub errors: Vec<String>,
}

#[must_use]
pub fn extract_active_mention_query(buffer: &str) -> Option<String> {
    let trimmed = buffer.trim_end_matches(char::is_whitespace);
    let at_index = trimmed.rfind('@')?;
    let prefix = &trimmed[..at_index];
    if prefix.chars().last().is_some_and(|ch| !ch.is_whitespace()) {
        return None;
    }

    let query = &trimmed[at_index + 1..];
    if query.chars().any(char::is_whitespace) {
        return None;
    }

    Some(query.to_string())
}

#[must_use]
pub fn filter_mention_items(query: &str, paths: &[String]) -> Vec<String> {
    let query = mention_query_parts(query).0.to_ascii_lowercase();
    let mut scored: Vec<(usize, usize, String)> = paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            let lower = path.to_ascii_lowercase();
            let basename = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
            let score = if query.is_empty() || basename.starts_with(&query) {
                0
            } else if lower.contains(&query) {
                1
            } else {
                2
            };
            (score, index, path.clone())
        })
        .collect();

    scored.sort();
    scored
        .into_iter()
        .map(|(_, _, path)| path)
        .take(8)
        .collect()
}

#[must_use]
pub fn insert_selected_mention(
    buffer: &str,
    selected_path: &str,
) -> Option<(String, ComposerMentionBinding)> {
    let query = extract_active_mention_query(buffer)?;
    let (_, range_suffix) = mention_query_parts(&query);
    let raw_suffix = format!("@{query}");
    let replacement = format!("@{selected_path}{range_suffix}");
    let updated = buffer.trim_end_matches(&raw_suffix).to_string() + &replacement + " ";

    Some((
        updated,
        ComposerMentionBinding {
            token: replacement,
            path: format!("{selected_path}{range_suffix}"),
        },
    ))
}

#[must_use]
pub fn prune_mention_bindings(
    buffer: &str,
    bindings: &[ComposerMentionBinding],
) -> Vec<ComposerMentionBinding> {
    bindings
        .iter()
        .filter_map(|binding| current_token_for_binding(buffer, &binding.token))
        .map(|token| ComposerMentionBinding {
            path: token.trim_start_matches('@').to_string(),
            token,
        })
        .collect()
}

#[must_use]
pub fn collect_buffer_mentions(
    buffer: &str,
    bindings: &[ComposerMentionBinding],
) -> Vec<ComposerMentionBinding> {
    let mut resolved = prune_mention_bindings(buffer, bindings);
    for token in extract_manual_mentions(buffer) {
        if resolved.iter().any(|binding| binding.token == token) {
            continue;
        }
        resolved.push(ComposerMentionBinding {
            path: token.trim_start_matches('@').to_string(),
            token,
        });
    }
    resolved
}

#[must_use]
pub fn resolve_mention_context(cwd: &Path, bindings: &[ComposerMentionBinding]) -> MentionContext {
    let mut sections = Vec::new();
    let mut errors = Vec::new();

    for binding in bindings {
        let (relative_path, line_range) = parse_mention_target(&binding.path);
        let path = cwd.join(relative_path);
        match fs::read(&path) {
            Ok(bytes) => {
                if bytes.contains(&0) {
                    errors.push(format!(
                        "{} looks like a binary file and was skipped.",
                        binding.path
                    ));
                    continue;
                }

                match String::from_utf8(bytes) {
                    Ok(text) => {
                        let rendered = if let Some((start, end)) = line_range {
                            match slice_lines(&text, start, end) {
                                Some(excerpt) => excerpt,
                                None => {
                                    errors.push(format!(
                                        "{} requested an invalid line range and was skipped.",
                                        binding.path
                                    ));
                                    continue;
                                }
                            }
                        } else {
                            text.trim_end().to_string()
                        };
                        sections.push(format!(
                            "Attached file: {}\n```text\n{}\n```",
                            binding.path, rendered
                        ));
                    }
                    Err(_) => {
                        errors.push(format!(
                            "{} could not be decoded as UTF-8 and was skipped.",
                            binding.path
                        ));
                    }
                }
            }
            Err(error) => {
                errors.push(format!("{} could not be read: {error}", binding.path));
            }
        }
    }

    MentionContext { sections, errors }
}

fn current_token_for_binding(buffer: &str, token_prefix: &str) -> Option<String> {
    let mut search = buffer;
    let mut offset = 0usize;
    while let Some(index) = search.find(token_prefix) {
        let absolute = offset + index;
        let before_ok = absolute == 0
            || buffer[..absolute]
                .chars()
                .last()
                .is_some_and(char::is_whitespace);
        if before_ok {
            let rest = &buffer[absolute..];
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            return Some(rest[..end].to_string());
        }
        let next_start = index + token_prefix.len();
        offset += next_start;
        search = &search[next_start..];
    }
    None
}

fn extract_manual_mentions(buffer: &str) -> Vec<String> {
    let mut mentions = Vec::new();
    let mut chars = buffer.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        if ch != '@' {
            continue;
        }
        let before_ok = index == 0
            || buffer[..index]
                .chars()
                .last()
                .is_some_and(char::is_whitespace);
        if !before_ok {
            continue;
        }

        let mut end = buffer.len();
        while let Some((next_index, next_ch)) = chars.peek().copied() {
            if next_ch.is_whitespace() {
                end = next_index;
                break;
            }
            let _ = chars.next();
        }

        if end > index + 1 {
            mentions.push(buffer[index..end].to_string());
        }
    }
    mentions
}

fn parse_mention_target(path: &str) -> (&str, Option<(usize, usize)>) {
    let Some((relative_path, range)) = path.rsplit_once('#') else {
        return (path, None);
    };

    let parsed = if let Some((start, end)) = range.split_once('-') {
        match (
            normalize_line_number(start).parse::<usize>(),
            normalize_line_number(end).parse::<usize>(),
        ) {
            (Ok(start), Ok(end)) => Some((start, end)),
            _ => None,
        }
    } else {
        match normalize_line_number(range).parse::<usize>() {
            Ok(line) => Some((line, line)),
            Err(_) => None,
        }
    };

    (relative_path, parsed)
}

fn normalize_line_number(value: &str) -> &str {
    value
        .strip_prefix('L')
        .or_else(|| value.strip_prefix('l'))
        .unwrap_or(value)
}

fn mention_query_parts(query: &str) -> (&str, &str) {
    query
        .split_once('#')
        .map(|(path, suffix)| (path, &query[path.len()..path.len() + 1 + suffix.len()]))
        .unwrap_or((query, ""))
}

fn slice_lines(text: &str, start: usize, end: usize) -> Option<String> {
    if start == 0 || end == 0 || start > end {
        return None;
    }

    let lines = text.lines().collect::<Vec<_>>();
    if start > lines.len() || end > lines.len() {
        return None;
    }

    Some(lines[start - 1..end].join("\n"))
}
