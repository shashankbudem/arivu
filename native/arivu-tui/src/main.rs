// Arivu-specific adaptation of Grok Build's inline pager lifecycle.
// Modified for a TypeScript backend protocol and deterministic cursor tracking.

mod app;
mod backend;
mod layout;
mod protocol;
mod scrollback;
mod slash;
mod theme;
mod ui;

use std::env;
use std::io::{self, BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use crossterm::cursor::{MoveTo, Show};
use crossterm::event::{self, DisableBracketedPaste, EnableBracketedPaste, Event};
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use ratatui::TerminalOptions;
use ratatui::Viewport;
use ratatui::backend::Backend;
use ratatui::layout::Position;
use xai_ratatui_inline::Terminal;

use app::{App, Effect};
use backend::TrackedCrosstermBackend;
use protocol::{ClientEvent, EntryKind, ServerEvent, TranscriptEntry};
use scrollback::{ArivuTerminal, commit_entry, commit_transcript, purge_screen};

enum Incoming {
    Event(ServerEvent),
    Disconnected,
    Error(String),
}

fn main() {
    if let Err(error) = run() {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), DisableBracketedPaste, Show);
        eprintln!("arivu-tui: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let (address, token) = parse_args()?;
    let mut writer = TcpStream::connect(&address)
        .with_context(|| format!("connect to Arivu backend at {address}"))?;
    writer.set_nodelay(true)?;
    send_event(
        &mut writer,
        &ClientEvent::Hello {
            token: token.clone(),
        },
    )?;

    let mut reader = BufReader::new(writer.try_clone()?);
    let first = read_server_event(&mut reader)?.context("backend closed before initialization")?;
    let ServerEvent::Init { data } = first else {
        bail!("backend sent an event before init");
    };
    let transcript = data.transcript.clone();
    let mut app = App::from_init(*data);
    let (incoming_tx, incoming_rx) = mpsc::channel();
    spawn_reader(reader, incoming_tx);

    let mut terminal = init_terminal(app.desired_height(terminal_height()?))?;
    commit_transcript(&mut terminal, transcript)?;
    sync_viewport_height(&mut terminal, &app)?;
    terminal.draw(|frame| ui::render(frame, &app))?;

    let mut next_tick = Instant::now() + Duration::from_millis(100);
    while !app.should_quit {
        let mut needs_draw = drain_backend_events(&incoming_rx, &mut terminal, &mut app)?;
        if app.should_quit {
            break;
        }

        let timeout = next_tick.saturating_duration_since(Instant::now());
        if event::poll(timeout.min(Duration::from_millis(50)))? {
            match event::read()? {
                Event::Key(key) => {
                    for outgoing in app.handle_key(key) {
                        send_event(&mut writer, &outgoing)?;
                    }
                    needs_draw = true;
                }
                Event::Paste(value) => {
                    app.handle_paste(&value);
                    needs_draw = true;
                }
                Event::Resize(_, _) => {
                    terminal.autoresize()?;
                    sync_viewport_height(&mut terminal, &app)?;
                    needs_draw = true;
                }
                _ => {}
            }
        }

        if Instant::now() >= next_tick {
            app.tick();
            next_tick = Instant::now() + Duration::from_millis(100);
            needs_draw |= app.busy;
        }
        if needs_draw {
            sync_viewport_height(&mut terminal, &app)?;
            terminal.draw(|frame| ui::render(frame, &app))?;
        }
    }

    restore_terminal(&mut terminal)?;
    Ok(())
}

fn parse_args() -> Result<(String, String)> {
    let mut args = env::args().skip(1);
    let mut address = None;
    let mut token = None;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--connect" => address = args.next(),
            "--token" => token = args.next(),
            "--version" | "-V" => {
                println!("arivu-tui {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "--help" | "-h" => {
                println!(
                    "Native Arivu terminal UI\n\nUsage: arivu-tui --connect HOST:PORT --token TOKEN"
                );
                std::process::exit(0);
            }
            _ => bail!("unknown argument: {argument}"),
        }
    }
    Ok((
        address.context("missing --connect")?,
        token.context("missing --token")?,
    ))
}

fn init_terminal(height: u16) -> io::Result<ArivuTerminal> {
    enable_raw_mode()?;
    let (_, rows) = crossterm::terminal::size()?;
    let initial_position = Position::new(0, rows.saturating_sub(1));
    execute!(
        io::stdout(),
        EnableBracketedPaste,
        MoveTo(initial_position.x, initial_position.y)
    )?;
    install_panic_restore_hook();
    let backend = TrackedCrosstermBackend::new(io::stdout(), initial_position);
    Terminal::with_options(
        backend,
        TerminalOptions {
            viewport: Viewport::Inline(height),
        },
    )
}

fn restore_terminal(terminal: &mut ArivuTerminal) -> io::Result<()> {
    terminal.clear()?;
    execute!(terminal.backend_mut(), DisableBracketedPaste)?;
    disable_raw_mode()?;
    terminal.show_cursor()?;
    std::io::Write::flush(terminal.backend_mut())?;
    Ok(())
}

fn install_panic_restore_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), DisableBracketedPaste, Show);
        previous(info);
    }));
}

fn spawn_reader(mut reader: BufReader<TcpStream>, sender: mpsc::Sender<Incoming>) {
    thread::spawn(move || {
        loop {
            match read_server_event(&mut reader) {
                Ok(Some(event)) => {
                    if sender.send(Incoming::Event(event)).is_err() {
                        return;
                    }
                }
                Ok(None) => {
                    let _ = sender.send(Incoming::Disconnected);
                    return;
                }
                Err(error) => {
                    let _ = sender.send(Incoming::Error(error.to_string()));
                    return;
                }
            }
        }
    });
}

fn read_server_event(reader: &mut BufReader<TcpStream>) -> Result<Option<ServerEvent>> {
    let mut line = String::new();
    let read = reader.read_line(&mut line)?;
    if read == 0 {
        return Ok(None);
    }
    let event = serde_json::from_str(line.trim_end())
        .with_context(|| format!("decode backend event: {}", truncate_for_error(&line)))?;
    Ok(Some(event))
}

fn send_event(writer: &mut TcpStream, event: &ClientEvent) -> Result<()> {
    serde_json::to_writer(&mut *writer, event)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn drain_backend_events(
    receiver: &Receiver<Incoming>,
    terminal: &mut ArivuTerminal,
    app: &mut App,
) -> Result<bool> {
    let mut changed = false;
    while let Ok(incoming) = receiver.try_recv() {
        changed = true;
        match incoming {
            Incoming::Event(event) => {
                let effects = app.apply_server_event(event);
                apply_effects(terminal, app, effects)?;
            }
            Incoming::Disconnected => {
                commit_entry(
                    terminal,
                    TranscriptEntry {
                        kind: EntryKind::Error,
                        text: "The Arivu backend disconnected.".to_owned(),
                        time: None,
                    },
                )?;
                app.status = "Backend disconnected".to_owned();
                app.should_quit = true;
            }
            Incoming::Error(message) => {
                commit_entry(
                    terminal,
                    TranscriptEntry {
                        kind: EntryKind::Error,
                        text: format!("Backend protocol error: {message}"),
                        time: None,
                    },
                )?;
                app.status = "Backend protocol error".to_owned();
            }
        }
    }
    Ok(changed)
}

fn apply_effects(terminal: &mut ArivuTerminal, app: &mut App, effects: Vec<Effect>) -> Result<()> {
    for effect in effects {
        match effect {
            Effect::Commit(entry) => commit_entry(terminal, entry)?,
            Effect::Reset(transcript) => {
                let height = app.desired_height(terminal_height()?);
                purge_screen(terminal, height)?;
                commit_transcript(terminal, transcript)?;
            }
            Effect::Clear => {
                let height = app.desired_height(terminal_height()?);
                purge_screen(terminal, height)?;
                app.status = "Visible transcript cleared".to_owned();
            }
            Effect::Quit => app.should_quit = true,
        }
    }
    Ok(())
}

fn sync_viewport_height(terminal: &mut ArivuTerminal, app: &App) -> io::Result<()> {
    let size = terminal.backend().size()?;
    let desired = app.desired_height(size.height);
    if terminal.viewport_area().height != desired {
        terminal.set_viewport_height(desired)?;
    }
    Ok(())
}

fn terminal_height() -> io::Result<u16> {
    crossterm::terminal::size().map(|(_, height)| height)
}

fn truncate_for_error(value: &str) -> String {
    const MAX: usize = 240;
    let compact = value.trim().replace('\n', " ");
    if compact.chars().count() <= MAX {
        compact
    } else {
        format!("{}…", compact.chars().take(MAX - 1).collect::<String>())
    }
}
