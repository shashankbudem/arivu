// Arivu-specific adaptation of Grok Build's compact inline terminal layout.
// Colors and metadata are customized for Arivu's black-cyan product language.

use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Padding, Paragraph, Widget, Wrap};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::{App, ApprovalState, ModalState, ModelPickerState, PickerState};
use crate::layout::{inset_x, top_breathing_rows};
use crate::protocol::{ActivityItem, ActivityPhase};
use crate::theme;

pub fn render(frame: &mut Frame<'_>, app: &App) {
    let area = frame.area();
    Clear.render(area, frame.buffer_mut());
    frame.buffer_mut().set_style(area, theme::base());
    if area.width < 4 || area.height < 3 {
        Paragraph::new("Arivu needs a larger terminal.")
            .style(theme::base())
            .render(area, frame.buffer_mut());
        return;
    }

    let top_spacing = top_breathing_rows(area.height);
    let bottom_spacing = u16::from(area.height >= 8);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(top_spacing),
            Constraint::Length(1),
            Constraint::Min(0),
            Constraint::Length(1),
            Constraint::Length(3),
            Constraint::Length(1),
            Constraint::Length(bottom_spacing),
        ])
        .split(area);
    let header = inset_x(rows[1]);
    let content = inset_x(rows[2]);
    let status = inset_x(rows[3]);
    let prompt = inset_x(rows[4]);
    let footer = inset_x(rows[5]);

    render_header(frame, header, app);

    if let Some(approval) = &app.approval {
        render_approval(frame, content, approval);
    } else if let Some(picker) = &app.picker {
        render_picker(frame, content, picker);
    } else if let Some(picker) = &app.model_picker {
        render_model_picker(frame, content, picker);
    } else if let Some(modal) = &app.modal {
        render_modal(frame, content, modal);
    } else if app.activity_open {
        render_activity(
            frame,
            content,
            &app.activity,
            app.activity_scroll,
            app.activity_detail_scroll,
        );
    } else if app.slash_open() {
        render_slash(frame, content, app);
    } else {
        render_live_tail(frame, content, app);
    }

    render_status(frame, status, app);
    render_prompt(frame, prompt, app);
    render_footer(frame, footer);
}

fn render_header(frame: &mut Frame<'_>, area: Rect, app: &App) {
    if area.height == 0 {
        return;
    }
    let branch = app
        .branch
        .as_ref()
        .map(|value| format!(" {value}{}", if app.dirty { "*" } else { "" }))
        .unwrap_or_else(|| "no git".to_owned());
    let context = format_context(app.context_used, app.context_total);
    let context_width = context.width().min(area.width.saturating_sub(12) as usize) as u16;
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Min(0), Constraint::Length(context_width)])
        .split(area);
    let left_area = columns[0];
    let right_area = columns[1];
    let left_width = left_area.width as usize;
    let project = shorten_middle(&app.project_name, left_width / 4);
    let location = shorten_middle(
        &app.cwd,
        left_width.saturating_sub(project.width() + branch.width() + 8),
    );
    let left = Line::from(vec![
        Span::styled(project, theme::accent_bold()),
        Span::styled("  ", theme::dim()),
        Span::styled(branch, theme::muted()),
        Span::styled("  ", theme::dim()),
        Span::styled(location, theme::dim()),
    ]);
    Paragraph::new(left).render(left_area, frame.buffer_mut());
    if right_area.width > 0 {
        Paragraph::new(Line::from(Span::styled(
            shorten_tail(&context, right_area.width as usize),
            theme::muted(),
        )))
        .alignment(Alignment::Right)
        .render(right_area, frame.buffer_mut());
    }
}

fn render_live_tail(frame: &mut Frame<'_>, area: Rect, app: &App) {
    if area.height == 0 {
        return;
    }
    if let Some(shell) = &app.current_shell {
        render_live_shell(frame, area, &shell.command, &shell.output);
        return;
    }
    if app.current_assistant.trim().is_empty() {
        return;
    }
    let paragraph = Paragraph::new(app.current_assistant.as_str())
        .wrap(Wrap { trim: false })
        .style(theme::base());
    let line_count = paragraph.line_count(area.width) as u16;
    let scroll = line_count.saturating_sub(area.height);
    paragraph
        .scroll((scroll, 0))
        .render(area, frame.buffer_mut());
}

fn render_live_shell(frame: &mut Frame<'_>, area: Rect, command: &str, output: &str) {
    let mut lines = vec![Line::from(Span::styled(
        format!("! {command}"),
        theme::accent_bold(),
    ))];
    if output.trim().is_empty() {
        lines.push(Line::from(Span::styled(
            "Waiting for output…",
            theme::dim(),
        )));
    } else {
        lines.extend(output.lines().map(shell_output_line));
    }
    let paragraph = Paragraph::new(Text::from(lines))
        .wrap(Wrap { trim: false })
        .style(theme::base());
    let line_count = paragraph.line_count(area.width) as u16;
    let scroll = line_count.saturating_sub(area.height);
    paragraph
        .scroll((scroll, 0))
        .render(area, frame.buffer_mut());
}

fn shell_output_line(line: &str) -> Line<'static> {
    let style = match line {
        "stdout:" => theme::muted(),
        "stderr:" => Style::default().fg(theme::ERROR),
        _ if line.starts_with("… [") => theme::dim(),
        _ => Style::default(),
    };
    Line::from(Span::styled(line.to_owned(), style))
}

fn render_status(frame: &mut Frame<'_>, area: Rect, app: &App) {
    if area.height == 0 {
        return;
    }
    let queue = if app.queue_len > 0 {
        format!(" · {} queued", app.queue_len)
    } else {
        String::new()
    };
    let left = if app.busy {
        Line::from(vec![
            Span::styled(app.spinner(), theme::accent_bold()),
            Span::raw(" "),
            Span::styled(app.status.clone(), theme::muted()),
            Span::styled(queue, theme::dim()),
        ])
    } else {
        Line::from(Span::styled(app.status.clone(), theme::dim()))
    };
    Paragraph::new(left).render(area, frame.buffer_mut());

    if app.busy {
        let elapsed = format_duration(app.elapsed().as_secs());
        let right = Line::from(vec![
            Span::styled(elapsed, theme::dim()),
            Span::raw("  "),
            Span::styled("Esc stop", Style::default().fg(theme::ERROR)),
        ]);
        Paragraph::new(right)
            .alignment(Alignment::Right)
            .render(area, frame.buffer_mut());
    }
}

fn render_prompt(frame: &mut Frame<'_>, area: Rect, app: &App) {
    let metadata_width = area.width.saturating_sub(8) as usize;
    let metadata = if metadata_width >= app.trust.width() + 4 {
        Some(format!(
            " {} · {} ",
            shorten_tail(
                &app.model,
                metadata_width.saturating_sub(app.trust.width() + 3)
            ),
            app.trust
        ))
    } else {
        None
    };
    let border_style = if app.busy {
        Style::default().fg(theme::WARNING)
    } else {
        theme::dim()
    };
    let mut block = Block::new()
        .style(theme::base())
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(border_style)
        .padding(Padding::horizontal(1));
    if let Some(metadata) = metadata {
        block = block.title_bottom(
            Line::from(Span::styled(metadata, theme::dim())).alignment(Alignment::Right),
        );
    }
    let inner = block.inner(area);
    block.render(area, frame.buffer_mut());

    let prefix = if app.busy { app.spinner() } else { "❯" };
    let prefix_style = if app.busy {
        Style::default()
            .fg(theme::WARNING)
            .add_modifier(Modifier::BOLD)
    } else {
        theme::accent_bold()
    };
    let available = inner.width.saturating_sub(2) as usize;
    let (visible, cursor_width) = visible_prompt(&app.prompt, app.prompt_cursor, available.max(1));
    let prompt_text = if visible.is_empty() {
        Line::from(vec![
            Span::styled(format!("{prefix} "), prefix_style),
            Span::styled("Build anything", theme::dim()),
        ])
    } else {
        Line::from(vec![
            Span::styled(format!("{prefix} "), prefix_style),
            Span::raw(visible),
        ])
    };
    Paragraph::new(prompt_text).render(inner, frame.buffer_mut());
    if inner.width > 0 && inner.height > 0 {
        frame.set_cursor_position(Position::new(
            inner.x + (2 + cursor_width.min(available) as u16).min(inner.width - 1),
            inner.y,
        ));
    }
}

fn render_footer(frame: &mut Frame<'_>, area: Rect) {
    let mut spans = vec![
        Span::styled("/", theme::accent_bold()),
        Span::styled(" commands", theme::dim()),
        Span::styled("   ", theme::dim()),
        Span::styled("Ctrl+Q", theme::muted()),
        Span::styled(" quit", theme::dim()),
        Span::styled("   ", theme::dim()),
        Span::styled("Ctrl+G", theme::muted()),
        Span::styled(" activity", theme::dim()),
    ];
    // Keep the escape hint visible in ordinary terminals while letting very
    // narrow layouts retain their core shortcut labels without wrapping.
    if area.width >= 66 {
        spans.extend([
            Span::styled("   ", theme::dim()),
            Span::styled("! command", theme::accent_bold()),
            Span::styled(" shell", theme::dim()),
        ]);
    }
    let left = Line::from(spans);
    Paragraph::new(left).render(area, frame.buffer_mut());
}

fn render_slash(frame: &mut Frame<'_>, area: Rect, app: &App) {
    if area.height == 0 {
        return;
    }
    let matches = app.slash_matches();
    let height = (matches.len() as u16 + 2).min(area.height);
    let panel = Rect {
        x: area.x,
        y: area.bottom().saturating_sub(height),
        width: area.width,
        height,
    };
    Clear.render(panel, frame.buffer_mut());
    let block = Block::new()
        .style(theme::base())
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(theme::dim())
        .title(Span::styled(" commands ", theme::muted()))
        .padding(Padding::horizontal(1));
    let inner = block.inner(panel);
    block.render(panel, frame.buffer_mut());

    let label_width = matches
        .iter()
        .filter_map(|matched| app.commands.get(matched.command_index))
        .map(|command| command.usage.width())
        .max()
        .unwrap_or(12)
        .min((inner.width as usize * 3 / 5).max(12))
        .min(36);

    for (row, matched) in matches.iter().take(inner.height as usize).enumerate() {
        let Some(command) = app.commands.get(matched.command_index) else {
            continue;
        };
        let selected = row == app.slash_selected;
        let y = inner.y + row as u16;
        let row_area = Rect::new(inner.x, y, inner.width, 1);
        if selected {
            frame
                .buffer_mut()
                .set_style(row_area, Style::default().bg(theme::SELECTED));
        }
        let prefix = if selected { "❯ " } else { "  " };
        let label = truncate(&command.usage, label_width);
        let padding = " ".repeat(label_width.saturating_sub(label.width()) + 2);
        let line = Line::from(vec![
            Span::styled(
                prefix,
                if selected {
                    theme::accent_bold()
                } else {
                    theme::dim()
                },
            ),
            Span::styled(
                label,
                if selected {
                    Style::default().add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                },
            ),
            Span::raw(padding),
            Span::styled(
                truncate(
                    &command.description,
                    inner.width.saturating_sub(label_width as u16 + 4) as usize,
                ),
                theme::muted(),
            ),
        ]);
        frame.buffer_mut().set_line(inner.x, y, &line, inner.width);
    }
}

fn render_approval(frame: &mut Frame<'_>, area: Rect, approval: &ApprovalState) {
    let title_style = if approval.risky {
        Style::default()
            .fg(theme::ERROR)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default()
            .fg(theme::WARNING)
            .add_modifier(Modifier::BOLD)
    };
    let block = Block::new()
        .style(theme::base())
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(if approval.risky {
            Style::default().fg(theme::ERROR)
        } else {
            Style::default().fg(theme::WARNING)
        })
        .title(Span::styled(format!(" {} ", approval.title), title_style))
        .padding(Padding::horizontal(1));
    let inner = block.inner(area);
    block.render(area, frame.buffer_mut());
    let body_height = inner.height.saturating_sub(2);
    Paragraph::new(approval.message.as_str())
        .wrap(Wrap { trim: false })
        .render(
            Rect::new(inner.x, inner.y, inner.width, body_height),
            frame.buffer_mut(),
        );
    if inner.height >= 2 {
        let actions = Line::from(vec![
            Span::styled(
                "1 / y",
                Style::default()
                    .fg(theme::SUCCESS)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(" approve    "),
            Span::styled(
                "2 / n / Esc",
                Style::default()
                    .fg(theme::ERROR)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(" deny"),
        ]);
        frame.buffer_mut().set_line(
            inner.x,
            inner.bottom().saturating_sub(1),
            &actions,
            inner.width,
        );
    }
}

fn render_modal(frame: &mut Frame<'_>, area: Rect, modal: &ModalState) {
    let block = panel_block(&modal.title);
    let inner = block.inner(area);
    block.render(area, frame.buffer_mut());
    Paragraph::new(modal.body.as_str())
        .wrap(Wrap { trim: false })
        .scroll((modal.scroll, 0))
        .render(inner, frame.buffer_mut());
}

fn render_picker(frame: &mut Frame<'_>, area: Rect, picker: &PickerState) {
    let block = panel_block(&picker.title);
    let inner = block.inner(area);
    block.render(area, frame.buffer_mut());
    if picker.sessions.is_empty() {
        Paragraph::new("No saved sessions.").render(inner, frame.buffer_mut());
        return;
    }
    let visible_rows = inner.height.saturating_sub(1) as usize;
    let start = picker
        .selected
        .saturating_sub(visible_rows.saturating_sub(1))
        .max(picker.scroll.min(picker.selected));
    for (row, session) in picker
        .sessions
        .iter()
        .skip(start)
        .take(visible_rows)
        .enumerate()
    {
        let index = start + row;
        let y = inner.y + row as u16;
        let selected = index == picker.selected;
        let row_area = Rect::new(inner.x, y, inner.width, 1);
        if selected {
            frame
                .buffer_mut()
                .set_style(row_area, Style::default().bg(theme::SELECTED));
        }
        let line = Line::from(vec![
            Span::styled(
                if selected { "❯ " } else { "  " },
                if selected {
                    theme::accent_bold()
                } else {
                    theme::dim()
                },
            ),
            Span::styled(
                truncate(&session.label, inner.width.saturating_sub(3) as usize),
                if selected {
                    Style::default().add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                },
            ),
            if session.description.is_empty() {
                Span::raw("")
            } else {
                Span::styled(format!("  {}", session.description), theme::muted())
            },
        ]);
        frame.buffer_mut().set_line(inner.x, y, &line, inner.width);
    }
    if inner.height > 0 {
        let hint = Line::from(Span::styled(
            "↑/↓ move  Enter resume  Esc cancel",
            theme::dim(),
        ));
        frame.buffer_mut().set_line(
            inner.x,
            inner.bottom().saturating_sub(1),
            &hint,
            inner.width,
        );
    }
}

fn render_model_picker(frame: &mut Frame<'_>, area: Rect, picker: &ModelPickerState) {
    let block = panel_block(&picker.title);
    let inner = block.inner(area);
    block.render(area, frame.buffer_mut());
    if inner.height == 0 {
        return;
    }
    let indexes = picker.filtered_indexes();
    let header = format!(
        "{} · current: {}",
        picker.endpoint_label, picker.current_model
    );
    frame.buffer_mut().set_line(
        inner.x,
        inner.y,
        &Line::from(Span::styled(
            truncate(&header, inner.width as usize),
            theme::muted(),
        )),
        inner.width,
    );
    if inner.height > 1 {
        let query = if picker.query.is_empty() {
            "Search models…".to_owned()
        } else {
            picker.query.clone()
        };
        frame.buffer_mut().set_line(
            inner.x,
            inner.y + 1,
            &Line::from(vec![
                Span::styled("⌕ ", theme::accent_bold()),
                Span::styled(
                    truncate(&query, inner.width.saturating_sub(2) as usize),
                    if picker.query.is_empty() {
                        theme::dim()
                    } else {
                        Style::default()
                    },
                ),
            ]),
            inner.width,
        );
    }
    let hint_row = inner.bottom().saturating_sub(1);
    let first_row = inner.y.saturating_add(2);
    let visible_rows = hint_row.saturating_sub(first_row) as usize;
    if indexes.is_empty() && first_row < hint_row {
        frame.buffer_mut().set_line(
            inner.x,
            first_row,
            &Line::from(Span::styled("No matching models.", theme::muted())),
            inner.width,
        );
    }
    let start = picker
        .selected
        .saturating_sub(visible_rows.saturating_sub(1))
        .max(picker.scroll.min(picker.selected));
    for (row, index) in indexes.iter().skip(start).take(visible_rows).enumerate() {
        let model = &picker.models[*index];
        let y = first_row.saturating_add(row as u16);
        let selected = start + row == picker.selected;
        let row_area = Rect::new(inner.x, y, inner.width, 1);
        if selected {
            frame
                .buffer_mut()
                .set_style(row_area, Style::default().bg(theme::SELECTED));
        }
        let description = if model.description.is_empty() {
            String::new()
        } else {
            format!("  {}", model.description)
        };
        let line = Line::from(vec![
            Span::styled(
                if selected { "❯ " } else { "  " },
                if selected {
                    theme::accent_bold()
                } else {
                    theme::dim()
                },
            ),
            Span::styled(
                truncate(&model.label, inner.width.saturating_sub(3) as usize),
                if selected {
                    Style::default().add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                },
            ),
            Span::styled(description, theme::muted()),
        ]);
        frame.buffer_mut().set_line(inner.x, y, &line, inner.width);
    }
    if inner.height > 0 {
        let hint = if picker.notice.is_empty() {
            "type to search  ↑/↓ or PgUp/PgDn move  Enter select  Esc cancel".to_owned()
        } else {
            picker.notice.clone()
        };
        frame.buffer_mut().set_line(
            inner.x,
            hint_row,
            &Line::from(Span::styled(
                truncate(&hint, inner.width as usize),
                theme::dim(),
            )),
            inner.width,
        );
    }
}

fn render_activity(
    frame: &mut Frame<'_>,
    area: Rect,
    activity: &[ActivityItem],
    selected: usize,
    detail_scroll: u16,
) {
    let block = panel_block("Activity · full tool details");
    let inner = block.inner(area);
    block.render(area, frame.buffer_mut());
    if activity.is_empty() {
        Paragraph::new("No tool activity yet.").render(inner, frame.buffer_mut());
        return;
    }
    let list_height = inner.height.min(6).saturating_sub(1) as usize;
    let selected = selected.min(activity.len().saturating_sub(1));
    let start = selected.saturating_sub(list_height.saturating_sub(1));
    for (row, item) in activity.iter().skip(start).take(list_height).enumerate() {
        let index = start + row;
        let y = inner.y + row as u16;
        let active = index == selected;
        let glyph = match item.phase {
            ActivityPhase::Running => "◆",
            ActivityPhase::Completed => "✓",
            ActivityPhase::Failed => "×",
            ActivityPhase::System => "·",
        };
        let color = match item.phase {
            ActivityPhase::Running => theme::ACCENT,
            ActivityPhase::Completed => theme::SUCCESS,
            ActivityPhase::Failed => theme::ERROR,
            ActivityPhase::System => theme::MUTED,
        };
        let row_area = Rect::new(inner.x, y, inner.width, 1);
        if active {
            frame
                .buffer_mut()
                .set_style(row_area, Style::default().bg(theme::SELECTED));
        }
        let line = Line::from(vec![
            Span::styled(format!("{glyph} "), Style::default().fg(color)),
            Span::styled(
                item.name.clone(),
                if active {
                    Style::default().add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                },
            ),
        ]);
        frame.buffer_mut().set_line(inner.x, y, &line, inner.width);
    }
    let detail_y = inner.y + list_height as u16;
    let detail_bottom = inner.bottom().saturating_sub(1);
    if detail_y < detail_bottom {
        let detail = &activity[selected].detail;
        Paragraph::new(detail.as_str())
            .style(theme::muted())
            .wrap(Wrap { trim: false })
            .scroll((detail_scroll, 0))
            .render(
                Rect::new(inner.x, detail_y, inner.width, detail_bottom - detail_y),
                frame.buffer_mut(),
            );
    }
    if inner.height > 0 {
        let hint = Line::from(Span::styled(
            "↑/↓ select tool  PgUp/PgDown scroll details  Esc close",
            theme::dim(),
        ));
        frame.buffer_mut().set_line(
            inner.x,
            inner.bottom().saturating_sub(1),
            &hint,
            inner.width,
        );
    }
}

fn panel_block(title: &str) -> Block<'static> {
    Block::new()
        .style(theme::base().bg(theme::PANEL))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(theme::dim())
        .title(Span::styled(format!(" {title} "), theme::accent_bold()))
        .padding(Padding::horizontal(1))
}

fn visible_prompt(value: &str, cursor: usize, available: usize) -> (String, usize) {
    let chars = value.chars().collect::<Vec<_>>();
    let cursor = cursor.min(chars.len());
    let mut start = cursor;
    let mut used = 0usize;
    while start > 0 {
        let width = chars[start - 1].width().unwrap_or(1);
        if used + width > available.saturating_sub(1) {
            break;
        }
        used += width;
        start -= 1;
    }
    let mut end = cursor;
    let mut total = used;
    while end < chars.len() {
        let width = chars[end].width().unwrap_or(1);
        if total + width > available {
            break;
        }
        total += width;
        end += 1;
    }
    let mut visible = chars[start..end].iter().collect::<String>();
    if start > 0 && !visible.is_empty() {
        visible.replace_range(..visible.chars().next().unwrap().len_utf8(), "…");
    }
    if end < chars.len() && !visible.is_empty() {
        let last_start = visible
            .char_indices()
            .last()
            .map(|(index, _)| index)
            .unwrap_or(0);
        visible.replace_range(last_start.., "…");
    }
    let cursor_width = chars[start..cursor]
        .iter()
        .map(|character| character.width().unwrap_or(1))
        .sum();
    (visible, cursor_width)
}

fn format_context(used: Option<u64>, total: Option<u64>) -> String {
    match (used, total) {
        (Some(used), Some(total)) => format!("{} / {}", format_tokens(used), format_tokens(total)),
        (Some(used), None) => format!("{} tokens", format_tokens(used)),
        _ => "context —".to_owned(),
    }
}

fn format_tokens(value: u64) -> String {
    if value < 1_000 {
        value.to_string()
    } else if value < 10_000 {
        format!("{:.1}K", value as f64 / 1_000.0).replace(".0K", "K")
    } else if value < 1_000_000 {
        format!("{}K", value / 1_000)
    } else if value < 10_000_000 {
        format!("{:.1}M", value as f64 / 1_000_000.0).replace(".0M", "M")
    } else {
        format!("{}M", value / 1_000_000)
    }
}

fn format_duration(seconds: u64) -> String {
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    }
}

fn truncate(value: &str, width: usize) -> String {
    if value.width() <= width {
        return value.to_owned();
    }
    if width <= 1 {
        return "…".to_owned();
    }
    let mut output = String::new();
    let mut used = 0;
    for character in value.chars() {
        let character_width = character.width().unwrap_or(1);
        if used + character_width >= width {
            break;
        }
        output.push(character);
        used += character_width;
    }
    output.push('…');
    output
}

fn shorten_tail(value: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if value.width() <= width {
        return value.to_owned();
    }
    let tail = value
        .chars()
        .rev()
        .take(width.saturating_sub(1))
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("…{tail}")
}

fn shorten_middle(value: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if value.width() <= width {
        return value.to_owned();
    }
    if width < 4 {
        return "…".to_owned();
    }
    let keep = width.saturating_sub(1) / 2;
    let head = value.chars().take(keep).collect::<String>();
    let tail = value
        .chars()
        .rev()
        .take(keep)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}…{tail}")
}

#[cfg(test)]
mod tests {
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::style::Color;

    use super::*;
    use crate::protocol::{CommandSpec, InitData};

    fn app() -> App {
        App::from_init(InitData {
            project_name: "arivu".to_owned(),
            cwd: "/work/arivu".to_owned(),
            root: "/work/arivu".to_owned(),
            branch: Some("main".to_owned()),
            dirty: true,
            model: "arivu/test-model".to_owned(),
            trust: "ask".to_owned(),
            session_id: None,
            context_used: Some(3_200),
            context_total: Some(524_000),
            transcript: Vec::new(),
            activity: Vec::new(),
            commands: vec![CommandSpec {
                command: "/help".to_owned(),
                usage: "/help".to_owned(),
                title: "help".to_owned(),
                description: "Show help".to_owned(),
                aliases: Vec::new(),
                takes_args: false,
                args_required: false,
            }],
        })
    }

    #[test]
    fn idle_frame_is_a_full_black_canvas_with_compact_chrome() {
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        let app = app();

        terminal
            .draw(|frame| render(frame, &app))
            .expect("draw frame");

        let buffer = terminal.backend().buffer();
        for y in 0..24 {
            for x in 0..80 {
                assert_eq!(
                    buffer.cell((x, y)).expect("cell").bg,
                    Color::Rgb(0, 0, 0),
                    "cell ({x}, {y}) lost the black canvas"
                );
            }
        }
        let top_spacing = (0..80)
            .map(|x| buffer.cell((x, 0)).expect("top spacing cell").symbol())
            .collect::<String>();
        assert!(top_spacing.trim().is_empty());
        let header = (0..80)
            .map(|x| buffer.cell((x, 1)).expect("header cell").symbol())
            .collect::<String>();
        assert!(header.contains("arivu"));
        assert!(header.contains("3.2K / 524K"));
        assert_eq!(buffer.cell((0, 1)).expect("outer gutter").symbol(), " ");
        assert_eq!(buffer.cell((1, 1)).expect("outer gutter").symbol(), " ");
        assert_eq!(buffer.cell((2, 1)).expect("header start").symbol(), "a");
        assert_ne!(buffer.cell((2, 19)).expect("composer border").symbol(), " ");
        assert_eq!(buffer.cell((1, 19)).expect("composer gutter").symbol(), " ");
        let prompt_row = (0..80)
            .map(|x| buffer.cell((x, 20)).expect("prompt cell").symbol())
            .collect::<String>();
        assert!(prompt_row.contains("Build anything"));
        let bottom_spacing = (0..80)
            .map(|x| buffer.cell((x, 23)).expect("bottom spacing cell").symbol())
            .collect::<String>();
        assert!(bottom_spacing.trim().is_empty());
    }

    #[test]
    fn narrow_frame_clamps_gutters_without_losing_the_black_canvas() {
        let backend = TestBackend::new(12, 8);
        let mut terminal = Terminal::new(backend).expect("test terminal");

        terminal
            .draw(|frame| render(frame, &app()))
            .expect("draw narrow frame");

        let buffer = terminal.backend().buffer();
        for y in 0..8 {
            for x in 0..12 {
                assert_eq!(
                    buffer.cell((x, y)).expect("cell").bg,
                    Color::Rgb(0, 0, 0),
                    "cell ({x}, {y}) lost the black canvas"
                );
            }
        }
        assert_eq!(buffer.cell((0, 0)).expect("outer gutter").symbol(), " ");
        assert_ne!(buffer.cell((1, 0)).expect("header start").symbol(), " ");
        assert_ne!(buffer.cell((1, 3)).expect("composer border").symbol(), " ");
        assert_eq!(buffer.cell((0, 3)).expect("composer gutter").symbol(), " ");
        let bottom_spacing = (0..12)
            .map(|x| buffer.cell((x, 7)).expect("bottom spacing cell").symbol())
            .collect::<String>();
        assert!(bottom_spacing.trim().is_empty());
    }

    #[test]
    fn wide_footer_advertises_the_bang_shell_escape_without_crowding_narrow_layouts() {
        let wide_backend = TestBackend::new(80, 24);
        let mut wide_terminal = Terminal::new(wide_backend).expect("wide terminal");
        wide_terminal
            .draw(|frame| render(frame, &app()))
            .expect("draw wide frame");
        let wide_footer = (0..80)
            .map(|x| {
                wide_terminal
                    .backend()
                    .buffer()
                    .cell((x, 22))
                    .expect("wide footer cell")
                    .symbol()
            })
            .collect::<String>();
        assert!(wide_footer.contains("! command"));

        let narrow_backend = TestBackend::new(60, 24);
        let mut narrow_terminal = Terminal::new(narrow_backend).expect("narrow terminal");
        narrow_terminal
            .draw(|frame| render(frame, &app()))
            .expect("draw narrow frame");
        let narrow_footer = (0..60)
            .map(|x| {
                narrow_terminal
                    .backend()
                    .buffer()
                    .cell((x, 22))
                    .expect("narrow footer cell")
                    .symbol()
            })
            .collect::<String>();
        assert!(!narrow_footer.contains("! command"));
    }
}
