# Roadmap

This roadmap is ordered by development leverage for the current MVP.

## Milestone 1: Desktop MVP quality

- Polish approval modals for clearer risk summaries and cleaner copy.
- Polish stale-path recovery and cleanup for recent workspace rows.
- Expand file/diff preview panels beyond task worktrees.
- Polish doctor/model health-check remediation. Desktop Settings health checks and CLI `arivu doctor` are implemented.
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
- Add richer chat organization beyond the implemented rename/pin controls in desktop history and sidebar lists.

## Milestone 4: Provider robustness

- Add richer provider diagnostics beyond the implemented `arivu doctor` checks for API key, model listing, selected model, chat, streaming, tool calling, and Tavily.
- Add provider capability config for tool-calling support based on observed fallback outcomes.
- Add provider capability config for multimodal image support based on selected model/endpoint.
- Add clearer remediation copy for tool schema, streaming, and no-tools fallback failures.
- Add better model error formatting.
- Add optional per-provider presets, starting with NVIDIA and OpenAI.
- Add web-search provider health checks and usage visibility for Tavily credits.
- Add optional explicit precise-location integration only if the user opts in.

## Milestone 5: Coding-agent depth

- Add richer PR review handoff controls such as review-state notifications and deeper PR-check log/artifact handoffs. Sync conflict UI, file-level conflict open actions, Rerun-check prompts, passed-verification promotion hints, persisted repair history chains, Details/Open/Compare/Replay controls, structured replay lineage, per-file attempt deltas, replay outcome grouping, Review handoff prompts with repeated-failure summaries plus minimal verification plans, snapshot-aware created-PR Review PR continuation prompts, manual Refresh PR review/check/comment/check snapshots, user-started background Watch PR refresh, bounded feedback previews, bounded named check evidence, line-level review-thread summaries, and explicit ready/blocked/waiting merge cues are implemented.
- Add stronger semantic plan matching from richer artifacts such as LSP diagnostics and model-authored evidence labels beyond the current checklist. One-shot read-only Plan mode, persisted approve/revise/cancel review state, approved-plan drafting, approved-plan-to-worktree handoff, source-plan evidence cards, run-level completion notes, persisted assistant-authored `Completion notes:`, and conservative changed-file/command/report/PR-check/completion-note matching are implemented.
- Add rollback helpers and broader patch preview for non-worktree edits. Direct write approval rows now store bounded pre-apply previews, direct edit artifacts have draft-revert prompts, and large direct `apply_patch` / `write_file` edits force a Trusted-mode write review before applying. A separate staged patch queue for non-worktree edits remains.
- Deepen policy scopes beyond coarse capabilities with parameter-level constraints such as path classes, network domains, MCP server identities, and browser target classes. The Settings policy matrix now includes examples, risk notes, default posture, active-mode reasons, stricter workspace overrides, preset buttons for default, review-first, local-only, and locked-down workspace policies, named local policy profiles, checked-in `.arivu/workspace-policy.json` team bundle import, and normalized workspace policy JSON copy/apply controls; read-scope enforcement for `list`, `read`, `search`, and `git_status` is implemented through `read_repo` workspace overrides; Activity rows and copied audit summaries now connect tool calls back to recorded or inferred policy details plus compact approval scopes for path, command, network, browser, and MCP targets. Settings now enforces and summarizes blocked workspace path prefixes, optional network domain allowlists, optional MCP server allowlists, and optional browser target-class allowlists; affected tools also show compact scope chips. Next, add signed or centrally managed policy distribution for teams that need stronger provenance than a repo file.
- Add richer TUI change inspection beyond the implemented `/diff` staged/unstaged/untracked summary.
- Add richer file mention/context commands beyond the implemented desktop file-context picker and `/files` command.
- Add richer multimodal composer workflows beyond the implemented picker, paste, and drag-and-drop image attachment paths.
- Add safer command parsing instead of broad shell execution.

## Milestone 6: Packaging

- Add release script.
- Add Electron packaging/notarization path.
- Add package metadata for publishing.
- Add CI for typecheck, tests, and build.
- Add installation docs for npm/global use.
- Add smoke tests against a fixture repo.
