# Roadmap

This roadmap is ordered by development leverage for the current MVP.

## Milestone 1: Desktop MVP quality

- Polish approval modals for clearer risk summaries and cleaner copy.
- Polish stale-path recovery and cleanup for recent workspace rows.
- Expand file/diff preview panels beyond task worktrees.
- Add `doctor` / model health-check view.
- Add keyboard shortcuts for common desktop actions.
- Add optional first-run setup for model, API key, and trust mode.

## Milestone 2: TUI fallback quality

- Improve text wrapping and spacing in narrow terminals.
- Add keyboard shortcuts for scrolling conversation/activity panes.
- Keep the TUI usable for SSH/headless workflows.

## Milestone 3: Session ergonomics

- Add richer session metadata and filters to `arivu sessions`. Basic recent-session listing is implemented.
- Add an interactive session picker in the TUI. Basic `/sessions [n]` and `/resume <id>` commands are implemented.
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

- Add richer PR review handoff controls such as review-state notifications and deeper PR-check evidence handoffs. Sync conflict UI, file-level conflict open actions, Rerun-check prompts, passed-verification promotion hints, persisted repair history chains, Details/Open/Compare/Replay controls, structured replay lineage, per-file attempt deltas, replay outcome grouping, Review handoff prompts with repeated-failure summaries plus minimal verification plans, snapshot-aware created-PR Review PR continuation prompts, manual Refresh PR review/check/comment snapshots, user-started background Watch PR refresh, bounded feedback previews, line-level review-thread summaries, and explicit ready/blocked/waiting merge cues are implemented.
- Add stronger semantic plan matching from richer artifacts such as parsed reports, LSP diagnostics, PR checks, and model-authored evidence labels beyond the current checklist. One-shot read-only Plan mode, persisted approve/revise/cancel review state, approved-plan drafting, approved-plan-to-worktree handoff, source-plan evidence cards, run-level completion notes, persisted assistant-authored `Completion notes:`, and conservative changed-file/command/completion-note matching are implemented.
- Add rollback helpers and broader patch preview for non-worktree edits. Direct edit artifacts now have draft-revert prompts; a pre-apply review boundary for larger non-worktree edits remains.
- Make the capability policy more explainable/configurable in the UI without weakening the default local safety posture. Read-scope enforcement for `list`, `read`, `search`, and `git_status` is implemented through `read_repo` workspace overrides.
- Add richer TUI change inspection beyond the implemented `/diff` staged/unstaged/untracked summary.
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
