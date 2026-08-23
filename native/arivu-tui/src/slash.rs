// Arivu-specific adaptation of Grok Build's slash-command dropdown matching.
// The command payloads and execution remain owned by Arivu's TypeScript core.

use crate::protocol::CommandSpec;

pub const MAX_VISIBLE: usize = 8;

#[derive(Debug, Clone)]
pub struct SlashMatch {
    pub command_index: usize,
    pub score: i32,
}

pub fn matches(commands: &[CommandSpec], prompt: &str) -> Vec<SlashMatch> {
    if !prompt.starts_with('/') {
        return Vec::new();
    }

    let query = prompt
        .trim_start_matches('/')
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_lowercase();
    let mut ranked = commands
        .iter()
        .enumerate()
        .filter_map(|(command_index, command)| {
            let mut candidates = Vec::with_capacity(command.aliases.len() + 2);
            candidates.push(command.command.trim_start_matches('/').to_lowercase());
            candidates.push(command.title.to_lowercase());
            candidates.extend(
                command
                    .aliases
                    .iter()
                    .map(|alias| alias.trim_start_matches('/').to_lowercase()),
            );
            candidates
                .iter()
                .filter_map(|candidate| fuzzy_score(candidate, &query))
                .max()
                .map(|score| SlashMatch {
                    command_index,
                    score,
                })
        })
        .collect::<Vec<_>>();

    ranked.sort_by(|left, right| {
        right.score.cmp(&left.score).then_with(|| {
            commands[left.command_index]
                .command
                .cmp(&commands[right.command_index].command)
        })
    });
    ranked.truncate(MAX_VISIBLE);
    ranked
}

pub fn selected<'a>(
    commands: &'a [CommandSpec],
    prompt: &str,
    selected_index: usize,
) -> Option<&'a CommandSpec> {
    let ranked = matches(commands, prompt);
    ranked
        .get(selected_index.min(ranked.len().saturating_sub(1)))
        .and_then(|item| commands.get(item.command_index))
}

fn fuzzy_score(candidate: &str, query: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    if candidate == query {
        return Some(10_000);
    }
    if candidate.starts_with(query) {
        return Some(8_000 - candidate.len() as i32);
    }
    if let Some(position) = candidate.find(query) {
        return Some(6_000 - position as i32 * 10 - candidate.len() as i32);
    }

    let mut query_chars = query.chars();
    let mut next = query_chars.next()?;
    let mut score = 3_000i32;
    let mut last_match = None;
    for (index, character) in candidate.chars().enumerate() {
        if character != next {
            continue;
        }
        if let Some(previous) = last_match {
            score -= (index - previous - 1) as i32 * 5;
        }
        last_match = Some(index);
        match query_chars.next() {
            Some(value) => next = value,
            None => return Some(score - candidate.len() as i32),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(name: &str) -> CommandSpec {
        CommandSpec {
            command: format!("/{name}"),
            usage: format!("/{name}"),
            title: name.to_owned(),
            description: String::new(),
            aliases: Vec::new(),
            takes_args: false,
            args_required: false,
        }
    }

    #[test]
    fn exact_and_prefix_matches_rank_first() {
        let commands = vec![command("sessions"), command("status"), command("help")];
        let ranked = matches(&commands, "/sta");
        assert_eq!(commands[ranked[0].command_index].command, "/status");
    }

    #[test]
    fn empty_slash_lists_commands() {
        let commands = vec![command("help"), command("status")];
        assert_eq!(matches(&commands, "/").len(), 2);
    }
}
