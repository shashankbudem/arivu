use ratatui::style::{Color, Modifier, Style};

pub const BACKGROUND: Color = Color::Rgb(0, 0, 0);
pub const FOREGROUND: Color = Color::Rgb(74, 224, 236);
pub const ACCENT: Color = Color::Rgb(0, 229, 255);
pub const ACCENT_BRIGHT: Color = Color::Rgb(134, 247, 255);
pub const MUTED: Color = Color::Rgb(45, 166, 180);
pub const DIM: Color = Color::Rgb(27, 112, 124);
pub const SUCCESS: Color = Color::Rgb(35, 214, 205);
pub const WARNING: Color = Color::Rgb(84, 211, 224);
pub const ERROR: Color = Color::Rgb(118, 237, 248);
pub const PANEL: Color = BACKGROUND;
pub const SELECTED: Color = Color::Rgb(0, 43, 50);

pub fn base() -> Style {
    Style::default().fg(FOREGROUND).bg(BACKGROUND)
}

pub fn accent() -> Style {
    base().fg(ACCENT)
}

pub fn accent_bold() -> Style {
    accent().add_modifier(Modifier::BOLD)
}

pub fn muted() -> Style {
    base().fg(MUTED)
}

pub fn dim() -> Style {
    base().fg(DIM)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_theme_is_true_black_with_cyan_text() {
        let style = base();

        assert_eq!(style.bg, Some(Color::Rgb(0, 0, 0)));
        assert_eq!(style.fg, Some(Color::Rgb(74, 224, 236)));
    }

    #[test]
    fn semantic_theme_layers_keep_black_backgrounds_and_cyan_hierarchy() {
        assert_eq!(PANEL, BACKGROUND);
        assert_eq!(muted().bg, Some(BACKGROUND));
        assert_eq!(dim().bg, Some(BACKGROUND));
        assert_eq!(accent().bg, Some(BACKGROUND));
        assert_eq!(accent_bold().bg, Some(BACKGROUND));
        assert_eq!(ACCENT, Color::Rgb(0, 229, 255));
        assert_eq!(MUTED, Color::Rgb(45, 166, 180));
        assert_eq!(DIM, Color::Rgb(27, 112, 124));
    }
}
