// The inline commit model follows Grok Build's minimal pager: finalized blocks
// are inserted once above a small live viewport so terminal-native scrolling,
// selection, and search continue to work.

use std::io;

use crossterm::ExecutableCommand;
use crossterm::terminal::{Clear, ClearType};
use ratatui::backend::Backend;
use ratatui::buffer::Buffer;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Paragraph, Widget, Wrap};
use xai_ratatui_inline::Terminal;

use crate::backend::TrackedCrosstermBackend;
use crate::layout::inset_x;
use crate::protocol::{EntryKind, TranscriptEntry};
use crate::theme;

pub type ArivuTerminal = Terminal<TrackedCrosstermBackend<io::Stdout>>;

pub fn commit_entry(terminal: &mut ArivuTerminal, entry: TranscriptEntry) -> io::Result<()> {
    let width = terminal.viewport_area().width.max(1);
    let text = entry_text(&entry);
    let height = committed_height(&text, width);
    terminal.insert_before(height, move |buf| render_committed_entry(buf, text))
}

pub fn commit_transcript(
    terminal: &mut ArivuTerminal,
    transcript: impl IntoIterator<Item = TranscriptEntry>,
) -> io::Result<()> {
    for entry in transcript {
        if !entry.text.trim().is_empty() {
            commit_entry(terminal, entry)?;
        }
    }
    Ok(())
}

pub fn purge_screen(terminal: &mut ArivuTerminal, viewport_height: u16) -> io::Result<()> {
    let size = terminal.backend().size()?;
    terminal.backend_mut().execute(Clear(ClearType::Purge))?;
    terminal
        .backend_mut()
        .set_cursor_position(Position::new(0, 0))?;
    terminal.set_viewport_area(Rect::new(
        0,
        0,
        size.width,
        viewport_height.min(size.height.saturating_sub(1).max(1)),
    ));
    terminal.reset_back_buffer();
    Ok(())
}

fn entry_text(entry: &TranscriptEntry) -> Text<'static> {
    // Timestamps stay protocol-visible for future configurable rendering even
    // though Grok's compact default deliberately keeps them out of scrollback.
    let _timestamp = entry.time.as_deref();
    let mut lines = Vec::new();
    match entry.kind {
        EntryKind::User => {
            for (index, line) in entry.text.lines().enumerate() {
                if index == 0 {
                    let mut spans = vec![Span::styled("❯ ", theme::accent_bold())];
                    spans.extend(inline_spans(line, Style::default()));
                    lines.push(Line::from(spans));
                } else {
                    let mut spans = vec![Span::raw("  ")];
                    spans.extend(inline_spans(line, Style::default()));
                    lines.push(Line::from(spans));
                }
            }
        }
        EntryKind::Assistant => lines.extend(markdown_lines(&entry.text)),
        EntryKind::System => {
            for line in entry.text.lines() {
                let style = if line.starts_with('✓') {
                    Style::default().fg(theme::SUCCESS)
                } else if line.starts_with('◆') {
                    theme::accent()
                } else {
                    theme::muted()
                };
                lines.push(Line::from(inline_spans(line, style)));
            }
        }
        EntryKind::Error => {
            for (index, line) in entry.text.lines().enumerate() {
                let prefix = if index == 0 { "× " } else { "  " };
                lines.push(Line::from(vec![
                    Span::styled(prefix, Style::default().fg(theme::ERROR)),
                    Span::styled(line.to_owned(), Style::default().fg(theme::ERROR)),
                ]));
            }
        }
        EntryKind::Command => {
            for (index, line) in entry.text.lines().enumerate() {
                let style = if index == 0 {
                    theme::accent_bold()
                } else if line == "stderr:" || line.starts_with('×') {
                    Style::default().fg(theme::ERROR)
                } else if line == "stdout:" || line.starts_with('✓') {
                    theme::muted()
                } else if line.starts_with('■') || line.starts_with("… [") {
                    theme::dim()
                } else {
                    Style::default()
                };
                lines.push(Line::from(Span::styled(line.to_owned(), style)));
            }
        }
    }
    if lines.is_empty() {
        lines.push(Line::from(""));
    }
    Text::from(lines)
}

fn committed_height(text: &Text<'_>, width: u16) -> u16 {
    let content_width = inset_x(Rect::new(0, 0, width.max(1), 1)).width.max(1);
    Paragraph::new(text.clone())
        .wrap(Wrap { trim: false })
        .line_count(content_width)
        .max(1)
        .saturating_add(1)
        .min(u16::MAX as usize) as u16
}

fn render_committed_entry(buf: &mut Buffer, text: Text<'static>) {
    buf.set_style(buf.area, theme::base());
    // Put the existing inter-entry breathing row before the message. This also
    // keeps the first committed line off the terminal's top border without
    // increasing the transcript's vertical density.
    let body = Rect::new(
        buf.area.x,
        buf.area.y.saturating_add(1),
        buf.area.width,
        buf.area.height.saturating_sub(1),
    );
    Paragraph::new(text)
        .style(theme::base())
        .wrap(Wrap { trim: false })
        .render(inset_x(body), buf);
}

fn markdown_lines(value: &str) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut in_code = false;
    for raw in value.lines() {
        let trimmed = raw.trim_start();
        if trimmed.starts_with("```") {
            in_code = !in_code;
            let language = trimmed.trim_start_matches('`').trim();
            if !language.is_empty() {
                lines.push(Line::from(Span::styled(
                    language.to_owned(),
                    theme::dim().add_modifier(Modifier::ITALIC),
                )));
            }
            continue;
        }
        if in_code {
            lines.push(Line::from(Span::styled(format!("  {raw}"), theme::muted())));
            continue;
        }
        if let Some(heading) = trimmed.strip_prefix("### ") {
            lines.push(Line::from(Span::styled(
                heading.to_owned(),
                theme::accent_bold(),
            )));
        } else if let Some(heading) = trimmed.strip_prefix("## ") {
            lines.push(Line::from(Span::styled(
                heading.to_owned(),
                theme::accent_bold(),
            )));
        } else if let Some(heading) = trimmed.strip_prefix("# ") {
            lines.push(Line::from(Span::styled(
                heading.to_owned(),
                theme::accent_bold(),
            )));
        } else {
            lines.push(Line::from(inline_spans(raw, Style::default())));
        }
    }
    lines
}

fn inline_spans(value: &str, base: Style) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut remainder = value;
    let mut code = false;
    while let Some(index) = remainder.find('`') {
        if index > 0 {
            spans.push(Span::styled(remainder[..index].to_owned(), base));
        }
        code = !code;
        remainder = &remainder[index + 1..];
        if code {
            let end = remainder.find('`').unwrap_or(remainder.len());
            spans.push(Span::styled(
                remainder[..end].to_owned(),
                Style::default().fg(theme::ACCENT_BRIGHT),
            ));
            if end < remainder.len() {
                remainder = &remainder[end + 1..];
                code = false;
            } else {
                remainder = "";
            }
        }
    }
    if !remainder.is_empty() {
        spans.push(Span::styled(remainder.to_owned(), base));
    }
    if spans.is_empty() {
        spans.push(Span::styled(value.to_owned(), base));
    }
    spans
}

#[cfg(test)]
mod tests {
    use ratatui::style::Color;

    use super::*;

    fn user_entry(value: &str) -> TranscriptEntry {
        TranscriptEntry {
            kind: EntryKind::User,
            text: value.to_owned(),
            time: None,
        }
    }

    #[test]
    fn committed_scrollback_wraps_inside_the_shared_wide_gutter() {
        let text = entry_text(&user_entry("123456789012345678901"));
        // The 23 displayed cells (prompt marker plus text) fit the raw width of
        // 24, but the long word wraps across three rows inside the shared
        // 20-cell content width.
        let height = committed_height(&text, 24);
        assert_eq!(height, 4);

        let mut buffer = Buffer::empty(Rect::new(0, 0, 24, height));
        render_committed_entry(&mut buffer, text);

        let breathing_row = (0..24)
            .map(|x| buffer.cell((x, 0)).expect("breathing row cell").symbol())
            .collect::<String>();
        assert!(breathing_row.trim().is_empty());
        assert_eq!(buffer.cell((0, 1)).expect("left gutter").symbol(), " ");
        assert_eq!(buffer.cell((1, 1)).expect("left gutter").symbol(), " ");
        assert_eq!(buffer.cell((2, 1)).expect("entry start").symbol(), "❯");
        assert_eq!(buffer.cell((22, 1)).expect("right gutter").symbol(), " ");
        assert_eq!(buffer.cell((23, 1)).expect("right gutter").symbol(), " ");
        for y in 0..height {
            for x in 0..24 {
                assert_eq!(
                    buffer.cell((x, y)).expect("canvas cell").bg,
                    Color::Rgb(0, 0, 0),
                    "cell ({x}, {y}) lost the black canvas"
                );
            }
        }
    }

    #[test]
    fn committed_scrollback_keeps_a_one_cell_gutter_when_narrow() {
        let text = entry_text(&user_entry("hello 🔵"));
        let height = committed_height(&text, 12);
        let mut buffer = Buffer::empty(Rect::new(0, 0, 12, height));

        render_committed_entry(&mut buffer, text);

        assert_eq!(buffer.cell((0, 1)).expect("left gutter").symbol(), " ");
        assert_eq!(buffer.cell((1, 1)).expect("entry start").symbol(), "❯");
        assert_eq!(buffer.cell((11, 1)).expect("right gutter").symbol(), " ");
    }
}
