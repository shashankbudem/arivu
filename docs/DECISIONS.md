# Decision Log

This is a lightweight decision log for context preservation. Add new entries when implementation direction changes.

## 2026-06-04: TypeScript/npm for v1

Decision: build Arivu as a TypeScript ESM npm package with an `arivu` binary.

Reason: fastest route to a local CLI with model APIs, subprocesses, tests, and npm linking.

## 2026-06-04: TUI-first MVP

Decision: default `arivu` opens the Arivu TUI; one-shot mode remains available when a task argument is passed.

Reason: the user explicitly wants the first MVP to feel like a terminal coding-agent app, not just a prompt loop.

## 2026-06-04: Blessed for the first TUI

Decision: use `blessed` for the first terminal UI.

Reason: small dependency, direct terminal primitives, enough for conversation/activity panes and approval modals.

Tradeoff: less modern component ergonomics than Ink/React.

## 2026-06-04: Desktop-first app direction

Decision: add an Electron + React desktop app while keeping CLI/TUI surfaces.

Reason: the TUI was not providing the level of interface quality expected for a coding-agent workspace. Electron lets the project reuse the existing TypeScript/Node agent core directly while providing a richer UI.

Tradeoff: larger runtime footprint than Tauri/Rust, but much faster iteration for this MVP.

## 2026-06-04: OpenAI-compatible provider layer

Decision: support OpenAI-compatible `/chat/completions` first.

Reason: covers OpenAI and NVIDIA integrate-style endpoints without adding provider-specific SDKs.

Current user endpoint:

```text
https://integrate.api.nvidia.com/v1
```

## 2026-06-19: Provider-scoped model lists

Decision: desktop Settings can save multiple OpenAI-compatible LLM providers, but the model picker lists models for only the selected provider.

Reason: model ids can collide across providers, and a selected model must imply the base URL and API key used for chat. A combined model picker would need explicit provider grouping and would switch both provider and model together.

## 2026-06-20: Auto model routing

Decision: support `auto` as a saved model id. The desktop main process resolves it at prompt-send time into a concrete provider/model using prompt classification, provider-specific preference tables, and cached `/models` results when available.

Reason: the manual picker should stay predictable and provider-scoped, while Auto can use the actual prompt shape to choose fast, coding, reasoning, vision, background, or general routes. Sessions keep `model: "auto"` so future turns keep routing dynamically, and store the last concrete model separately for history/debugging.

## 2026-06-20: Hidden agent browser by default

Decision: browser tool calls run on the hidden/background Electron target by default. Explicit requests that pass `visible` open or target a separate visible Electron browser window.

Reason: embedded visible browser panes can cover approvals and interrupt chat UX. Hidden browser tools keep routine agent inspection quiet, while a separate visible browser window gives the user an explicit viewing surface. When a task needs real Chrome screenshots or Chrome-specific behavior, Chrome DevTools MCP should be configured and used through MCP tools.

## 2026-06-22: Visible browser tabs

Decision: the visible Electron browser window has a native tab shell. Each visible tab owns a separate `BrowserView`, while browser tools keep backward-compatible active-tab defaults and can optionally pass `tabId` or `newTab`.

Reason: multi-page browser tasks should not overwrite the user's current visible page. Tabs preserve normal browser expectations, keep per-page navigation/screenshot/console state separate, and still let simple tool calls work without requiring a tab id.

## 2026-06-23: Task runs as the harness audit layer

Decision: desktop prompts create persisted `taskRuns` entries on the saved session. Each run records status, selected model/provider, loop metadata, coarse tool capabilities, tool calls, and artifacts such as browser screenshots and command output.

Reason: Arivu needs a control-plane record that is more durable and structured than the chat transcript alone. Task runs make Activity grouping, retries, compaction, future worktree isolation, and capability policy easier to reason about without introducing a heavy workflow engine yet.

## 2026-07-03: Saved chats have user-owned names and pins

Decision: saved sessions can store optional `title` and `pinnedAt` metadata. Desktop history and sidebar chat menus expose Rename plus Pin/Unpin, and pinned chats sort above normal recency order without changing the chat `updatedAt` activity timestamp.

Reason: a harness-style coding agent needs named, durable work items that can survive handoff and later review. Keeping labels and pins as metadata avoids rewriting transcript content or misrepresenting when model/tool activity last happened.

## 2026-07-03: File context attachments are quoted prompt text

Decision: desktop file-context attachments are selected through an active-workspace file picker or `/files`, bounded by count and size, read as UTF-8 text in the main process, rendered as removable composer chips, included in the composer token estimate, and sent as quoted `<workspace_file>` prompt context.

Reason: file context should be explicit user-selected input, not hidden filesystem access. Quoting the contents with path metadata helps the model use nearby code while preserving the harness boundary that files are context, not higher-priority instructions.

## 2026-06-23: One-shot task worktrees

Decision: add opt-in desktop task worktree mode. When armed for a prompt, Arivu creates a git branch/worktree under app data, runs tools against that isolated checkout, and records the worktree metadata on the task run while keeping the saved chat attached to the original project.

Reason: coding-agent changes need an isolation primitive before broader autonomy, loops, and PR/review flows. Git worktrees give Arivu a local, inspectable execution surface without introducing container or VM sandboxing yet.

## 2026-06-23: Conservative task worktree lifecycle

Decision: expose Activity actions to refresh a worktree diff summary, merge a completed ready worktree, discard an unmerged worktree, and clean up a merged worktree. Merge requires the original checkout to be clean, auto-commits dirty task worktree changes with a local Arivu author, and fast-forwards the original checkout to the task branch.

Reason: task isolation is only useful if users can safely finish or abandon the isolated change set. A clean-checkout plus fast-forward rule avoids hidden conflict resolution and reduces the chance of clobbering user work before Arivu has a full patch-review/PR workflow.

## 2026-06-23: Patch preview before task worktree merge

Decision: changed task worktrees must have a stored bounded patch preview before merge. The preview action stores a unified diff, including untracked files, on the task run and renders it in Activity.

Reason: worktree isolation needs a visible apply boundary. Requiring preview before merge gives users a reviewable artifact and keeps the first local harness path aligned with the later PR/review workflow.

## 2026-06-23: Structured command artifacts

Decision: shell command results stored on task runs include exit code, tool duration, bounded stdout/stderr fields, detected report paths, parsed JUnit/SARIF summaries, and bounded failing-test/finding previews when matching report files exist inside the execution workspace. Activity renders those fields as the command result detail and marks nonzero exits or failed parsed reports as failed rows.

Reason: the harness architecture needs durable, human-readable evidence for what the agent ran and what happened. Splitting command output into structured fields and parsing bounded report evidence makes test/build/security failures easier to scan while keeping raw report bodies in the workspace instead of bloating session state.

## 2026-06-24: Task-run evidence opens from Activity

Decision: Activity command results expose compact open-report/source actions for report paths, JUnit failed-test files, and SARIF finding locations attached to that command artifact. The main process validates the requested path against the artifact, then resolves it under the session or task-worktree root before opening it.

Reason: parsed reports are most useful when the user can jump directly from a failed run to the underlying evidence. Keeping the allowed path list anchored to the stored artifact preserves the harness audit boundary while making failures faster to inspect.

## 2026-06-24: Capability policy table

Decision: centralize trust-mode allow/prompt/deny decisions in `src/permissions/capabilityPolicy.ts`, keyed by task-run capability names. `ApprovalManager` evaluates approval actions through this table, and the desktop Tools drawer reads the same decisions for user-facing status labels.

Reason: the harness needs one policy vocabulary for audit, UI, and enforcement. Keeping the table small and explicit makes the current local desktop safety posture easier to reason about and creates a future seam for workspace-specific policy without spreading trust-mode conditionals through tool code.

## 2026-06-24: Draft-first report remediation

Decision: Activity command results with failed JUnit/SARIF evidence expose a Draft fix action that fills the composer with a bounded, targeted repair prompt. The prompt includes report paths, failing tests, SARIF findings, and relevant stderr excerpts, but it does not automatically submit a new agent turn.

Reason: parsed reports should accelerate repair without making failed checks trigger surprise edits. Draft-first remediation keeps the user in the review loop, preserves the existing composer/worktree controls, and prepares the path for a future opt-in automatic repair loop.

## 2026-06-24: Loop report evidence injection

Decision: when a Loop-mode run chooses `Loop: continue` after producing failed parsed JUnit/SARIF evidence, Arivu injects the latest actionable report evidence into the next loop iteration once. The injected system message includes a marker tied to the command artifact id so repeated continuations do not replay stale evidence.

Reason: looped repair tasks should carry structured failure evidence forward without relying on the model to rediscover it in prior tool output. Limiting injection to opted-in Loop mode and to the latest artifact keeps the behavior bounded and avoids surprising edits after a run has already completed or blocked.

## 2026-06-24: Durable task-run plan capture

Decision: task runs store a bounded plan snapshot when a completed assistant turn includes a `Plan:`, `Approach:`, `Implementation plan:`, `Next steps:`, or `What I'll do:` section with checklist or numbered items. The desktop Activity rail renders that plan inside the query group and the session store persists it with the run.

Reason: the harness architecture calls for human-comprehensible collaboration: users need to see not only tool calls, but the intent those calls served. Capturing plans from visible assistant text creates an audit-friendly planning layer without inventing a separate workflow engine or exposing private model reasoning.

## 2026-06-24: Managed worktree open action

Decision: Activity task-worktree controls include an Open action that opens the managed worktree folder for inspection. The main process validates the stored worktree path with the same Arivu app-data root and branch-prefix checks used by merge/discard/cleanup before calling the OS folder opener, and a successful open does not mutate the task-run audit record.

Reason: isolated task worktrees are only useful if users can inspect the actual execution workspace quickly. Opening only managed Arivu worktrees keeps the affordance tied to the review boundary instead of becoming a general arbitrary-path launcher.

## 2026-06-24: Session-backed task worktree inventory

Decision: Settings lists task worktrees recorded on saved sessions, including prompt/session context, branch/path, lifecycle status, changed-file count when known, and whether the folder still exists. The inventory uses session/task-run metadata as the authority and only exposes valid lifecycle actions through the existing guarded task-worktree action: Open for present managed worktrees, Discard for ready/failed worktrees, and Clean up for merged worktrees.

Reason: a worktree-per-task model needs an inventory so old isolated work does not become invisible once its chat is no longer active. Starting from persisted task runs preserves the audit boundary and avoids treating arbitrary filesystem directories as harness state. Reusing the existing lifecycle action keeps stale missing-folder cleanup on the same git prune and branch-deletion path as Activity cleanup.

## 2026-06-24: Local PR draft prep for task worktrees

Decision: previewed ready task worktrees can prepare pull-request draft metadata without pushing to a remote. The action commits dirty task worktree changes locally, stores title/body/branch/base/commit metadata on the task run, and renders push plus `gh pr create --draft` commands when an `origin` remote and base branch are available.

Reason: the harness needs a review boundary before remote writes. Local PR draft prep gives users a durable, inspectable handoff artifact before the separate explicit remote creation action pushes or opens a PR.

## 2026-06-24: Explicit remote PR creation

Decision: remote PR creation is a separate task-worktree action after PR draft prep. The action confirms in the UI, verifies the worktree is still clean at the drafted commit, pushes the task branch, runs `gh pr create --draft`, and stores the returned PR URL on the task run.

Reason: remote writes should not be a side effect of local draft preparation. Splitting draft prep from creation preserves a review boundary while still letting users complete the PR flow when GitHub CLI credentials are available.

## 2026-06-24: User-visible capability policy

Decision: Settings renders a built-in Capability policy matrix sourced from `src/permissions/capabilityPolicy.ts`, the same table used by `ApprovalManager` and the Tools drawer.

Reason: trust modes are a control-plane boundary, not just configuration text. Showing the actual allow/approval/blocked matrix makes policy explainable before adding repo or workspace overrides.

## 2026-06-24: Stricter workspace policy overrides

Decision: workspace-specific capability policy overrides are saved by absolute workspace root and can only tighten enforceable capabilities to `prompt` or `deny`. The same override map is passed to `ApprovalManager`, the desktop Tools drawer, and the Settings policy matrix.

Reason: local projects have different risk profiles, but workspace policy must not become a hidden way to bypass trust modes. Restricting overrides to stricter decisions preserves default-deny behavior while letting users harden sensitive repos.

## 2026-07-02: Repo reads route through capability policy

Decision: `list`, `read`, `search`, and `git_status` now call `ApprovalManager` with a `read` action mapped to `read_repo`. Settings exposes `read_repo` as a workspace override, so local repo reads remain automatic by default but can be approval-gated or blocked for a sensitive workspace.

Reason: the harness policy model should govern both execution-changing actions and read scope. Routing repo reads through the same policy boundary makes workspace hardening enforceable instead of only descriptive, while preserving the normal low-friction read-only workflow unless the user tightens policy.

## 2026-06-25: Durable approval audit on task runs

Decision: `ApprovalManager` emits audit events for automatic allows, policy blocks, approval requests, approvals, and denials. Desktop runs persist those events on the active task run and render them in Activity.

Reason: approval prompts are part of the control-plane trace. Saving them beside tool calls makes a restored or compacted chat explain why an action was allowed, blocked, or performed after human review.

## 2026-06-25: Explicit command execution profile seam

Decision: the `run` tool accepts an explicit `executionProfile`, emits profile/isolation/cwd metadata, and stores that metadata on command artifacts. Only `host` is supported today; `container` and `sandbox` fail closed before approval or execution until real isolated execution backends exist.

Reason: Arivu needs to distinguish control-plane audit records from execution-plane isolation. Naming the profile now prevents the UI and docs from implying sandboxing while giving future container/gVisor/Kata work a stable tool-schema boundary.

## 2026-06-25: Durable patch artifacts on task runs

Decision: successful direct `apply_patch` calls create task-run patch artifacts with a bounded unified diff, changed paths, and addition/deletion counts. Activity renders the persisted patch artifact as a diff preview instead of relying only on transient tool-call arguments.

Reason: the harness needs a reviewable evidence trail for non-worktree edits as well as commands. Persisting bounded patch artifacts moves direct edits closer to the same audit boundary as task worktree previews without forcing a full patch-staging workflow yet.

## 2026-06-25: Durable write-file artifacts on task runs

Decision: successful direct `write_file` calls create task-run file-change artifacts with the path, create/replace mode, line count, and bounded new-content preview. Activity renders the persisted file-change artifact as a diff-style preview instead of relying only on transient tool-call arguments.

Reason: full-file create/replace writes are just as important to audit as unified patches. Capturing the new-content preview keeps direct writes inspectable after reload or compaction while avoiding storage of old file contents in the session record.

## 2026-06-25: Evidence-derived task-run verification summaries

Decision: finishing a task run derives and persists a verification summary from command artifacts. The summary records command count, failed exits, parsed report count, and failed/passed/unknown report counts, and Activity renders it beside the run metadata.

Reason: users need a compact answer to what Arivu actually verified, but that answer must be grounded in tool evidence rather than assistant prose. Persisting verification summaries makes restored or compacted chats easier to audit and prepares report-aware repair loops to connect to task-worktree lifecycle decisions.

## 2026-06-25: Failed verification gates task-worktree promotion

Decision: task-worktree PR draft prep, remote draft PR creation, and merge reject runs whose persisted verification summary is failed. Activity and Settings surface that verification state while preserving inspection actions such as Open, Refresh, Preview, and Discard.

Reason: a failed command or parsed report is evidence that the task branch is not ready for review or merge. Gating promotion on stored verification connects the harness audit trail to actual lifecycle controls without blocking users from inspecting or throwing away the isolated worktree.

## 2026-06-26: Failed-verification repair continues the same worktree

Decision: Activity offers Fix verification for failed task-worktree verification. The action drafts a repair prompt from run-level command/report evidence, arms the composer to send `worktree: { enabled: true, taskRunId }`, validates the referenced ready managed worktree in the main process, and records `continuedFromTaskRunId` on the new task run.

Reason: a failed verification gate should lead to a repair loop on the same isolated branch, not force users to start a new task branch or manually copy paths. The continuation id keeps the workflow auditable while stale patch preview and PR draft metadata stay out of the follow-up run until the repaired branch is previewed again.

## 2026-06-04: Conservative write safety

Decision: require path containment, read-before-replace, patch mismatch checks, and approval routing for writes.

Reason: a coding agent must preserve user work and avoid surprise filesystem changes.

## 2026-06-04: Empty env vars do not override saved config

Decision: only non-empty env vars override saved config.

Reason: unset or empty shell env values previously caused runtime config to drop the saved API key/model/base URL.

## 2026-06-06: Local paste token budgeting

Decision: add a local renderer-side token estimator and paste guard instead of a model/tool-based token counter.

Reason: sending large pasted text through the model just to count tokens would already consume the context the feature is meant to protect. The composer now estimates prompt size before accepting large pasted text and can insert a truncated version.

## 2026-06-06: Tavily-first web search

Decision: add `web_search` as a local function tool, prefer Tavily when configured, and keep Bing RSS as a no-key fallback.

Reason: Tavily is better suited for agent web search and the user already has credits. The implementation remains a local tool rather than an MCP server to match the current tool registry architecture.

## 2026-06-06: NVIDIA-compatible chat fallback shape

Decision: omit `stream` for batch chat requests, use `stream: true` only for streaming, and retry provider tool/fallback JSON decode errors without tool schemas.

Reason: NVIDIA OpenAI-compatible endpoints accepted some basic requests but returned 500 JSON decode errors for several tool/fallback payload shapes, including failures that referenced literal `false`. Omitting `stream: false` and stripping tool protocol history from no-tools retries keeps the fallback payload plain.

## 2026-06-16: Empty assistant tool-call content compatibility

Decision: serialize assistant tool-call history with no natural-language text as `content: null` instead of `content: ""`, omit blank assistant history messages without tool calls from provider requests, and treat provider errors about empty assistant message content as retryable without tools.

Reason: some OpenAI-compatible endpoints reject empty assistant message content even when the message carries tool calls, and stricter models such as `diffusiongemma-26b-a4b-it` can also reject plain blank assistant history on follow-up prompts. Using `null` matches the common tool-call payload shape, omitting blank no-tool assistant messages removes context-free history, and the fallback path keeps existing tool sessions recoverable by converting tool history into plain-text transcript entries.

## 2026-06-16: Failed prompt persistence and local context compaction

Decision: keep failed desktop user prompts visible in renderer state with Retry/Edit/Copy controls, and add a desktop compact-context action that summarizes older saved messages locally instead of asking the model to summarize.

Reason: users need to recover the exact query that failed, edit or copy it, and retry without creating duplicate user bubbles. Context compaction should also work when the provider is failing or near context limits, so it is deterministic and local. Older transcript/tool protocol is converted into plain text and a hidden system compaction note, while recent messages stay available for future requests.

## 2026-06-06: One web search per answer turn

Decision: after one `web_search` call for a user request, disable tools for the next model turn and instruct the model to answer from the gathered results.

Reason: some models repeatedly reissued `web_search` instead of answering. The agent now prevents search loops, ignores unadvertised tool calls, and rolls back unsaved in-memory messages if a run fails.

## 2026-06-06: News-aware Bing RSS fallback

Decision: route news-like no-key web-search fallback queries to Bing News RSS, refresh stale generated years to the current UTC month/year, and decode Bing News redirect links.

Reason: general Bing RSS returned broad pages such as Wikipedia for "latest news" prompts, while Bing News RSS returned current article results better suited for agent answers.

## 2026-06-09: Local time and timezone-location tools

Decision: add `current_datetime` and `current_location` as local read-only function tools.

Reason: exact date/time questions should not require a web search, and current/recent prompts benefit from deterministic local clock context. Location context is intentionally timezone-only for privacy; the tool does not use GPS, browser geolocation, IP lookup, or network location.

## 2026-06-09: Tool discovery in the composer

Decision: expose a desktop `tools:list` IPC endpoint and render available tools in an inline composer drawer.

Reason: users need to know what the agent can call without reading source or crowding the prompt placeholder. The renderer consumes registry metadata from the main process so tool names/descriptions/statuses do not drift.

## 2026-06-09: Compact desktop chrome

Decision: minimize the desktop header/sidebar by removing the session id from the header, removing the sidebar subtitle, using icon-only header actions with CSS tooltips, and slimming the Activity panel into a compact rail.

Reason: the chat surface should stay visually dominant. Session ids and permanent action labels were useful during debugging but consumed too much screen space for normal use.

## 2026-06-26: Continued repairs get an explicit rerun-checks prompt

Decision: when a continued task-worktree repair finishes with missing or unknown verification, Activity offers `Rerun checks`. The prompt continues the same managed worktree and reuses command text from the previous failed run when available.

Reason: a repair is not promotion-ready until verification is captured. Making the rerun step explicit keeps the control-plane state honest without forcing Arivu to auto-run arbitrary commands.

## 2026-06-26: Passed worktree verification shows promotion guidance

Decision: when a ready task worktree has passed verification, Activity shows a positive promotion hint. The hint tells the user whether the branch still needs a patch preview, can prepare a PR draft or merge, can create a draft PR, or already has a created draft PR.

Reason: failed verification already blocks promotion visibly; passed verification should be equally legible so the repair loop has a clear end state without auto-merging or auto-opening remote PRs.

## 2026-06-26: Worktree repair attempts render as a persisted chain

Decision: Activity follows each task run's `worktree.continuedFromTaskRunId` links and renders a compact repair history chain for continued worktree attempts.

Reason: repair loops should be auditable as a sequence of attempts, not just the latest run. Building the chain from persisted task-run ids keeps it stable after reload or context compaction.

## 2026-06-27: Repair history rows focus prior evidence

Decision: repair history rows expose a Details action that focuses and expands the matching Activity group, plus an Open action when the existing guarded task-worktree lifecycle rules say that attempt's managed worktree can be opened.

Reason: the history chain should be actionable without creating a second evidence viewer or bypassing the managed-worktree safety boundary. Reusing Activity groups keeps command/report/tool evidence in one place, and reusing the Open lifecycle action preserves the same path validation as the main worktree controls.

## 2026-06-27: Repair history can compare and replay attempts

Decision: repair history rows can compare a selected attempt against the current attempt using compact persisted task-run summaries, and can draft a Replay prompt that continues the current managed worktree while rerunning verification commands from the selected evidence attempt. Replay sends `replayOfTaskRunId` with the continuation payload, and the main process only persists it after validating that the evidence run belongs to the same managed task worktree branch/path.

Reason: repair loops need a practical way to answer "what changed between attempts?" and "rerun the same check" without introducing a hidden workflow engine. Drafting Replay through the existing composer keeps the user in control, preserves structured lineage on the current worktree run, and reuses the same command evidence extraction used by Rerun checks.

## 2026-06-27: Repair history shows per-file deltas and replay outcomes

Decision: the repair-history Compare panel derives per-file added/removed/shared path deltas from stored worktree diff summaries, patch previews, patch artifacts, and file-change artifacts. The repair-history timeline also groups replay attempts by `replayOfTaskRunId` and surfaces each replay run's latest verification outcome.

Reason: compact summary rows are useful, but repair loops often turn on "which files changed?" and "did replaying that check pass later?" Deriving this from durable task-run evidence keeps restored chats auditable without adding a new workflow database.

## 2026-06-27: Repeated replay failures draft a review handoff

Decision: when at least two replay attempts for the same evidence run fail verification, Activity exposes a Review action in the replay outcome group. The action drafts a continuation prompt for the current managed worktree, includes the evidence run, failed replay summaries, a repeated-failure pattern summary, suggested verification commands, a minimal verification plan, and failed command evidence, and asks the agent to classify the failure as a real defect, stale command, environment issue, or missing precondition.

Reason: repeated replay failures usually need a change in strategy rather than another blind rerun. Keeping the handoff as a draft prompt preserves user control while making the accumulated run evidence actionable.

## 2026-07-01: Created PR cards draft review handoffs

Decision: when a task-worktree run has a created PR URL, Activity exposes Review PR on the PR card. The action drafts a continuation prompt for the same managed worktree, includes PR URL/title/base/remote/commit details, the latest verification summary, any last refreshed PR review/check/comment/thread snapshot, and suggested verification commands, and asks the agent to inspect PR review comments and check results before editing.

Reason: a created PR is a review boundary, but handing control to an automatic repair loop would be too eager. Drafting the review handoff keeps the user in control, preserves the existing worktree continuation path, and makes the PR URL plus local verification and refreshed remote review/comment evidence actionable.

## 2026-07-01: Created PR cards refresh review and check snapshots

Decision: created PR cards expose Refresh PR. The action runs GitHub CLI from the managed task worktree, requests `state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,comments,reviews,url`, then makes a best-effort `gh api graphql` lookup for line-level review threads. Arivu rolls those fields into a compact review/check/comment/thread summary with bounded latest feedback previews and persists it on `worktree.pullRequest.review`.

Reason: Review PR handoffs are more useful when the Activity card already shows the latest remote review, line-level thread, and check state. Keeping refresh explicit avoids surprising network calls and still gives restored chats a durable snapshot of GitHub's last known PR state.

## 2026-07-02: User-started Watch PR refresh

Decision: created PR cards also expose Watch PR. The renderer stores a session-scoped watch entry after the user starts it, immediately calls the same guarded `refresh_pr` IPC action, repeats that action every 90 seconds while the watched PR remains in the active session, and shows refreshing, last-refreshed, or error status on the card. Stopping the watch, changing sessions, or losing the PR card removes the watcher.

Reason: PR checks and reviews can change after a draft is created, but Arivu should not poll GitHub without the user asking. A renderer-owned watch keeps the behavior easy to see and stop while reusing the same main-process validation, GitHub CLI command path, and persisted review snapshot as manual Refresh PR.

## 2026-07-02: Plan-derived worktrees expose completion notes

Decision: the Approved plan source card now derives per-step completion notes for plan-derived worktrees. Notes are conservative: failed verification marks planned steps blocked, missing verification/changes/patch preview marks them as needing evidence, and passed verification plus recorded changes plus a patch preview is still only enough for a planned step to be supported when a changed file, verification command, or assistant-authored completion note matches that step. Approved-plan worktree instructions ask the agent to end with a parseable `Completion notes:` checklist, task runs persist that checklist, and matching is textual and bounded over changed paths, command text, report paths, parsed report summaries, failed test metadata, SARIF finding previews, and final close-out bullets.

Reason: plan approval is only useful if the user can see how execution closed the loop. Item-specific matching lets the UI cite concrete files, commands, or final agent-authored close-out bullets when available, while keeping unmatched checklist items visible as needing evidence instead of overstating proof.

## 2026-07-02: Refreshed PR snapshots derive merge readiness cues

Decision: Activity derives a ready/blocked/waiting/unknown merge cue from the last refreshed created-PR snapshot. The ready cue is conservative: the PR must be open, non-draft, approved, merge-clean or hook-clean, and have settled checks without failures, cancellations, pending, or unknown states. Failed checks, cancelled checks, changes requested, or blocked/dirty/behind merge states produce a blocked cue; draft, review-required, pending, missing, or unknown evidence produces waiting or unknown.

Reason: a refreshed PR snapshot should answer the user's immediate question, "can this merge?" without requiring them to parse GitHub status tokens. Keeping the rule conservative avoids overstating readiness from stale or partial remote data.

## 2026-07-01: Plan approval mode is read-only

Decision: desktop exposes Plan approval as a one-shot composer mode and `/plan` slash command. A planning run records `planMode` on the task run, injects a planning-only instruction, disables Loop/Worktree for that prompt, and advertises only local read/discovery tools (`list`, `read`, `search`, `git_status`, current date/location, and local skills). Captured Activity plan cards persist approve/revise/cancel review state, and only approved plans expose follow-up actions. Use approved plan drafts a normal execution prompt; Start worktree drafts the approved plan while arming a new task worktree and recording `plannedFromTaskRunId` on the follow-up run. Plan-derived worktrees resolve that source id back to an Activity review card with checklist and concrete execution evidence cues.

Reason: the harness architecture needs a human-comprehensible approval boundary before high-risk work. Allowing local reads keeps the plan grounded in the repo, while withholding writes, shell, browser, network search, and MCP tools prevents the plan step from becoming execution in disguise.

## 2026-06-27: Task worktrees expose sync conflict resolution

Decision: Activity exposes a Sync action for ready task worktrees. Sync commits dirty task-worktree changes, merges the current original checkout head into the task branch, clears stale preview/PR metadata, and records conflicted files plus branch heads on `worktree.conflict` if Git stops for manual resolution. While a conflict is active, Preview, PR draft, Create PR, and Merge are blocked; Activity shows a conflict card with file-level Open actions plus Open worktree, Continue, and Abort actions. File-level Open validates the requested path against the stored conflict file list and managed worktree root before opening it. Continue stages resolved files and completes the merge commit. Abort runs `git merge --abort`.

Reason: the original checkout can move while an isolated task branch is being repaired or verified. Sync makes that drift explicit without mutating the original checkout, and a persisted conflict record keeps the user-controlled resolution boundary visible after reload or context compaction.

## 2026-07-03: Browser control does not prompt by default

Decision: `browser_control` is allowed by default in `readonly`, `ask`, and `trusted` trust modes. Browser opens, clicks, coordinate clicks, and typing still flow through `ApprovalManager`, so task-run audit records capture them as allowed browser activity, but they no longer interrupt the user with approval dialogs. Workspace capability overrides can still require approval or block browser control for sensitive projects.

Reason: browser work is part of Arivu's routine agent execution path, and approval dialogs were interrupting visible-browser workflows. Keeping browser activity audited and overrideable preserves the control-plane record while making browser-assisted tasks usable by default.
