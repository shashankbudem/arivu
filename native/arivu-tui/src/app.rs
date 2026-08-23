// Arivu-specific adaptation of Grok Build's prompt, overlay, and shortcut
// interaction model. See ../NOTICE for the upstream attribution.

use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use crate::protocol::{
    ActivityItem, ActivityPhase, ClientEvent, CommandSpec, EntryKind, InitData, ModelChoice,
    ServerEvent, SessionChoice, ShellOutputStream, TranscriptEntry,
};
use crate::slash;

#[derive(Debug, Clone)]
pub struct ApprovalState {
    pub id: String,
    pub title: String,
    pub message: String,
    pub risky: bool,
}

#[derive(Debug, Clone)]
pub struct ModalState {
    pub title: String,
    pub body: String,
    pub scroll: u16,
}

#[derive(Debug, Clone)]
pub struct PickerState {
    pub title: String,
    pub sessions: Vec<SessionChoice>,
    pub selected: usize,
    pub scroll: usize,
}

#[derive(Debug, Clone)]
pub struct ModelPickerState {
    pub title: String,
    pub current_model: String,
    pub endpoint_label: String,
    pub models: Vec<ModelChoice>,
    pub query: String,
    pub selected: usize,
    pub scroll: usize,
    pub notice: String,
}

impl ModelPickerState {
    pub fn filtered_indexes(&self) -> Vec<usize> {
        let query = self.query.trim().to_lowercase();
        self.models
            .iter()
            .enumerate()
            .filter(|(_, model)| {
                query.is_empty()
                    || model.id.to_lowercase().contains(&query)
                    || model.label.to_lowercase().contains(&query)
            })
            .map(|(index, _)| index)
            .collect()
    }

    fn clamp_selection(&mut self) {
        self.selected = self
            .selected
            .min(self.filtered_indexes().len().saturating_sub(1));
    }
}

const MAX_LIVE_SHELL_OUTPUT_BYTES: usize = 64_000;
const LIVE_SHELL_OUTPUT_MARKER: &str =
    "\n… [live output capped; final result keeps recent output] …\n";

#[derive(Debug, Clone)]
pub struct LiveShellState {
    pub command: String,
    pub output: String,
    last_stream: Option<ShellOutputStream>,
    output_capped: bool,
}

impl LiveShellState {
    fn new(command: String) -> Self {
        Self {
            command,
            output: String::new(),
            last_stream: None,
            output_capped: false,
        }
    }

    fn append(&mut self, stream: ShellOutputStream, delta: &str) {
        if self.output_capped || delta.is_empty() {
            return;
        }
        if self.last_stream != Some(stream) {
            if !self.output.is_empty() && !self.output.ends_with('\n') {
                self.append_limited("\n");
            }
            self.append_limited(match stream {
                ShellOutputStream::Stdout => "stdout:\n",
                ShellOutputStream::Stderr => "stderr:\n",
            });
            self.last_stream = Some(stream);
        }
        self.append_limited(delta);
    }

    fn append_limited(&mut self, value: &str) {
        if self.output_capped || value.is_empty() {
            return;
        }
        let remaining = MAX_LIVE_SHELL_OUTPUT_BYTES.saturating_sub(self.output.len());
        if value.len() <= remaining {
            self.output.push_str(value);
            return;
        }
        let marker_room = LIVE_SHELL_OUTPUT_MARKER.len();
        let content_limit = MAX_LIVE_SHELL_OUTPUT_BYTES.saturating_sub(marker_room);
        if self.output.len() > content_limit {
            let end = utf8_prefix_boundary(&self.output, content_limit);
            self.output.truncate(end);
        }
        let remaining = content_limit.saturating_sub(self.output.len());
        let end = utf8_prefix_boundary(value, remaining);
        self.output.push_str(&value[..end]);
        self.output.push_str(LIVE_SHELL_OUTPUT_MARKER);
        self.output_capped = true;
    }
}

#[derive(Debug)]
pub enum Effect {
    Commit(TranscriptEntry),
    Reset(Vec<TranscriptEntry>),
    Clear,
    Quit,
}

pub struct App {
    pub project_name: String,
    pub cwd: String,
    pub root: String,
    pub branch: Option<String>,
    pub dirty: bool,
    pub model: String,
    pub trust: String,
    pub session_id: Option<String>,
    pub context_used: Option<u64>,
    pub context_total: Option<u64>,
    pub commands: Vec<CommandSpec>,
    pub activity: Vec<ActivityItem>,
    pub prompt: String,
    pub prompt_cursor: usize,
    pub prompt_history: Vec<String>,
    pub history_cursor: Option<usize>,
    pub slash_selected: usize,
    pub slash_dismissed: bool,
    pub busy: bool,
    pub status: String,
    pub queue_len: usize,
    pub current_assistant: String,
    pub current_shell: Option<LiveShellState>,
    pub run_started_at: Option<Instant>,
    pub approval: Option<ApprovalState>,
    pub modal: Option<ModalState>,
    pub picker: Option<PickerState>,
    pub model_picker: Option<ModelPickerState>,
    pub activity_open: bool,
    pub activity_scroll: usize,
    pub activity_detail_scroll: u16,
    pub spinner_tick: usize,
    pub should_quit: bool,
    quit_armed_until: Option<Instant>,
}

impl App {
    pub fn from_init(data: InitData) -> Self {
        Self {
            project_name: data.project_name,
            cwd: data.cwd,
            root: data.root,
            branch: data.branch,
            dirty: data.dirty,
            model: data.model,
            trust: data.trust,
            session_id: data.session_id,
            context_used: data.context_used,
            context_total: data.context_total,
            commands: data.commands,
            activity: data.activity,
            prompt: String::new(),
            prompt_cursor: 0,
            prompt_history: Vec::new(),
            history_cursor: None,
            slash_selected: 0,
            slash_dismissed: false,
            busy: false,
            status: "Ready".to_owned(),
            queue_len: 0,
            current_assistant: String::new(),
            current_shell: None,
            run_started_at: None,
            approval: None,
            modal: None,
            picker: None,
            model_picker: None,
            activity_open: false,
            activity_scroll: 0,
            activity_detail_scroll: 0,
            spinner_tick: 0,
            should_quit: false,
            quit_armed_until: None,
        }
    }

    pub fn replace_init(&mut self, data: InitData) {
        self.project_name = data.project_name;
        self.cwd = data.cwd;
        self.root = data.root;
        self.branch = data.branch;
        self.dirty = data.dirty;
        self.model = data.model;
        self.trust = data.trust;
        self.session_id = data.session_id;
        self.context_used = data.context_used;
        self.context_total = data.context_total;
        self.commands = data.commands;
        self.activity = data.activity;
        self.prompt.clear();
        self.prompt_cursor = 0;
        self.history_cursor = None;
        self.current_assistant.clear();
        self.current_shell = None;
        self.busy = false;
        self.run_started_at = None;
        self.approval = None;
        self.modal = None;
        self.picker = None;
        self.model_picker = None;
        self.status = "Ready".to_owned();
    }

    pub fn apply_server_event(&mut self, event: ServerEvent) -> Vec<Effect> {
        let mut effects = Vec::new();
        match event {
            ServerEvent::Init { .. } => {}
            ServerEvent::Reset { data } => {
                let transcript = data.transcript.clone();
                self.replace_init(*data);
                effects.push(Effect::Reset(transcript));
            }
            ServerEvent::Commit { entry } => effects.push(Effect::Commit(entry)),
            ServerEvent::RunStarted { status } => {
                self.busy = true;
                self.status = status;
                self.current_assistant.clear();
                self.current_shell = None;
                self.run_started_at = Some(Instant::now());
            }
            ServerEvent::AssistantDelta { delta } => {
                self.current_assistant.push_str(&delta);
            }
            ServerEvent::ShellStarted { command } => {
                self.busy = true;
                self.status = format!("Running !{command}");
                self.current_assistant.clear();
                self.current_shell = Some(LiveShellState::new(command));
                self.run_started_at = Some(Instant::now());
            }
            ServerEvent::ShellOutput { stream, delta } => {
                if let Some(shell) = self.current_shell.as_mut() {
                    shell.append(stream, &delta);
                }
            }
            ServerEvent::ShellCompleted {
                command,
                output,
                exit_code,
                signal,
                elapsed_ms,
                stopped,
                output_truncated,
            } => {
                let succeeded = exit_code == Some(0) && signal.is_none();
                effects.push(Effect::Commit(shell_entry(
                    command,
                    output,
                    exit_code,
                    signal,
                    elapsed_ms,
                    stopped,
                    output_truncated,
                )));
                self.current_shell = None;
                self.busy = false;
                self.run_started_at = None;
                self.status = if stopped {
                    "Command stopped".to_owned()
                } else if succeeded {
                    "Command completed".to_owned()
                } else {
                    "Command failed".to_owned()
                };
            }
            ServerEvent::ShellFailed {
                command,
                message,
                elapsed_ms,
            } => {
                effects.push(Effect::Commit(TranscriptEntry {
                    kind: EntryKind::Command,
                    text: format!(
                        "! {command}\n× could not start command · {}\n{message}",
                        format_elapsed(elapsed_ms)
                    ),
                    time: None,
                }));
                self.current_shell = None;
                self.busy = false;
                self.run_started_at = None;
                self.status = "Command failed".to_owned();
            }
            ServerEvent::Activity { item } => {
                let was_following_tail =
                    self.activity.is_empty() || self.activity_scroll >= self.activity.len() - 1;
                let existing = self.activity.iter().position(|entry| entry.id == item.id);
                if existing.is_none() && !self.current_assistant.trim().is_empty() {
                    effects.push(Effect::Commit(TranscriptEntry {
                        kind: EntryKind::Assistant,
                        text: std::mem::take(&mut self.current_assistant),
                        time: None,
                    }));
                }

                if let Some(index) = existing {
                    self.activity[index] = item.clone();
                } else {
                    self.activity.push(item.clone());
                    effects.push(Effect::Commit(activity_entry(&item, true)));
                    if was_following_tail {
                        self.activity_scroll = self.activity.len() - 1;
                        self.activity_detail_scroll = 0;
                    }
                }

                if existing.is_some()
                    && matches!(item.phase, ActivityPhase::Completed | ActivityPhase::Failed)
                {
                    effects.push(Effect::Commit(activity_entry(&item, false)));
                }
                self.status = match item.phase {
                    ActivityPhase::Running => format!("Running {}", item.name),
                    ActivityPhase::Completed => format!("Finished {}", item.name),
                    ActivityPhase::Failed => format!("{} failed", item.name),
                    ActivityPhase::System => item.name.clone(),
                };
            }
            ServerEvent::RunCompleted {
                output,
                session_id,
                usage,
            } => {
                let assistant = if self.current_assistant.trim().is_empty() {
                    output
                } else {
                    std::mem::take(&mut self.current_assistant)
                };
                if !assistant.trim().is_empty() {
                    effects.push(Effect::Commit(TranscriptEntry {
                        kind: EntryKind::Assistant,
                        text: assistant,
                        time: None,
                    }));
                }
                self.busy = false;
                self.current_shell = None;
                self.run_started_at = None;
                if let Some(id) = session_id {
                    self.session_id = Some(id.clone());
                    self.status = format!("Saved {}", short_id(&id));
                } else {
                    self.status = "Ready".to_owned();
                }
                if let Some(usage) = usage {
                    if usage.prompt_tokens.is_some() {
                        self.context_used = usage.prompt_tokens;
                    }
                    let _ = usage.completion_tokens;
                    let _ = usage.total_tokens;
                }
            }
            ServerEvent::RunStopped { message } => {
                if !self.current_assistant.trim().is_empty() {
                    effects.push(Effect::Commit(TranscriptEntry {
                        kind: EntryKind::Assistant,
                        text: std::mem::take(&mut self.current_assistant),
                        time: None,
                    }));
                }
                effects.push(Effect::Commit(TranscriptEntry {
                    kind: EntryKind::System,
                    text: message,
                    time: None,
                }));
                self.busy = false;
                self.current_shell = None;
                self.run_started_at = None;
                self.status = "Run stopped".to_owned();
            }
            ServerEvent::RunFailed { message } => {
                if !self.current_assistant.trim().is_empty() {
                    effects.push(Effect::Commit(TranscriptEntry {
                        kind: EntryKind::Assistant,
                        text: std::mem::take(&mut self.current_assistant),
                        time: None,
                    }));
                }
                effects.push(Effect::Commit(TranscriptEntry {
                    kind: EntryKind::Error,
                    text: message,
                    time: None,
                }));
                self.busy = false;
                self.current_shell = None;
                self.run_started_at = None;
                self.status = "Error".to_owned();
            }
            ServerEvent::Status {
                message,
                busy,
                queue_len,
                context_used,
            } => {
                self.status = message;
                if let Some(busy) = busy {
                    self.busy = busy;
                    if busy && self.run_started_at.is_none() {
                        self.run_started_at = Some(Instant::now());
                    }
                }
                if let Some(queue_len) = queue_len {
                    self.queue_len = queue_len;
                }
                if context_used.is_some() {
                    self.context_used = context_used;
                }
            }
            ServerEvent::Approval {
                id,
                title,
                message,
                risky,
            } => {
                self.approval = Some(ApprovalState {
                    id,
                    title,
                    message,
                    risky,
                });
                self.status = "Waiting for approval".to_owned();
            }
            ServerEvent::Modal { title, body } => {
                self.modal = Some(ModalState {
                    title,
                    body,
                    scroll: 0,
                });
            }
            ServerEvent::SessionPicker { title, sessions } => {
                self.picker = Some(PickerState {
                    title: title.unwrap_or_else(|| "Saved sessions".to_owned()),
                    sessions,
                    selected: 0,
                    scroll: 0,
                });
            }
            ServerEvent::ModelPicker {
                title,
                current_model,
                endpoint_label,
                models,
                notice,
            } => {
                let selected = models
                    .iter()
                    .position(|model| model.id == current_model)
                    .unwrap_or(0);
                self.model_picker = Some(ModelPickerState {
                    title: title.unwrap_or_else(|| "Select model for this session".to_owned()),
                    current_model,
                    endpoint_label,
                    models,
                    query: String::new(),
                    selected,
                    scroll: 0,
                    notice,
                });
            }
            ServerEvent::ToggleActivity => {
                self.activity_open = !self.activity_open;
                self.activity_scroll = self.activity.len().saturating_sub(1);
                self.activity_detail_scroll = 0;
            }
            ServerEvent::Clear => effects.push(Effect::Clear),
            ServerEvent::Quit => {
                self.should_quit = true;
                effects.push(Effect::Quit);
            }
        }
        effects
    }

    pub fn tick(&mut self) {
        self.spinner_tick = self.spinner_tick.wrapping_add(1);
    }

    pub fn elapsed(&self) -> Duration {
        self.run_started_at
            .map(|started| started.elapsed())
            .unwrap_or_default()
    }

    pub fn spinner(&self) -> &'static str {
        const FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        FRAMES[(self.spinner_tick / 2) % FRAMES.len()]
    }

    pub fn slash_matches(&self) -> Vec<slash::SlashMatch> {
        if self.slash_dismissed {
            Vec::new()
        } else {
            slash::matches(&self.commands, &self.prompt)
        }
    }

    pub fn slash_open(&self) -> bool {
        self.prompt.starts_with('/') && !self.slash_dismissed && !self.slash_matches().is_empty()
    }

    pub fn desired_height(&self, terminal_height: u16) -> u16 {
        // A full-height inline viewport is deliberate.  It gives Arivu one
        // continuous black canvas like the regular Grok inline UI, while the
        // inline terminal still inserts finalized messages into native
        // scrollback above this live region.
        //
        // Do not reserve a terminal row here: `Viewport::Inline` knows how to
        // borrow and restore a row when `insert_before` commits content from a
        // viewport that fills the screen.
        terminal_height.max(1)
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Vec<ClientEvent> {
        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return Vec::new();
        }
        if self.approval.is_some() {
            return self.handle_approval_key(key);
        }
        if self.picker.is_some() {
            return self.handle_picker_key(key);
        }
        if self.model_picker.is_some() {
            return self.handle_model_picker_key(key);
        }
        if self.modal.is_some() {
            self.handle_modal_key(key);
            return Vec::new();
        }
        if self.activity_open && self.handle_activity_key(key) {
            return Vec::new();
        }

        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('c') => return self.handle_interrupt(),
                KeyCode::Char('q') => return self.handle_quit_shortcut(),
                KeyCode::Char('p') => {
                    self.prompt = "/".to_owned();
                    self.prompt_cursor = 1;
                    self.slash_selected = 0;
                    self.slash_dismissed = false;
                    return Vec::new();
                }
                KeyCode::Char('g') => {
                    self.activity_open = !self.activity_open;
                    self.activity_scroll = self.activity.len().saturating_sub(1);
                    self.activity_detail_scroll = 0;
                    return Vec::new();
                }
                KeyCode::Char('s') => {
                    return vec![ClientEvent::Submit {
                        value: "/sessions --pick".to_owned(),
                    }];
                }
                KeyCode::Char('l') => {
                    return vec![ClientEvent::Submit {
                        value: "/clear".to_owned(),
                    }];
                }
                KeyCode::Char('a') => {
                    self.prompt_cursor = 0;
                    return Vec::new();
                }
                KeyCode::Char('e') => {
                    self.prompt_cursor = self.prompt.chars().count();
                    return Vec::new();
                }
                KeyCode::Char('u') => {
                    let byte = byte_index(&self.prompt, self.prompt_cursor);
                    self.prompt.replace_range(..byte, "");
                    self.prompt_cursor = 0;
                    self.after_prompt_edit();
                    return Vec::new();
                }
                KeyCode::Char('w') => {
                    self.delete_previous_word();
                    return Vec::new();
                }
                _ => return Vec::new(),
            }
        }

        match key.code {
            KeyCode::Esc => {
                if self.slash_open() {
                    self.slash_dismissed = true;
                } else if self.busy {
                    return vec![ClientEvent::Stop];
                }
            }
            KeyCode::Enter => {
                if key.modifiers.contains(KeyModifiers::SHIFT) {
                    self.insert_text("\n");
                } else {
                    return self.submit_prompt();
                }
            }
            KeyCode::Tab => {
                if self.slash_open() {
                    self.accept_slash(false);
                } else {
                    self.insert_text("    ");
                }
            }
            KeyCode::BackTab => {
                if self.slash_open() {
                    self.slash_selected = self.slash_selected.saturating_sub(1);
                }
            }
            KeyCode::Up => {
                if self.slash_open() {
                    self.slash_selected = self.slash_selected.saturating_sub(1);
                } else {
                    self.navigate_history(-1);
                }
            }
            KeyCode::Down => {
                if self.slash_open() {
                    let last = self.slash_matches().len().saturating_sub(1);
                    self.slash_selected = (self.slash_selected + 1).min(last);
                } else {
                    self.navigate_history(1);
                }
            }
            KeyCode::Left => self.prompt_cursor = self.prompt_cursor.saturating_sub(1),
            KeyCode::Right => {
                self.prompt_cursor = (self.prompt_cursor + 1).min(self.prompt.chars().count())
            }
            KeyCode::Home => self.prompt_cursor = 0,
            KeyCode::End => self.prompt_cursor = self.prompt.chars().count(),
            KeyCode::Backspace => self.delete_before_cursor(),
            KeyCode::Delete => self.delete_at_cursor(),
            KeyCode::PageUp => {
                self.activity_open = true;
                self.activity_scroll = self.activity_scroll.saturating_sub(5);
            }
            KeyCode::Char(character) => self.insert_text(&character.to_string()),
            _ => {}
        }
        Vec::new()
    }

    pub fn handle_paste(&mut self, value: &str) {
        if self.approval.is_none()
            && self.modal.is_none()
            && self.picker.is_none()
            && self.model_picker.is_none()
        {
            self.insert_text(value);
        }
    }

    fn handle_approval_key(&mut self, key: KeyEvent) -> Vec<ClientEvent> {
        let approved = match key.code {
            KeyCode::Char('1' | 'y' | 'Y') | KeyCode::Enter => Some(true),
            KeyCode::Char('2' | 'n' | 'N') | KeyCode::Esc => Some(false),
            _ => None,
        };
        let Some(approved) = approved else {
            return Vec::new();
        };
        let approval = self.approval.take().expect("approval exists");
        self.status = if approved {
            "Approval granted".to_owned()
        } else {
            "Approval denied".to_owned()
        };
        vec![ClientEvent::ApprovalResponse {
            id: approval.id,
            approved,
        }]
    }

    fn handle_picker_key(&mut self, key: KeyEvent) -> Vec<ClientEvent> {
        let picker = self.picker.as_mut().expect("picker exists");
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => self.picker = None,
            KeyCode::Up | KeyCode::Char('k') => {
                picker.selected = picker.selected.saturating_sub(1);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                picker.selected =
                    (picker.selected + 1).min(picker.sessions.len().saturating_sub(1));
            }
            KeyCode::PageUp => picker.selected = picker.selected.saturating_sub(5),
            KeyCode::PageDown => {
                picker.selected =
                    (picker.selected + 5).min(picker.sessions.len().saturating_sub(1));
            }
            KeyCode::Enter => {
                if let Some(session) = picker.sessions.get(picker.selected) {
                    let id = session.id.clone();
                    self.picker = None;
                    return vec![ClientEvent::ResumeSession { id }];
                }
            }
            _ => {}
        }
        Vec::new()
    }

    fn handle_model_picker_key(&mut self, key: KeyEvent) -> Vec<ClientEvent> {
        let picker = self.model_picker.as_mut().expect("model picker exists");
        match key.code {
            KeyCode::Esc => self.model_picker = None,
            KeyCode::Up => picker.selected = picker.selected.saturating_sub(1),
            KeyCode::Down => {
                picker.selected =
                    (picker.selected + 1).min(picker.filtered_indexes().len().saturating_sub(1));
            }
            KeyCode::PageUp => picker.selected = picker.selected.saturating_sub(5),
            KeyCode::PageDown => {
                picker.selected =
                    (picker.selected + 5).min(picker.filtered_indexes().len().saturating_sub(1));
            }
            KeyCode::Backspace => {
                picker.query.pop();
                picker.clamp_selection();
            }
            KeyCode::Char(character) => {
                picker.query.push(character);
                picker.clamp_selection();
            }
            KeyCode::Enter => {
                let id = picker
                    .filtered_indexes()
                    .get(picker.selected)
                    .and_then(|index| picker.models.get(*index))
                    .map(|model| model.id.clone());
                if let Some(id) = id {
                    self.model_picker = None;
                    return vec![ClientEvent::SelectModel { id }];
                }
            }
            _ => {}
        }
        Vec::new()
    }

    fn handle_modal_key(&mut self, key: KeyEvent) {
        let modal = self.modal.as_mut().expect("modal exists");
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => self.modal = None,
            KeyCode::Up | KeyCode::Char('k') => modal.scroll = modal.scroll.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => modal.scroll = modal.scroll.saturating_add(1),
            KeyCode::PageUp => modal.scroll = modal.scroll.saturating_sub(8),
            KeyCode::PageDown => modal.scroll = modal.scroll.saturating_add(8),
            KeyCode::Home => modal.scroll = 0,
            _ => {}
        }
    }

    fn handle_activity_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Esc => {
                self.activity_open = false;
                true
            }
            KeyCode::Char('g') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.activity_open = false;
                true
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.activity_scroll = self.activity_scroll.saturating_sub(1);
                self.activity_detail_scroll = 0;
                true
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.activity_scroll =
                    (self.activity_scroll + 1).min(self.activity.len().saturating_sub(1));
                self.activity_detail_scroll = 0;
                true
            }
            KeyCode::PageUp => {
                self.activity_detail_scroll = self.activity_detail_scroll.saturating_sub(5);
                true
            }
            KeyCode::PageDown => {
                self.activity_detail_scroll = self.activity_detail_scroll.saturating_add(5);
                true
            }
            KeyCode::Home => {
                self.activity_detail_scroll = 0;
                true
            }
            _ => false,
        }
    }

    fn handle_interrupt(&mut self) -> Vec<ClientEvent> {
        // A terminal command is an explicit foreground process. Ctrl+C should
        // always reach it, even when the user has started drafting the next
        // queued prompt.
        if self.current_shell.is_some() && self.busy {
            return vec![ClientEvent::Stop];
        }
        if !self.prompt.is_empty() {
            self.prompt.clear();
            self.prompt_cursor = 0;
            self.after_prompt_edit();
            self.status = "Draft cleared".to_owned();
            return Vec::new();
        }
        if self.busy {
            return vec![ClientEvent::Stop];
        }
        self.handle_quit_shortcut()
    }

    fn handle_quit_shortcut(&mut self) -> Vec<ClientEvent> {
        let now = Instant::now();
        if self.quit_armed_until.is_some_and(|until| now <= until) {
            self.should_quit = true;
            return vec![ClientEvent::Quit];
        }
        self.quit_armed_until = Some(now + Duration::from_secs(2));
        self.status = "Press Ctrl+Q again to quit".to_owned();
        Vec::new()
    }

    fn submit_prompt(&mut self) -> Vec<ClientEvent> {
        if self.slash_open() {
            let exact = self
                .slash_matches()
                .get(self.slash_selected)
                .and_then(|matched| self.commands.get(matched.command_index))
                .is_some_and(|command| command_matches_prompt(command, &self.prompt));
            if !exact {
                if self.accept_slash(true) {
                    return self.take_and_submit_prompt();
                }
                return Vec::new();
            }
        }
        self.take_and_submit_prompt()
    }

    fn take_and_submit_prompt(&mut self) -> Vec<ClientEvent> {
        let value = self.prompt.trim().to_owned();
        if value.is_empty() {
            return Vec::new();
        }
        self.prompt_history.push(value.clone());
        self.history_cursor = None;
        self.prompt.clear();
        self.prompt_cursor = 0;
        self.after_prompt_edit();
        vec![ClientEvent::Submit { value }]
    }

    fn accept_slash(&mut self, execute_if_complete: bool) -> bool {
        let Some(command) =
            slash::selected(&self.commands, &self.prompt, self.slash_selected).cloned()
        else {
            return false;
        };
        self.prompt = command.command.clone();
        if command.args_required || (!execute_if_complete && command.takes_args) {
            self.prompt.push(' ');
        }
        self.prompt_cursor = self.prompt.chars().count();
        self.slash_dismissed = command.args_required;
        execute_if_complete && !command.args_required
    }

    fn insert_text(&mut self, value: &str) {
        let byte = byte_index(&self.prompt, self.prompt_cursor);
        self.prompt.insert_str(byte, value);
        self.prompt_cursor += value.chars().count();
        self.after_prompt_edit();
    }

    fn delete_before_cursor(&mut self) {
        if self.prompt_cursor == 0 {
            return;
        }
        let start = byte_index(&self.prompt, self.prompt_cursor - 1);
        let end = byte_index(&self.prompt, self.prompt_cursor);
        self.prompt.replace_range(start..end, "");
        self.prompt_cursor -= 1;
        self.after_prompt_edit();
    }

    fn delete_at_cursor(&mut self) {
        if self.prompt_cursor >= self.prompt.chars().count() {
            return;
        }
        let start = byte_index(&self.prompt, self.prompt_cursor);
        let end = byte_index(&self.prompt, self.prompt_cursor + 1);
        self.prompt.replace_range(start..end, "");
        self.after_prompt_edit();
    }

    fn delete_previous_word(&mut self) {
        let characters = self.prompt.chars().collect::<Vec<_>>();
        let mut start = self.prompt_cursor.min(characters.len());
        while start > 0 && characters[start - 1].is_whitespace() {
            start -= 1;
        }
        while start > 0 && !characters[start - 1].is_whitespace() {
            start -= 1;
        }
        let from = byte_index(&self.prompt, start);
        let to = byte_index(&self.prompt, self.prompt_cursor);
        self.prompt.replace_range(from..to, "");
        self.prompt_cursor = start;
        self.after_prompt_edit();
    }

    fn navigate_history(&mut self, direction: i32) {
        if self.prompt_history.is_empty() {
            return;
        }
        let next = match (self.history_cursor, direction) {
            (None, value) if value < 0 => Some(self.prompt_history.len() - 1),
            (Some(index), value) if value < 0 => Some(index.saturating_sub(1)),
            (Some(index), _) if index + 1 < self.prompt_history.len() => Some(index + 1),
            (Some(_), _) => None,
            (None, _) => None,
        };
        self.history_cursor = next;
        self.prompt = next
            .and_then(|index| self.prompt_history.get(index).cloned())
            .unwrap_or_default();
        self.prompt_cursor = self.prompt.chars().count();
        self.after_prompt_edit();
    }

    fn after_prompt_edit(&mut self) {
        self.slash_selected = 0;
        self.slash_dismissed = false;
    }
}

fn activity_entry(item: &ActivityItem, starting: bool) -> TranscriptEntry {
    let (kind, glyph, label) = if starting {
        (EntryKind::System, "◆", "Running")
    } else {
        match item.phase {
            ActivityPhase::Failed => (EntryKind::Error, "×", "Failed"),
            _ => (EntryKind::System, "✓", "Completed"),
        }
    };
    let detail = compact_detail(&item.detail, 360);
    TranscriptEntry {
        kind,
        text: if detail.is_empty() {
            format!("{glyph} {label} {}", item.name)
        } else {
            format!("{glyph} {label} {}\n  {detail}", item.name)
        },
        time: None,
    }
}

fn compact_detail(value: &str, max: usize) -> String {
    let compact = value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if compact.chars().count() <= max {
        compact
    } else {
        format!(
            "{}…",
            compact
                .chars()
                .take(max.saturating_sub(1))
                .collect::<String>()
        )
    }
}

fn shell_entry(
    command: String,
    output: String,
    exit_code: Option<i32>,
    signal: Option<String>,
    elapsed_ms: u64,
    stopped: bool,
    output_truncated: bool,
) -> TranscriptEntry {
    let mut lines = vec![format!("! {command}")];
    if output.trim().is_empty() {
        lines.push("(no output)".to_owned());
    } else {
        lines.push(output);
    }
    if output_truncated && !lines.iter().any(|line| line.contains("output truncated")) {
        lines.push("… [output truncated] …".to_owned());
    }
    let outcome = if stopped {
        signal
            .map(|signal| format!("■ stopped ({signal})"))
            .unwrap_or_else(|| "■ stopped".to_owned())
    } else if let Some(signal) = signal {
        format!("× signal {signal}")
    } else if exit_code == Some(0) {
        "✓ exit 0".to_owned()
    } else if let Some(code) = exit_code {
        format!("× exit {code}")
    } else {
        "× command ended without an exit code".to_owned()
    };
    lines.push(format!("{outcome} · {}", format_elapsed(elapsed_ms)));
    TranscriptEntry {
        kind: EntryKind::Command,
        text: lines.join("\n"),
        time: None,
    }
}

fn format_elapsed(elapsed_ms: u64) -> String {
    if elapsed_ms < 1_000 {
        format!("{elapsed_ms}ms")
    } else {
        format!("{:.1}s", elapsed_ms as f64 / 1_000.0)
    }
}

fn utf8_prefix_boundary(value: &str, maximum: usize) -> usize {
    let mut end = maximum.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn command_matches_prompt(command: &CommandSpec, prompt: &str) -> bool {
    let typed = prompt.split_whitespace().next().unwrap_or_default();
    typed.eq_ignore_ascii_case(
        command
            .command
            .split_whitespace()
            .next()
            .unwrap_or_default(),
    ) || command
        .aliases
        .iter()
        .any(|alias| typed.eq_ignore_ascii_case(alias))
}

fn byte_index(value: &str, character_index: usize) -> usize {
    value
        .char_indices()
        .nth(character_index)
        .map(|(index, _)| index)
        .unwrap_or(value.len())
}

fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(name: &str, takes_args: bool, args_required: bool) -> CommandSpec {
        CommandSpec {
            command: format!("/{name}"),
            usage: format!("/{name}"),
            title: name.to_owned(),
            description: format!("{name} command"),
            aliases: Vec::new(),
            takes_args,
            args_required,
        }
    }

    fn app() -> App {
        App::from_init(InitData {
            project_name: "arivu".to_owned(),
            cwd: "/tmp/arivu".to_owned(),
            root: "/tmp/arivu".to_owned(),
            branch: Some("main".to_owned()),
            dirty: false,
            model: "test/model".to_owned(),
            trust: "ask".to_owned(),
            session_id: None,
            context_used: Some(10),
            context_total: Some(100),
            transcript: Vec::new(),
            activity: Vec::new(),
            commands: vec![
                command("help", false, false),
                command("status", false, false),
                command("resume", true, true),
            ],
        })
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn ctrl_p_opens_the_slash_picker() {
        let mut app = app();
        app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL));

        assert_eq!(app.prompt, "/");
        assert!(app.slash_open());
        assert_eq!(app.slash_matches().len(), 3);
    }

    #[test]
    fn fuzzy_slash_selection_executes_the_selected_command() {
        let mut app = app();
        for character in "/sta".chars() {
            app.handle_key(key(KeyCode::Char(character)));
        }
        let events = app.handle_key(key(KeyCode::Enter));

        match events.as_slice() {
            [ClientEvent::Submit { value }] => assert_eq!(value, "/status"),
            _ => panic!("expected a slash-command submission"),
        }
        assert!(app.prompt.is_empty());
    }

    #[test]
    fn slash_commands_remain_available_after_a_reply_completes() {
        let mut app = app();
        let _ = app.apply_server_event(ServerEvent::RunStarted {
            status: "Working".to_owned(),
        });
        let _ = app.apply_server_event(ServerEvent::AssistantDelta {
            delta: "Done.".to_owned(),
        });
        let _ = app.apply_server_event(ServerEvent::RunCompleted {
            output: "Done.".to_owned(),
            session_id: Some("session-1".to_owned()),
            usage: None,
        });

        for character in "/status".chars() {
            app.handle_key(key(KeyCode::Char(character)));
        }
        let events = app.handle_key(key(KeyCode::Enter));

        match events.as_slice() {
            [ClientEvent::Submit { value }] => assert_eq!(value, "/status"),
            _ => panic!("expected /status after the completed reply"),
        }
        assert!(!app.busy);
        assert!(app.prompt.is_empty());
    }

    #[test]
    fn argument_commands_complete_without_executing() {
        let mut app = app();
        for character in "/res".chars() {
            app.handle_key(key(KeyCode::Char(character)));
        }
        let events = app.handle_key(key(KeyCode::Enter));

        assert!(events.is_empty());
        assert_eq!(app.prompt, "/resume ");
    }

    #[test]
    fn model_picker_filters_selects_and_cancels_without_affecting_session_picker() {
        let mut app = app();
        let _ = app.apply_server_event(ServerEvent::ModelPicker {
            title: Some("Select model".to_owned()),
            current_model: "test/model".to_owned(),
            endpoint_label: "https://example.test/v1".to_owned(),
            models: vec![
                ModelChoice {
                    id: "test/model".to_owned(),
                    label: "test/model".to_owned(),
                    description: "current model".to_owned(),
                },
                ModelChoice {
                    id: "jqk-target".to_owned(),
                    label: "jqk-target".to_owned(),
                    description: String::new(),
                },
            ],
            notice: String::new(),
        });
        app.handle_key(key(KeyCode::Down));
        assert_eq!(app.model_picker.as_ref().expect("picker").selected, 1);
        app.handle_key(key(KeyCode::Up));
        assert_eq!(app.model_picker.as_ref().expect("picker").selected, 0);
        for character in "jqk".chars() {
            app.handle_key(key(KeyCode::Char(character)));
        }
        assert_eq!(
            app.model_picker
                .as_ref()
                .expect("picker")
                .filtered_indexes(),
            vec![1]
        );
        let events = app.handle_key(key(KeyCode::Enter));
        match events.as_slice() {
            [ClientEvent::SelectModel { id }] => assert_eq!(id, "jqk-target"),
            _ => panic!("expected a model selection"),
        }
        assert!(app.model_picker.is_none());

        let _ = app.apply_server_event(ServerEvent::SessionPicker {
            title: None,
            sessions: vec![SessionChoice {
                id: "session-1".to_owned(),
                label: "Session".to_owned(),
                description: String::new(),
            }],
        });
        let events = app.handle_key(key(KeyCode::Enter));
        match events.as_slice() {
            [ClientEvent::ResumeSession { id }] => assert_eq!(id, "session-1"),
            _ => panic!("expected a session selection"),
        }

        let _ = app.apply_server_event(ServerEvent::ModelPicker {
            title: None,
            current_model: "test/model".to_owned(),
            endpoint_label: String::new(),
            models: Vec::new(),
            notice: String::new(),
        });
        app.handle_key(key(KeyCode::Esc));
        assert!(app.model_picker.is_none());
    }

    #[test]
    fn approvals_are_resolved_without_leaking_keys_into_the_prompt() {
        let mut app = app();
        app.approval = Some(ApprovalState {
            id: "approval-1".to_owned(),
            title: "Run command".to_owned(),
            message: "npm test".to_owned(),
            risky: true,
        });
        let events = app.handle_key(key(KeyCode::Char('y')));

        match events.as_slice() {
            [ClientEvent::ApprovalResponse { id, approved }] => {
                assert_eq!(id, "approval-1");
                assert!(*approved);
            }
            _ => panic!("expected an approval response"),
        }
        assert!(app.approval.is_none());
        assert!(app.prompt.is_empty());
    }

    #[test]
    fn unicode_prompt_edits_do_not_split_characters() {
        let mut app = app();
        app.handle_paste("ask 🔵");
        app.handle_key(key(KeyCode::Backspace));

        assert_eq!(app.prompt, "ask ");
        assert_eq!(app.prompt_cursor, 4);
    }

    #[test]
    fn live_viewport_owns_the_entire_terminal_height() {
        let idle = app();

        assert_eq!(idle.desired_height(48), 48);
        assert_eq!(idle.desired_height(1), 1);
        assert_eq!(idle.desired_height(0), 1);

        let mut busy = app();
        busy.current_assistant = "streaming response".to_owned();
        busy.activity_open = true;
        assert_eq!(busy.desired_height(48), 48);
    }

    #[test]
    fn activity_updates_follow_the_tail_only_until_the_user_moves_away() {
        let mut app = app();
        app.activity_open = true;
        for index in 0..2 {
            let _ = app.apply_server_event(ServerEvent::Activity {
                item: ActivityItem {
                    id: format!("tool-{index}"),
                    phase: ActivityPhase::Running,
                    name: format!("tool {index}"),
                    detail: String::new(),
                },
            });
        }
        assert_eq!(app.activity_scroll, 1);

        app.activity_scroll = 0;
        let _ = app.apply_server_event(ServerEvent::Activity {
            item: ActivityItem {
                id: "tool-2".to_owned(),
                phase: ActivityPhase::Running,
                name: "tool 2".to_owned(),
                detail: String::new(),
            },
        });
        assert_eq!(app.activity_scroll, 0);

        app.handle_key(key(KeyCode::PageDown));
        assert_eq!(app.activity_scroll, 0);
        assert_eq!(app.activity_detail_scroll, 5);
    }

    #[test]
    fn shell_lifecycle_streams_then_commits_a_compact_nonzero_result() {
        let mut app = app();
        let _ = app.apply_server_event(ServerEvent::ShellStarted {
            command: "printf out".to_owned(),
        });
        let _ = app.apply_server_event(ServerEvent::ShellOutput {
            stream: ShellOutputStream::Stdout,
            delta: "out".to_owned(),
        });
        let _ = app.apply_server_event(ServerEvent::ShellOutput {
            stream: ShellOutputStream::Stderr,
            delta: "err".to_owned(),
        });

        assert!(app.busy);
        assert_eq!(
            app.current_shell.as_ref().expect("live shell").output,
            "stdout:\nout\nstderr:\nerr"
        );

        let effects = app.apply_server_event(ServerEvent::ShellCompleted {
            command: "printf out".to_owned(),
            output: "stdout:\nout\nstderr:\nerr".to_owned(),
            exit_code: Some(7),
            signal: None,
            elapsed_ms: 12,
            stopped: false,
            output_truncated: false,
        });

        assert!(!app.busy);
        assert!(app.current_shell.is_none());
        match effects.as_slice() {
            [Effect::Commit(entry)] => {
                assert!(matches!(entry.kind, EntryKind::Command));
                assert!(entry.text.contains("! printf out"));
                assert!(entry.text.contains("stdout:\nout"));
                assert!(entry.text.contains("stderr:\nerr"));
                assert!(entry.text.contains("× exit 7 · 12ms"));
            }
            _ => panic!("expected a command scrollback entry"),
        }
    }

    #[test]
    fn live_shell_buffer_is_bounded_with_a_visible_marker() {
        let mut shell = LiveShellState::new("yes".to_owned());
        shell.append(
            ShellOutputStream::Stdout,
            &"x".repeat(MAX_LIVE_SHELL_OUTPUT_BYTES + 10),
        );

        assert!(shell.output.len() <= MAX_LIVE_SHELL_OUTPUT_BYTES);
        assert!(shell.output.contains("live output capped"));
    }

    #[test]
    fn ctrl_c_stops_a_running_shell_even_with_a_queued_draft() {
        let mut app = app();
        let _ = app.apply_server_event(ServerEvent::ShellStarted {
            command: "sleep 10".to_owned(),
        });
        app.prompt = "next prompt".to_owned();
        app.prompt_cursor = app.prompt.chars().count();

        let events = app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

        assert!(matches!(events.as_slice(), [ClientEvent::Stop]));
        assert_eq!(app.prompt, "next prompt");
    }

    #[test]
    fn stopped_shell_result_keeps_the_termination_signal_visible() {
        let entry = shell_entry(
            "sleep 10".to_owned(),
            String::new(),
            None,
            Some("SIGTERM".to_owned()),
            1_000,
            true,
            false,
        );

        assert!(entry.text.contains("■ stopped (SIGTERM) · 1.0s"));
    }
}
