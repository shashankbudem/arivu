# Roadmap

This roadmap is ordered by development leverage for the current MVP.

## Milestone 1: Desktop MVP quality

- Polish approval modals for clearer risk summaries and cleaner copy.
- Polish stale-path recovery and cleanup for recent workspace rows. Missing saved workspace folders are detected in the sidebar and can be forgotten while preserving chats as standalone history.
- Expand file/diff preview panels beyond task worktrees.
- Polish doctor/model health-check remediation. Desktop Settings health checks and CLI `arivu doctor` are implemented.
- Add keyboard shortcuts for common desktop actions.
- First-run setup for provider URL, model, API key, and trust mode is implemented; continue polishing validation and remediation copy.

## Milestone 2: TUI fallback quality

- Improve text wrapping and spacing in narrow terminals.
- Add keyboard shortcuts for scrolling conversation/activity panes. PageUp/PageDown, Shift-PageUp/Shift-PageDown, and Ctrl-Home/Ctrl-End variants are implemented.
- Keep the TUI usable for SSH/headless workflows.

## Milestone 3: Session ergonomics

- Add richer session metadata and filters to `arivu sessions`. Search, workspace, pinned/unpinned, and project/standalone filters are implemented for CLI and TUI session lists.
- Add an interactive session picker in the TUI. Filterable `/sessions [n]`, `/sessions --pick`, and `/resume <id>` commands are implemented.
- Add TUI/CLI controls for transcript compaction. Desktop `/compact`, TUI `/compact [n]`, and CLI `arivu compact <session-id>` are implemented.
- Add richer chat organization beyond the implemented rename/pin controls in desktop history and sidebar lists.

## Milestone 4: Provider robustness

- Add richer provider diagnostics beyond the implemented `arivu doctor` checks for API key, model listing, selected model, chat, streaming, tool calling, and Tavily.
- Add provider capability config for tool-calling support. Manual per-provider `auto`/`enabled`/`disabled` tool-calling modes, automatic persistence from observed schema failures, and Settings doctor writeback from unsupported tool probes are implemented; richer remediation remains future work.
- Add provider capability config for multimodal image support. Manual per-provider `auto`/`enabled`/`disabled` image-input modes and automatic persistence from observed image-part failures are implemented; proactive probes remain future work.
- Add clearer remediation copy for tool schema, streaming, and no-tools fallback failures.
- Fix invalid historical tool-call arguments so malformed model-emitted JSON is not preserved as structured tool-call history and cannot poison future retries when tool calling is enabled.
- Add better model error formatting.
- Add optional per-provider presets, starting with NVIDIA and OpenAI.
- Add web-search provider health checks and usage visibility for Tavily credits.
- Add optional explicit precise-location integration only if the user opts in.

## Milestone 5: Coding-agent depth

- Add richer PR review handoff controls and broader PR-check artifact ingestion. Sync conflict UI, file-level conflict open actions, Rerun-check prompts, passed-verification promotion hints, persisted repair history chains, Details/Open/Compare/Replay controls, structured replay lineage, per-file attempt deltas, replay outcome grouping, Review handoff prompts with repeated-failure summaries plus minimal verification plans, snapshot-aware created-PR Review PR continuation prompts, manual Refresh PR review/check/comment/check snapshots, user-started background Watch PR refresh, persisted review-state notifications, bounded feedback previews, bounded named check evidence, derived GitHub Actions log commands, external check-detail capture commands, persisted failed/cancelled/unknown check evidence command artifacts, line-level review-thread summaries, and explicit ready/blocked/waiting merge cues are implemented. Provider-specific authenticated CI artifact downloads remain future work.
- Add stronger semantic plan matching from richer artifacts beyond the current checklist. One-shot read-only Plan mode, persisted approve/revise/cancel review state, approved-plan drafting, approved-plan-to-worktree handoff, source-plan evidence cards, run-level completion notes, persisted assistant-authored `Completion notes:` with model-authored evidence labels, TypeScript compiler plus ESLint diagnostics captured from command output, guarded open-file actions from diagnostic locations, and conservative changed-file/command/report/diagnostic/PR-check/completion-note matching are implemented. Broader language-server diagnostics beyond command-output parsers remain future work.
- Add rollback helpers and broader patch preview for non-worktree edits. Direct write approval rows now store bounded pre-apply previews, direct edit artifacts have draft-revert prompts, and large direct `apply_patch` / `write_file` edits force a Trusted-mode write review before applying. A separate staged patch queue for non-worktree edits remains.
- Deepen policy scopes beyond coarse capabilities with parameter-level constraints such as path classes, network domains, MCP server identities, and browser target classes. The Settings policy matrix now includes examples, risk notes, default posture, active-mode reasons, stricter workspace overrides, preset buttons for default, review-first, local-only, and locked-down workspace policies, named local policy profiles, checked-in `.arivu/workspace-policy.json` team bundle import, and normalized workspace policy JSON copy/apply controls; read-scope enforcement for `list`, `read`, `search`, and `git_status` is implemented through `read_repo` workspace overrides; Activity rows and copied audit summaries now connect tool calls back to recorded or inferred policy details plus compact approval scopes for path, command, network, browser, and MCP targets. Settings now enforces and summarizes blocked workspace path prefixes, optional network domain allowlists, optional MCP server allowlists, and optional browser target-class allowlists; affected tools also show compact scope chips. Next, add signed or centrally managed policy distribution for teams that need stronger provenance than a repo file.
- Add richer TUI change inspection beyond the implemented `/diff` staged/unstaged/untracked summary.
- Add richer file mention/context commands beyond the implemented desktop file-context picker and `/files` command.
- Add richer multimodal composer workflows beyond the implemented picker, paste, and drag-and-drop image attachment paths.
- Add safer command parsing instead of broad shell execution. Shallow shell-aware command analysis now records risk summaries for approvals and command artifacts, structured argv execution avoids shell parsing for simple commands while preserving argv-specific risk detection, and command timeout metadata now feeds Activity/audit verification. Sandbox-backed common command profiles remain future work.

## Milestone 6: Packaging and release automation

- Electron Builder packaging, conditional macOS notarization, npm publishing metadata, installation docs, fixture-agent smoke coverage, and blocking CI for typecheck/tests/build/lint/format are implemented.
- Add automated versioning, changelog generation, GitHub release creation, and cross-platform signed artifact publication.
