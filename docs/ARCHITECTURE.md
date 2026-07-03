# Architecture

Arivu (`arivu`) is a TypeScript ESM coding agent with three local surfaces: Electron desktop, terminal TUI, and one-shot CLI. The desktop main process and CLI both reuse the same agent/tool/config/session modules.

## Runtime flow

Interactive mode:

```text
arivu
  -> src/cli.ts
  -> loadConfig()
  -> TuiApp
  -> Agent.run(prompt)
  -> OpenAICompatibleChatClient.complete()
  -> tool execution loop
  -> SessionStore.save()
  -> TUI render update
```

Desktop mode:

```text
npm run desktop:dev
  -> desktop/main/main.ts
  -> Electron BrowserWindow + preload bridge + isolated browser views
  -> desktop/renderer React app
  -> IPC: agent/config/workspace/session/model/tool/browser/approval calls
  -> Agent.run(prompt)
  -> SessionStore.save()
  -> renderer state update
```

One-shot mode:

```text
arivu "task"
  -> src/cli.ts
  -> Agent.run(task)
  -> print final answer
  -> SessionStore.save()
```

## Main modules

- `src/cli.ts`: command parsing, config resolution, TUI vs one-shot dispatch.
- `src/tui/TuiApp.ts`: blessed-based terminal UI, slash commands, approval modal, status rendering.
- `desktop/main/main.ts`: Electron lifecycle, IPC handlers, workspace open/create, session history, model listing, desktop agent controller.
- `desktop/main/browserController.ts`: hidden/background and separate tabbed visible-window isolated Electron browser targets, browser state broadcast, screenshot capture, DOM snapshot, console collection, and browser action helpers.
- `desktop/main/preload.ts`: context-isolated renderer API.
- `desktop/renderer/src/App.tsx`: React desktop workspace UI, compact header/sidebar chrome, resizable/collapsible side panels, expandable project chat groups, standalone chats, history browser, prompt `+` menu, browser-window launcher, direct composer model switcher, composer slash-command menu, searchable model dialog, chat search, inline tools drawer, token-aware multimodal/file-context composer, compact-context control, failed-prompt retry/edit/copy state, Activity task-run audit copy controls, theme/UI concept controls, settings, approvals, Markdown/Shiki code rendering.
- `desktop/renderer/src/tokenBudget.ts`: local token estimate and truncation helper for pasted composer text.
- `src/agent/Agent.ts`: model/tool loop and session lifecycle.
- `src/agent/content.ts`: shared text/image chat content types and text-projection helpers.
- `src/agent/contextCompaction.ts`: deterministic local compaction for saved sessions.
- `src/agent/OpenAICompatibleChatClient.ts`: OpenAI-compatible chat completions adapter.
- `src/agent/reportRemediation.ts`: bounded JUnit/SARIF evidence-to-repair-prompt builder used by desktop Activity Draft fix actions, task-worktree verification/replay/PR handoffs, and loop continuation evidence injection.
- `src/agent/skills.ts`: global skill discovery, skill reads, and skill system-message formatting.
- `src/agent/taskRunAudit.ts`: bounded Markdown audit-summary formatter for persisted task runs, used by desktop Activity copy actions.
- `src/agent/taskRuns.ts`: durable per-prompt run helpers for status, capability, tool-call, and artifact tracking.
- `src/agent/taskWorktree.ts`: git worktree creation, changed-file summary, bounded patch preview, sync/conflict resolution, merge/discard/cleanup, and model instruction helpers for isolated task execution.
- `src/tools/registry.ts`: tool definitions and execution.
- `src/tools/browserControl.ts`: shared browser tool contract and URL/mode helpers used by the desktop-backed browser tools.
- `src/tools/mcp.ts`: MCP stdio client helpers for configured servers.
- `src/tools/pathSafety.ts`: workspace path containment.
- `src/tools/fileState.ts`: read-before-write state tracking.
- `src/tools/patch.ts`: unified diff parsing/application.
- `src/tools/webSearch.ts`: Tavily-first web search helper with Bing/Bing News RSS fallback.
- `src/permissions/capabilityPolicy.ts`, `src/permissions/approvalScope.ts`, `src/permissions/scopePolicy.ts`, and `src/permissions/ApprovalManager.ts`: capability-to-policy mapping, compact target-scope extraction, workspace scope-rule enforcement, trust-mode allow/prompt/deny decisions, and approval prompts.
- `src/sessions/SessionStore.ts`: JSON session persistence.
- `src/config.ts`: saved config, env overrides, config/data paths.
- `src/workspace.ts`: git/package workspace detection.

## Agent loop

The agent creates a tool registry for the detected workspace, discovers global local skills, sends model messages plus tool schemas, executes returned tool calls, appends tool observations, and repeats until the model returns a final assistant message or the max step count is reached.

User message content can be plain text or multimodal content parts. Text parts and image parts are saved in sessions; image parts use OpenAI-compatible `image_url` payloads and may also retain local display metadata such as filename, MIME type, and byte size. Text-only surfaces such as TUI history, session titles, fallback transcripts, and local compaction use `chatContentToText()` to flatten images into readable placeholders.

The loop has a fixed max depth of 20 tool-call turns. This is a guardrail against runaway tool loops.

Skills are stored outside workspaces under the app data directory's `skills/` folder, or under `ARIVU_SKILLS_HOME` when set. The desktop composer can queue skills from the prompt `+` menu or `/skills`; queued skill names are sent with the prompt payload, and the agent saves each selected `SKILL.md` as a hidden `Skill loaded into chat` system message so it remains in that chat's context. If a user explicitly names `$skill-name`, the agent attaches that skill's `SKILL.md` as a transient system message before that model turn. For inferred skill use, the model sees the global skill index and can call `read_skill`.

For current/recent information requests, the agent allows one `web_search` call, then disables tools for the next model turn and adds a transient instruction to answer from the retrieved results. If a model still emits a tool call that was not advertised for that step, the agent ignores it and treats the message as the final answer. Failed runs roll back unsaved in-memory messages so desktop retries do not inherit partial tool transcripts.

The OpenAI-compatible client streams with `stream: true` when streaming is requested, and omits `stream` for batch/fallback requests instead of sending `stream: false`. Text+image user messages are serialized as chat completion content parts; local-only image metadata is stripped before the provider request. Assistant tool-call messages with no text are serialized as `content: null` instead of an empty string, while blank assistant history messages without tool calls are omitted before provider requests. If a provider rejects tool schemas or tool-history payloads, including NVIDIA-style JSON decode errors or empty assistant tool-call content errors, the client retries without tools and converts prior tool requests/results into plain-text transcript entries.

Assistant text is normalized to remove raw source-line citation artifacts such as `【1†L1-L2】` in both batch and streamed responses before messages are saved or rendered.

New sessions are created lazily when the first prompt is sent. Startup and `New chat` start as unassigned drafts using the standalone chat directory instead of inheriting a workspace. Before the first prompt, the renderer can select `No project`, a recent project, or an opened workspace through IPC. Once the first prompt creates a session, project selection is locked and the session's `projectRoot` decides whether it appears under a project group or the top-level Chats section. Opening a saved chat loads its session into the desktop controller and switches the active workspace to that session's `cwd`.

Desktop send failures roll back unsaved main-process session mutations, but the renderer keeps the failed user query visible as local UI state. That failed bubble exposes Retry/Edit/Copy, and retrying it reuses the existing bubble so the query is not duplicated when the retry succeeds.

Each desktop prompt also creates a persisted `taskRuns` entry on the session. A task run records the triggering user message index, prompt preview, selected model/provider, plan/loop/worktree metadata, any bounded assistant plan captured from `Plan:`/`Approach:`/`Next steps:` sections, assistant-authored completion notes captured from `Completion notes:`/`Plan completion:` sections, coarse capabilities used, approval decisions, tool-call status, result previews, and artifacts such as browser screenshots, direct file changes, and command output. Patch artifacts carry a bounded unified diff, changed paths, and addition/deletion counts for direct `apply_patch` edits. File-change artifacts carry write path, write mode, line count, and bounded new-content preview for direct `write_file` edits. Command artifacts carry command text, execution profile/isolation/cwd metadata, exit code, duration, bounded stdout/stderr fields, detected test-report paths, parsed JUnit/SARIF summaries, failing JUnit test previews, and SARIF finding previews for report files inside the execution workspace. When a run finishes, the main process derives a verification summary from command artifacts: command count, failed exits, parsed report count, and failed/passed/unknown report counts. Failed verification summaries are used as lifecycle gates for task-worktree PR draft, PR creation, and merge actions. The Electron main process updates the active task run from `AgentRunEvent` tool-call/tool-result events and from `ApprovalManager` audit events, then sends refreshed lifecycle state to the renderer. Plan approval mode records `planMode`, injects a planning-only instruction, and advertises only local read/discovery tool schemas for that run; Activity plan cards persist approve/revise/cancel `planReview` state and can draft an approved-plan follow-up prompt after approval. Approved plans can also draft a new task-worktree execution prompt; the renderer sends `worktree.plannedFromTaskRunId`, the main process verifies that the source run is approved, the hidden worktree instruction asks the agent to finish with a `Completion notes:` checklist, and the follow-up worktree run persists both `plannedFromTaskRunId` and any parsed completion checklist for Activity audit labels. The renderer resolves that source id to show a plan-source review card with the approved checklist, changed-path count, patch-preview availability, verification status cues, and per-step completion notes. Completion notes use passed/failed verification plus patch-preview state as the base gate, then conservatively match each plan item against changed paths, command/report artifact text, and assistant close-out bullets so supported notes can cite specific files, commands, or final checklist entries. Activity can request `agent:openTaskRunEvidence` for report/source paths that are already attached to a specific command artifact; the main process resolves those paths under the session or task-worktree root before opening them. Activity can draft a follow-up repair prompt from bounded parsed report evidence, failed worktree verification can draft a worktree repair prompt that arms the same managed branch, continued worktree repairs with missing/unknown verification can draft a Rerun checks prompt seeded from the previous failed run's commands, and created PR cards can refresh a compact GitHub CLI review/check/comment/thread snapshot manually or through a renderer-owned Watch PR timer. They can also draft a Review PR prompt that carries the last refreshed PR status and bounded review feedback when present and asks the agent to inspect PR review/check state before editing. In Loop mode, continued runs inject the latest actionable report evidence into the next iteration once, using a hidden system marker to avoid repeating stale evidence. The Activity rail still derives readable rows from chat messages when available, but it enriches each query group with durable task-run metadata and can render task-run plans, verification summaries, approval rows, and tool rows after compaction or restoration.

When the desktop prompt payload includes `worktree: true`, the main process creates a git worktree under the app-data `task-worktrees` directory using a branch named `arivu/task-...`, records the worktree path/branch/base commit on the task run, and constructs the `Agent` with the worktree as its execution cwd. When the payload includes `worktree: { enabled: true, taskRunId }`, the main process validates that the referenced run has a ready managed worktree, constructs the `Agent` with that existing worktree as cwd, and records `continuedFromTaskRunId` on the new run. This continuation path is used by Fix verification, Rerun checks, created-PR Review PR prompts, and repair-history Replay prompts. Replay payloads can also include `replayOfTaskRunId`; the main process validates that evidence run is worktree-backed and resolves to the same managed branch/path before recording it on the new run. The renderer follows the persisted ids to render a repair history chain from the original failed worktree run through later fix/rerun/replay attempts; each row can focus the matching Activity group for prior evidence, rows with an openable managed worktree reuse the guarded task-worktree Open action, Compare renders compact prompt/status/verification/command/report differences plus per-file added/removed/shared path deltas against the current attempt, Replay drafts a continuation prompt on the current run using verification commands from the selected evidence attempt, replay outcomes are grouped by their evidence run with latest verification status, and repeated failed replay outcomes expose a Review prompt handoff that keeps the same worktree armed. The task-run worktree record can also persist sync conflict metadata with conflicted files and original/task branch heads, letting Activity keep the conflict visible after reload until the user continues or aborts it. Conflict file rows reuse `agent:taskWorktreeAction`; the main process only opens paths that are present in the stored conflict file list and resolve inside the managed worktree. The saved session `cwd` and project grouping remain pointed at the original project. A hidden system message tells the model that edits are isolated and must be summarized with the worktree path/branch.

The renderer can call `agent:taskWorktreeAction` for the active run. Open validates the stored worktree metadata against Arivu's managed app-data `task-worktrees` root, then opens that folder for inspection without mutating the audit record. Open conflict file also validates the stored worktree metadata, requires an active conflict record, requires the requested path to be in that conflict record, resolves it under the managed worktree with symlink containment checks, and opens the file through the OS. Refresh stores a changed-file summary on the task run without clearing any active conflict. Preview stores a bounded unified diff, including untracked files, on the task run and renders it in Activity, but rejects while a conflict is active. Sync commits dirty task worktree changes, merges the current original checkout head into the task branch, clears stale preview/PR metadata, and either stores the updated diff or records conflicted files plus branch heads for manual resolution. Continue conflict stages the user's resolved files and completes the merge commit; Abort conflict runs `git merge --abort` and clears the conflict record. PR draft prep requires a stored patch preview, commits dirty task worktree changes locally, and stores title/body/branch/commit plus push and GitHub CLI create commands on the task run without pushing. Create PR requires that saved draft, verifies the task worktree is still clean at the drafted commit, pushes the task branch, runs `gh pr create --draft`, and stores the returned PR URL and timestamps. Refresh PR requires a created PR URL, runs `gh pr view --json state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,comments,reviews,url`, makes a best-effort `gh api graphql` lookup for review threads, stores a compact review/check/comment/thread summary on the pull-request metadata, and the renderer derives a conservative ready/blocked/waiting/unknown merge cue from that snapshot. Watch PR is renderer-scoped state: after the user starts it on a created PR card, Arivu repeats the same `refresh_pr` IPC action every 90 seconds for that active session, shows last-refresh or error status in the card, and clears the watcher when the user stops it, changes sessions, or the PR card disappears. Merge is intentionally conservative: the original checkout must be clean, changed worktrees must have a stored patch preview, Arivu commits any dirty task worktree changes with a local task commit, then fast-forwards the original checkout to the task branch. PR draft prep, Create PR, and Merge reject runs whose persisted verification summary is failed or whose worktree has an active conflict. For failed verification, Activity offers Fix verification, which composes a repair prompt from run-level command/report evidence and arms continuation of the same ready worktree. For continued repair runs with unknown verification, Activity offers Rerun checks, which composes a verification prompt and reuses commands from the prior failed run when available. For created PRs, the PR card offers Refresh PR, Watch PR, and Review PR, which composes a continuation prompt with PR URL/title/base/remote/commit details, latest verification summary, last refreshed PR status and bounded review feedback when present, and suggested verification commands. Passed verification renders a promotion hint in Activity, with copy adjusted for whether the worktree still needs Preview, already has a patch preview, has prepared PR metadata, or has a created draft PR. Discard removes an unmerged worktree and task branch. Cleanup removes a merged worktree and task branch after the original checkout has already advanced.

Settings uses `agent:listTaskWorktrees` to build a session-backed inventory of recorded task worktrees. The main process treats saved task-run metadata as the authority, checks whether each stored worktree folder still exists, includes verification status/summary, and exposes only valid lifecycle actions: Open for present managed worktrees, PR draft prep/Create PR for previewed ready worktrees without failed verification, Discard for ready/failed worktrees, and Clean up for merged worktrees. PR actions and Discard/Clean up reuse `agent:taskWorktreeAction`, so stale rows with missing folders still go through the same git worktree prune and task-branch deletion path.

Settings also calls `policy:list` to render the capability policy matrix from `src/permissions/capabilityPolicy.ts`. The matrix uses the same `evaluateCapabilityPolicy` decisions that `ApprovalManager` and the Tools drawer use, includes shared examples/risk/default-posture metadata, applies any stricter overrides saved for the current workspace root, and highlights the currently selected trust mode so policy explanation stays tied to enforcement. Workspace override rows show their current inherited or stricter effect, but can only save `prompt` or `deny`. Settings saves workspace policy overrides and scope rules back to config as absolute-root keyed entries; runtime approval managers load those rules from the detected session workspace before executing tools. Scope rules currently enforce blocked path prefixes and network destination-domain allowlists. Activity rows reuse the shared tool-name capability classifier and the saved approval audit trail to show each tool call's policy capability, effect, trust mode, override, target scope, and reason. When a restored transcript row has no task-run approval record, the renderer labels the capability as inferred from the tool name.

The desktop `context:compact` IPC action compacts the active saved session without calling a model. It preserves normal system prompts, replaces older non-system messages with a hidden system compaction note, converts retained tool calls/results into plain transcript text, saves the session, and returns updated state to the renderer.

Desktop composer slash commands are handled in the renderer before a prompt is sent to the model. `/compact` calls the existing compact-context IPC flow when the active chat is eligible, `/session` renders local chat/provider/context details without creating a model turn, `/tools` opens the same tool drawer used by the prompt `+` menu, `/skills` opens the skill loader, `/files` opens the workspace file-context picker, and `/browser` opens or focuses the separate browser window. Unknown slash commands are kept in the composer and surfaced as local UI errors instead of being sent as prompts.

The desktop browser has two isolated Electron targets. The visible target is a separate maximized `BrowserWindow` with a native tab shell; each visible tab is backed by its own `BrowserView` and keeps independent URL/title/loading/history/log/screenshot state. The background target is a hidden `BrowserWindow` used by default for browser tool calls. Visible and background targets share Arivu's persistent isolated browser partition so cookies and login state can carry across Arivu tabs and browser sessions without using the user's Chrome profile. Chrome DevTools MCP remains optional through normal MCP configuration and is preferred for visual screenshot work, performance traces, network analysis, or real Chrome behavior when configured.

## Tool model

Tools are registered as:

```ts
type ToolDefinition = {
  schema: ToolSchema;
  execute(args: unknown): Promise<string>;
};
```

Arguments are validated with `zod`. Tool results are returned as strings and appended as `tool` messages.

The current tool set is:

- `list`
- `read`
- `search`
- `web_search`
- `current_datetime`
- `current_location`
- `list_skills`
- `read_skill`
- `mcp_list_tools`
- `mcp_call_tool`
- `browser_open` (desktop only)
- `browser_screenshot` (desktop only)
- `browser_snapshot` (desktop only)
- `browser_console` (desktop only)
- `browser_click` (desktop only)
- `browser_type` (desktop only)
- `apply_patch`
- `write_file`
- `run`
- `git_status`

The `run` tool executes commands with `execa` using `shell: true`, with `cwd` set to the active workspace root. Trust-mode checks happen before command execution, and destructive-command detection still applies in trusted mode.

`web_search` sends public search queries to Tavily when a Tavily API key is configured. It uses `basic` search depth and compact result output by default. If no Tavily key is available, it falls back to keyless Bing RSS search. News-like fallback queries are routed to Bing News RSS, stale generated years are refreshed to the current UTC month/year, and Bing News redirect links are decoded before being shown to the model. Search queries should not include secrets, private code, or personal data.

`current_datetime` reads local system clock/locale information. `current_location` returns approximate timezone-derived location context only; it does not use GPS, IP lookup, browser geolocation, or any network lookup.

`list_skills` discovers Markdown skills under the global skills directory. `read_skill` returns the selected `SKILL.md` content. The desktop app also exposes the same directory through a skills list and add-skill Settings form that creates `<name>/SKILL.md`. The agent injects a transient system instruction listing discovered skills and instructing the model to read matching skills before acting.

`mcp_list_tools` and `mcp_call_tool` connect to configured MCP servers using the official TypeScript SDK's stdio client transport. Each call opens a short-lived client, connects, performs the list/call request with a timeout, formats MCP content blocks into text, and closes the client.

Browser tools are registered only when the desktop main process provides a `BrowserToolController`. `browser_open` normalizes localhost-style URLs and opens the hidden isolated browser target by default, or the separate visible window when `mode: "visible"` is supplied. In visible mode, `browser_open` can create a new tab with `newTab: true` or target a known tab with `tabId`; follow-up screenshot/snapshot/console/click/type tools also accept `tabId` and otherwise use the active visible tab. `browser_snapshot` returns compact page text and key interactable elements, `browser_console` returns collected console entries, `browser_screenshot` writes a temporary PNG, `browser_click`/`browser_type` operate by selector or visible label text, and `browser_click_at` clicks exact screenshot/CSS coordinates when selectors fail. Browser open/click/type actions route through the capability policy table; readonly blocks them, ask prompts, and trusted prompts for external/submitting actions while allowing low-risk isolated browser interactions.

## Desktop IPC

The preload bridge exposes a small `window.arivu` API instead of giving the renderer direct Node access. Current desktop IPC capabilities include:

- app state refresh
- workspace open and create
- image file selection for multimodal prompts
- draft chat project selection
- new chat
- session list, session open, and session delete
- config save
- model list through a selected provider's OpenAI-compatible `GET /models`
- tools list from the local registry for the composer drawer
- browser window state, visible tab create/select/close, legacy bounds no-op, navigation, URL open, default hidden mode, and screenshot capture
- prompt send
- approval request/response

## Config and data paths

Config is stored outside target workspaces:

- macOS config/data: `~/Library/Application Support/arivu`
- XDG config: `$XDG_CONFIG_HOME/arivu`
- XDG data: `$XDG_DATA_HOME/arivu`
- Overrides: `ARIVU_CONFIG_HOME`, `ARIVU_DATA_HOME`

Sessions live under the app data directory in `sessions/`. The desktop sidebar groups project sessions under expandable project rows, shows unassigned sessions in the top-level Chats section, and the History view lists saved sessions across workspaces.

Model and web-search environment variables are merged with saved config. Non-empty env vars override saved config. `ARIVU_*` env vars are preferred, with matching legacy `SHANKINSTER_*` env vars still accepted as fallbacks. The Tavily key is resolved from `ARIVU_TAVILY_API_KEY`, then legacy `SHANKINSTER_TAVILY_API_KEY`, then `TAVILY_API_KEY`, then saved `tavilyApiKey`.

During the rebrand migration, Arivu copies missing files from the legacy `shankinster` config/data directories into the new `arivu` directories. Existing Arivu files are never overwritten.

Saved config supports both the runtime `baseUrl`/`model`/`apiKey` fields and desktop-managed `providers` plus `activeProviderId`. Desktop Settings validates providers before saving: provider names must be unique, providers without a URL remain unsaved drafts, and saved providers need both a URL and model id. Use `auto` as the model id to enable automatic model routing. When the active provider changes, the main process mirrors that provider into the runtime `baseUrl`, `model`, and API key used by the OpenAI-compatible client.

The model-list IPC call is scoped to one provider at a time. The renderer passes the selected provider's base URL and optional API key, the main process calls only that provider's `GET /models`, and the dialog searches that provider's result list. Model ids from multiple providers are not merged because selecting a model also implies which base URL and key should be used.

Automatic model routing happens in the Electron main process before the `OpenAICompatibleChatClient` is created. When the saved model is `auto`, the controller classifies the normalized prompt content into fast, coding, reasoning, vision, background, or general work, fetches and caches provider `/models` results for ten minutes when available, chooses a concrete provider/model with `src/agent/modelRouter.ts`, and passes that concrete model to the API client. The saved session keeps `model: "auto"` so later turns can be routed again, while `selectedModel`, `selectedProviderName`, and `modelSelectionReason` record the last concrete model used for history and runtime details.

Saved config also includes `mcpServers`, a JSON object keyed by server name. Each server has `command`, `args`, `env`, and `disabled`. The desktop renderer can edit this JSON through Settings; the Electron main process validates and persists it through the shared config schema.

Global skills live under:

```text
<app data dir>/skills/<name>/SKILL.md
```

Set `ARIVU_SKILLS_HOME` to override this path in development or tests.

## Build output

`npm run build` uses `tsup` to generate:

```text
dist/cli.js
dist/cli.js.map
dist/cli.d.ts
```

The npm binary points to `dist/cli.js`.

`npm run desktop:build` generates:

```text
dist-desktop/main/main.js
dist-desktop/preload/preload.cjs
dist-desktop/renderer/
```

Electron loads Vite in development and `dist-desktop/renderer/index.html` after a production desktop build.
