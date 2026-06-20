# Roadmap

This roadmap is ordered by development leverage for the current MVP.

## Milestone 1: Desktop MVP quality

- Polish approval modals for clearer risk summaries and cleaner copy.
- Add recent workspace list.
- Add file/diff preview panel.
- Add `doctor` / model health-check view.
- Add keyboard shortcuts for common desktop actions.
- Add optional first-run setup for model, API key, and trust mode.

## Milestone 2: TUI fallback quality

- Improve text wrapping and spacing in narrow terminals.
- Add keyboard shortcuts for scrolling conversation/activity panes.
- Keep the TUI usable for SSH/headless workflows.

## Milestone 3: Session ergonomics

- Add `arivu sessions` to list recent sessions.
- Add session picker in the TUI.
- Add `/resume <id>` or `/sessions` inside the TUI.
- Add TUI/CLI controls for transcript compaction. Desktop compaction is implemented.
- Add chat rename/pin controls in the desktop history.

## Milestone 4: Provider robustness

- Add `arivu doctor` to test base URL, key, model, and tool support.
- Add provider capability config for tool-calling support based on observed fallback outcomes.
- Add provider capability config for multimodal image support based on selected model/endpoint.
- Add richer provider diagnostics for tool schemas, streaming, and no-tools fallback behavior.
- Add better model error formatting.
- Add optional per-provider presets, starting with NVIDIA and OpenAI.
- Add web-search provider health checks and usage visibility for Tavily credits.
- Add optional explicit precise-location integration only if the user opts in.

## Milestone 5: Coding-agent depth

- Add test/build command detection.
- Add explicit planning mode for larger tasks.
- Add patch preview and rollback helpers.
- Add git diff summary in the TUI.
- Add file mention/context commands.
- Add drag-and-drop and paste-to-attach image workflows in the desktop composer.
- Add safer command parsing instead of broad shell execution.

## Milestone 6: Packaging

- Add release script.
- Add Electron packaging/notarization path.
- Add package metadata for publishing.
- Add CI for typecheck, tests, and build.
- Add installation docs for npm/global use.
- Add smoke tests against a fixture repo.
