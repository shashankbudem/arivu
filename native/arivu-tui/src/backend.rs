use std::io::{self, Write};

use ratatui::backend::{Backend, ClearType, CrosstermBackend, WindowSize};
use ratatui::buffer::Cell;
use ratatui::layout::{Position, Size};

/// Crossterm's cursor-position query depends on a terminal DSR reply. Some
/// shells, SSH relays, IDE PTYs, and test harnesses do not answer it, which
/// would otherwise make an inline TUI fail before its first frame. Arivu starts
/// from a cursor position it explicitly sets and tracks that position locally.
///
/// The renderer and terminal manipulation still delegate to Crossterm; only
/// `get_cursor_position` is made deterministic.
pub struct TrackedCrosstermBackend<W: Write> {
    inner: CrosstermBackend<W>,
    cursor: Position,
}

impl<W: Write> TrackedCrosstermBackend<W> {
    pub fn new(writer: W, cursor: Position) -> Self {
        Self {
            inner: CrosstermBackend::new(writer),
            cursor,
        }
    }
}

impl<W: Write> Write for TrackedCrosstermBackend<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.inner.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        Write::flush(&mut self.inner)
    }
}

impl<W: Write> Backend for TrackedCrosstermBackend<W> {
    fn draw<'a, I>(&mut self, content: I) -> io::Result<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        let mut final_position = None;
        self.inner.draw(content.inspect(|(x, y, _)| {
            final_position = Some(Position { x: *x, y: *y });
        }))?;
        if let Some(position) = final_position {
            self.cursor = position;
        }
        Ok(())
    }

    fn append_lines(&mut self, count: u16) -> io::Result<()> {
        self.inner.append_lines(count)?;
        let height = self.inner.size()?.height;
        self.cursor = Position {
            x: 0,
            y: self
                .cursor
                .y
                .saturating_add(count)
                .min(height.saturating_sub(1)),
        };
        Ok(())
    }

    fn hide_cursor(&mut self) -> io::Result<()> {
        self.inner.hide_cursor()
    }

    fn show_cursor(&mut self) -> io::Result<()> {
        self.inner.show_cursor()
    }

    fn get_cursor_position(&mut self) -> io::Result<Position> {
        Ok(self.cursor)
    }

    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> {
        let position = position.into();
        self.inner.set_cursor_position(position)?;
        self.cursor = position;
        Ok(())
    }

    fn clear(&mut self) -> io::Result<()> {
        self.inner.clear()
    }

    fn clear_region(&mut self, clear_type: ClearType) -> io::Result<()> {
        self.inner.clear_region(clear_type)
    }

    fn size(&self) -> io::Result<Size> {
        self.inner.size()
    }

    fn window_size(&mut self) -> io::Result<WindowSize> {
        self.inner.window_size()
    }

    fn flush(&mut self) -> io::Result<()> {
        Backend::flush(&mut self.inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_cursor_moves_update_the_tracked_position() {
        let mut backend = TrackedCrosstermBackend::new(Vec::<u8>::new(), Position::new(0, 0));

        backend
            .set_cursor_position(Position::new(12, 7))
            .expect("cursor move succeeds");

        assert_eq!(
            backend.get_cursor_position().expect("position is tracked"),
            Position::new(12, 7)
        );
    }
}
