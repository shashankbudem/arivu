use ratatui::layout::Rect;

/// Shared outer spacing for both the live viewport and committed scrollback.
/// Two cells read as intentional breathing room at normal sizes, while the
/// one-cell fallback keeps narrow terminals useful.
pub fn outer_gutter(width: u16) -> u16 {
    if width >= 24 { 2 } else { 1 }
}

pub fn inset_x(area: Rect) -> Rect {
    let inset = outer_gutter(area.width).min(area.width.saturating_sub(1) / 2);
    Rect::new(
        area.x.saturating_add(inset),
        area.y,
        area.width.saturating_sub(inset.saturating_mul(2)),
        area.height,
    )
}

/// A full-height viewport benefits from a quiet first row, but very short
/// terminals need every row for usable controls and content.
pub fn top_breathing_rows(height: u16) -> u16 {
    u16::from(height >= 10)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn horizontal_inset_is_responsive_and_never_eliminates_content() {
        assert_eq!(inset_x(Rect::new(0, 0, 80, 4)), Rect::new(2, 0, 76, 4));
        assert_eq!(inset_x(Rect::new(0, 0, 12, 4)), Rect::new(1, 0, 10, 4));
        assert_eq!(inset_x(Rect::new(0, 0, 1, 4)), Rect::new(0, 0, 1, 4));
    }

    #[test]
    fn top_spacing_yields_to_short_terminals() {
        assert_eq!(top_breathing_rows(24), 1);
        assert_eq!(top_breathing_rows(10), 1);
        assert_eq!(top_breathing_rows(9), 0);
    }
}
