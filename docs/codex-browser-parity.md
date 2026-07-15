# Codex browser parity checklist

Reference build inspected locally: Codex desktop `150.0.7871.115` (2026-07-14).

This checklist records behavioral parity, not copied implementation. “Implemented” still
requires desktop smoke and interaction verification before the project is considered complete.

## Browser shell and navigation

- [x] Compact dark toolbar with back, forward, reload/stop, centered address/search field.
- [x] Site-security affordance and open-in-external-browser action.
- [x] Loading progress indicator and disabled navigation states.
- [x] URL normalization plus web search from the address bar.
- [x] Focus address bar, reload, hard reload, back/forward, zoom, find, new/close-tab shortcuts.
- [x] Codex-style categorized load-error surface with retry and network guidance.
- [x] Renderer crash/unresponsive recovery surface.

## Tabs and lifecycle

- [x] New, select, close, middle-click close, drag reorder, duplicate, and reopen closed tab.
- [x] Popup/new-window adoption into the tab model.
- [x] Favicons, titles, loading state, and per-tab navigation history.
- [x] Isolated persistent browser session shared by visible and agent-owned background tabs.
- [x] Restore visible tabs across application restarts.
- [x] Tab overflow menu and keyboard tab cycling.
- [ ] Explicit transfer/adoption UI between task-owned and background browser-agent tabs.

## Page tools

- [x] Find in page with previous/next match and match count.
- [x] Page zoom controls and keyboard shortcuts.
- [x] Print.
- [x] Capture visible viewport to clipboard.
- [x] Responsive/device toolbar with presets, custom dimensions, rotate, and resizable viewport bounds.
- [ ] Scaled device preview when the requested viewport is larger than the browser window.
- [x] Full-page screenshot option.

## Menus and site controls

- [x] Page context menu: editing actions, open link in tab/external browser, copy link, navigation, inspect.
- [x] Site information menu and per-site data clearing.
- [x] Permission prompts for camera, microphone, location, notifications, and related Chromium permissions.
- [x] Clear cookies and cache.
- [x] Persistent per-site allow/block/ask permission editor.
- [x] Searchable browser settings page for downloads, privacy/data, permissions, developer tools, and shortcuts.

## Downloads, profiles, and browser data

- [x] Download progress/history tracking, reveal completed files, open Downloads folder, clear history.
- [x] Configurable download location and “ask where to save” behavior.
- [x] Browser history viewer and deletion controls.
- [ ] Import cookies and passwords from supported browser profiles.
- [ ] Password manager and contact/autofill manager.
- [ ] Extension manager and install/remove/configure flows.

## Codex collaboration surfaces

- [ ] Browse/comment mode toggle and element-targeted comments.
- [ ] Region screenshot comments.
- [ ] Design adjustment editor (text, color, typography, border, size, layout, gap, spacing).
- [ ] Multiple pending annotations, original/preview hold state, discard, and send to Arivu composer.
- [ ] Floating composer inside the expanded browser surface.
- [x] Visible browser-agent cursor, border treatment, and live activity/step panel.
- [ ] Browser screenshot/URL copy notifications and comment handoff into task artifacts.

## Quality and accessibility

- [x] Accessible labels on shell controls, find controls, and device controls.
- [x] Responsive compact toolbar behavior.
- [ ] Light theme parity.
- [x] Reduced-motion and forced-colors/high-contrast shell behavior.
- [ ] Full keyboard-only interaction audit.
- [x] Visual comparison plus native Electron interaction smoke tests on macOS.
