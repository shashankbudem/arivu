<p align="center">
  <img src="assets/arivu-logo.svg" alt="Arivu logo" width="96" height="96">
</p>

# Arivu

Arivu (`arivu`) is a local coding agent with a desktop app, terminal TUI, and one-shot CLI mode. It can inspect a workspace, call an OpenAI-compatible model, send multimodal text+image prompts, run validated tools, search the web, control hidden and visible isolated browser targets, use globally installed local skills, call configured MCP tools, get local date/time context, edit files, execute approved commands, and save resumable sessions.

## Quick start

```bash
npm install
npm run build
ARIVU_API_KEY=... ARIVU_MODEL=... npm run dev -- "summarize this repo"
```

Run the desktop app:

```bash
npm run desktop:dev
```

Run the TUI:

```bash
npm run dev
```

The desktop app includes a compact workspace sidebar with recent workspace rows, expandable project chat groups, standalone chats, pinned and renamed chat metadata, new/open/create workspace controls, full chat history with delete controls, a prompt `+` menu, direct searchable model switching from the composer, browser-style chat search, a separate tabbed browser window with hidden agent browser tools by default, a token-aware multimodal composer with pasted and dropped image attachments plus workspace file-context attachments, one-shot read-only plan approval mode, one-shot bounded agent loop mode, one-shot task worktree mode, inline available-tools drawer, local context compaction for long chats, Markdown-rendered replies with highlighted copyable code blocks, light/dark modes, UI concept samples, a slim collapsible Activity rail grouped by durable per-query task runs with copyable audit summaries, settings view, and approval modal. The TUI remains available as a terminal fallback.

After building, the package exposes the `arivu` binary.

## Configuration

Environment variables:

- `ARIVU_API_KEY`
- `ARIVU_TAVILY_API_KEY`
- `TAVILY_API_KEY`
- `ARIVU_BASE_URL`
- `ARIVU_MODEL`
- `ARIVU_TRUST_MODE`
- `ARIVU_SKILLS_HOME`

Matching legacy `SHANKINSTER_*` environment variables are still accepted as fallbacks, but new setup should use `ARIVU_*`.

On first run after the rebrand, Arivu copies missing config, sessions, and skills from the legacy `shankinster` app data directory into the new `arivu` directory without overwriting newer Arivu files.

CLI config:

```bash
arivu config set model gpt-4.1
arivu config set baseUrl https://api.openai.com/v1
arivu config set tavilyApiKey tvly-YOUR_KEY
arivu config get
```

Provider health check:

```bash
arivu doctor
arivu doctor --json
```

`arivu doctor` validates the configured API key, model listing, selected model, basic chat completions, streaming, tool calling, and Tavily connectivity. When no API key is configured, network checks are skipped instead of probing a live endpoint. Desktop Settings doctor also saves Tool calling as `Disabled` for an auto-mode saved provider when the forced tool-call probe proves unsupported.

Supported trust modes:

- `ask`: reads and isolated browser actions are automatic unless the workspace policy tightens them; writes, commands, network searches, and MCP process starts require confirmation.
- `readonly`: local list/search/read/local context/git status and isolated browser actions are allowed unless the workspace policy tightens them; writes, commands, and MCP process starts are blocked.
- `trusted`: reads, workspace writes, and isolated browser actions are automatic unless the workspace policy tightens them; risky workspace writes, commands, network searches, and MCP process starts still require confirmation.

These modes are backed by Arivu's capability policy table, which maps harness capabilities such as `read_repo`, `write_workspace`, `run_command`, `network_fetch`, `browser_control`, and `mcp_call` to allow/prompt/deny decisions. Desktop Settings shows that matrix with examples, risk notes, default posture, and the active trust-mode reason for each capability. Approval audit records also keep a compact scope such as path, command, network host, browser target, or MCP server/tool, and Activity shows that target beside the governing policy. Settings can save stricter policy overrides for the current workspace. Workspace overrides can require approval or block enforceable capabilities, but cannot turn a built-in prompt/deny rule into allow. Settings can also save workspace scope rules: blocked workspace path prefixes for reads, writes, and patches; optional network domain allowlists for network tools; optional MCP server allowlists; and optional browser target-class allowlists for `background`, `visible`, `local`, `file`, and `public` browser targets. Workspace policy presets apply common combinations such as default, review-first, local-only, and locked-down. Named local policy profiles can save/apply reusable override and scope-rule bundles, a checked-in `.arivu/workspace-policy.json` team bundle can be discovered and applied explicitly, and the same panel can copy/apply normalized workspace policy JSON. Active scope rules are summarized in Settings and shown as compact chips on affected rows in the Tools popover.

Team policy bundles use the same normalized policy envelope:

```json
{
  "kind": "arivu.workspacePolicy",
  "version": 1,
  "name": "Team review",
  "description": "Ask before commands and keep browser targets local.",
  "overrides": {
    "run_command": "prompt",
    "network_fetch": "deny"
  },
  "scopeRules": {
    "allowedBrowserTargetClasses": ["background", "local"]
  }
}
```

In the desktop app, Settings can save multiple OpenAI-compatible LLM providers. Each provider has a unique name, base URL, model id, tool-calling capability mode, image-input capability mode, and optional API key. Blank provider drafts are not saved; enter a valid URL and model id before saving a provider. Use `Auto` as the model id when Arivu should choose a concrete model for each prompt.

Settings also has a separate Browser task LLM choice. Select a configured provider, then use the searchable model picker to load that provider's `/models` list or enter a model ID manually. Leaving the model override blank follows the selected provider's default; leaving the provider blank follows the chat model selected for that turn. Up to five ordered fallback models can be configured. Arivu rotates through them only when a model has an infrastructure/configuration failure before the browser task makes page progress; once progress exists, the task preserves its checkpoint instead of blindly replaying actions through another model.

Arivu exposes a guarded runtime control plane to its own agent and lists it in the desktop Tools drawer. `arivu_runtime_status` reports browser-model candidates and effective tool state, `arivu_select_browser_model` can change the browser task model for the current run or chat session, and `arivu_set_tool_state` can temporarily disable or restore registered tools. Runtime changes do not rewrite saved Settings, cannot re-enable a tool disabled by the user, and cannot disable `ask_user` or any `arivu_*` control tool. `arivu_propose_mcp_server` records a review item in Settings > Integrations; it never starts, installs, or enables the proposed command. Accepted proposals are first added to MCP JSON as disabled entries with blank credential placeholders.

Arivu can maintain a per-endpoint, per-model capability catalog with `arivu models sync`. The catalog records availability and provider-reported context windows, detects added and removed models, and lets desktop, TUI, and CLI size context budgets for the model actually selected instead of applying one provider-wide guess. Use `arivu models status`, `arivu models probe-context <model>`, and `arivu models schedule --install` to inspect, probe, or schedule the macOS daily refresh. See `docs/model-catalog.md` for storage, pacing, and launchd details.

The active provider determines the base URL, model, API key, tool-calling behavior, and image-input behavior used for chat. The model picker opens from the composer model button or Settings and loads models from the selected provider's OpenAI-compatible `GET /models` endpoint. If two or more providers are configured, manual picker lists still show only the active provider's models, so switching providers changes which model list is searched. `Auto` is the exception: at send time, Arivu classifies the prompt as fast, coding, reasoning, vision, background, or general work, checks cached provider model lists when available, picks a concrete model, and stores the last picked model in the session history. Provider tool calling defaults to `Auto fallback`, which sends OpenAI tool schemas and retries in Markdown if the endpoint rejects them. Use Tool calling `Disabled` for plain-chat endpoints that reject tool schemas, or `Enabled` when tool-call failures should surface instead of downgrading. Provider image input defaults to `Auto`, which preserves OpenAI-compatible image-part behavior. Use Image input `Disabled` for text-only endpoints so image prompts fail before sending image data, or `Enabled` for providers/models known to accept image parts. When an auto-mode provider rejects tool schemas or image content parts, Arivu records that observation and saves the matching capability as `Disabled` for future requests; explicit `Enabled` choices are not overwritten automatically. If a provider does not expose `/models`, or returns no models, enter the model id manually or rely on the provider's Auto fallback. Settings also allow saving a Tavily API key for web search.

NVIDIA model latency note, measured on June 20, 2026: `deepseek-ai/deepseek-v4-pro` and `nvidia/nemotron-3-ultra-550b-a55b` were both present in NVIDIA's `/models` response, but chat startup latency was high and variable. DeepSeek V4 Pro timed out on tiny chat probes at 120-180 seconds. Nemotron 550B completed one short streaming sample with about 15s TTFT and about 21 approximate output tokens/sec after the first token, then another short sample timed out after 180 seconds. Treat these large models as background/experimental choices rather than default interactive chat models unless a fresh benchmark shows better latency.

MCP servers can be configured in desktop Settings as JSON:

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    "env": {},
    "disabled": false
  }
}
```

Configured MCP servers expose tools to the agent through `mcp_list_tools` and `mcp_call_tool`. Listing or calling MCP tools can start the configured MCP process, so both require approval and are blocked in `readonly` mode. Workspace scope rules can restrict MCP discovery and calls to named configured servers.

Web search requires approval before the query leaves the machine. It uses Tavily when `ARIVU_TAVILY_API_KEY`, `TAVILY_API_KEY`, or saved `tavilyApiKey` is available. Without a Tavily key, the tool falls back to keyless Bing RSS search; news-like queries use Bing News RSS, normalize stale generated years to the current date, and decode Bing news redirect links.

Browser control:

- The desktop app has a hidden isolated browser target for agent-driven page inspection and a separate maximized visible browser window for explicit visible browsing.
- The visible browser window has native tabs. Each visible tab keeps its own URL, title, loading state, navigation history, console log buffer, and latest screenshot metadata while sharing the same persistent Arivu browser profile for cookies/session state.
- The Review control can select page elements or rectangular regions, collect multiple comments, preview or hold design adjustments, discard them, and send the notes plus screenshot evidence directly into the Arivu composer. The same panel can send the visible tab to the background agent or adopt the agent's background page as a visible tab.
- Device mode includes common presets, custom dimensions, rotation, and a scaled preview for viewports larger than the window, including 4K. The shell supports dark/light system themes, visible keyboard focus, roving tab focus, and standard browser shortcuts.
- Browser tools include `browser_state`, `browser_select_tab`, `browser_open`, `browser_screenshot`, `browser_task`, `browser_execute_javascript`, and lower-level snapshot, console, click, type, scroll, and select helpers. `browser_task` is the preferred multi-step in-page interaction path. Its default wall-clock ceiling is 70 minutes; explicit budgets below 10 minutes are raised to 10 minutes so the configured 35-second loop pacing and slow provider responses cannot terminate a healthy task after only one or two steps. Completed tasks still return immediately.
- The browser-task page agent is capped at 100 loops by default and waits 35 seconds between loops to avoid hammering its LLM provider. Its default wall-clock budget is 70 minutes; runs remain cancellable, and individual tool calls can request smaller loop caps or time ceilings of at least 10 minutes.
- Browser-task model, loop cap, and loop delay can be configured in Settings. The prompt options menu and `/browsermodel` command provide a faster model picker; `/browsermodel <model-id>` pins a model directly.
- Browser-task model calls retry HTTP 429/503 responses with bounded `Retry-After` backoff and remove explicitly rejected top-level request parameters before one compatibility retry. Persistent endpoint/configuration failures open a short model-specific circuit instead of repeatedly burning agent loops. Failed task runs persist the chosen model, bounded trace, and proxy diagnostics in Activity.
- `browser_open` runs hidden/background by default and accepts URLs, localhost targets, or plain search text. Follow-up browser actions without an explicit `mode` target the active browser, so a login completed in the visible browser is not accidentally ignored by later hidden-mode calls. In visible mode, `browser_open` can pass `newTab: true` to create a visible tab or `tabId` to target an existing target; website-created popups open as secure maximized child windows and are registered in the same tab state so the agent can address them by `tabId`. Self-closed popup tabs are pruned immediately. A delegated task whose popup closes returns `stopReason: "target_closed"` so the supervising agent can inspect `browser_state` and verify the originating tab instead of waiting for timeout. Other browser tools default to the active visible target. `browser_state` lists the active browser mode, active visible target, URLs/titles/loading state, and last snapshot/screenshot timestamps; `browser_select_tab` switches targets before inspection or interaction. Prompts that ask about the current/latest/open browser, page, tab, or a recent browser-task continuation automatically record `browser_state` plus a targeted `browser_screenshot` before the model answers.
- Agent-driven browser opens, screenshots, snapshots, console reads, clicks, coordinate clicks, typing, and script execution run without approval by default so browser-assisted tasks can continue smoothly. Activity still records those actions, and workspace capability policy can require approval or block browser control for sensitive workspaces. Browser `file://` URLs are confined to the active workspace. Workspace scope rules can restrict browser actions to target classes such as hidden/background, visible, local, file, or public pages.
- The prompt `+` menu and `/browser` command can open or focus the separate browser window for the user.
- The visible browser address field accepts URLs, localhost targets, and plain search queries. Non-URL text opens a Google search.
- Browser snapshots inspect the main page, child frames, open shadow roots, and a best-effort Chrome accessibility tree. Screenshot results include the saved PNG plus frame-aware visual metadata with CSS viewport coordinates for visible interactive elements.
- `browser_click` searches frames and open shadow roots by selector/text/ARIA. `browser_click_at` is the fallback for pages where DOM selectors fail but a screenshot or visual metadata exposes a target coordinate.
- `browser_execute_javascript` runs a short model-authored script in the current page's own JS context — the same sandbox the page runs in, with no Node, filesystem, or OS access. It is for reading or computing a value, or a small DOM change the other browser actions can't express, not a general substitute for them. Bounded to a 15-second execution timeout and a 20,000-character script; large results are truncated. Like other browser actions it runs without approval by default; it is marked risky so a workspace policy that escalates browser control also gates it. The delegated in-page agent used by `browser_task` has its own separate, opt-in script tool (`allowJavaScript`); this is the directly callable, single-shot version for the main agent.
- The in-page agent behind `browser_task` always has its own `search_web` tool, unconditionally (unlike the opt-in script tool). It routes through the same per-task loopback proxy as the in-page LLM calls, authenticated with that task's own bearer token, and reuses the same Tavily-or-Bing search backend as the main agent's `web_search`. Its system instructions steer it to reach for this when it does not know how a specific field, control, or workflow on the current site works, not as a first resort. The main agent can also help directly: if a `browser_task` trace shows the same interaction failing repeatedly, `web_search` for how the site actually works before re-running with a clearer instruction.
- Browser screenshots are saved under the app data directory in `browser-screenshots`. For visual screenshot work that needs a real Chrome surface, configure Chrome DevTools MCP and let the agent call it through `mcp_list_tools`/`mcp_call_tool`.
- Visible-tab screenshots use the currently attached Electron surface and fall back to CDP capture. This avoids stale black compositor regions after switching from a website-created popup back to a normal tab.
- Browser Settings includes history and data clearing, per-site permissions, downloads, an OS-encrypted password manager, contact/autofill profiles, profile import, and unpacked extension management. Import accepts Chrome-compatible password CSV or Arivu JSON containing cookies, credentials, and autofill profiles. Chrome Web Store installation is not available in Electron.
- Chrome DevTools MCP is optional for the default hidden browser path, but recommended when deeper performance traces, network analysis, Lighthouse-style audits, screenshots, or real Chrome behavior are needed.

Local context tools:

- `current_datetime` returns local date, local time, timezone, UTC offset, UTC timestamp, and locale from the system clock.
- `current_location` returns timezone-level location context only. It does not use GPS, IP lookup, browser geolocation, or network location.

Local skills:

- Add global skills under `~/Library/Application Support/arivu/skills/<name>/SKILL.md` on macOS, or under `$ARIVU_SKILLS_HOME/<name>/SKILL.md` when that override is set.
- In the desktop app, the prompt `+` menu and `/skills` command show installed skills. Selecting Load queues a skill for the next prompt; after the prompt is sent, the full `SKILL.md` is saved as hidden chat context.
- Settings can add a new skill by writing `<name>/SKILL.md` in the global skills directory.
- The agent advertises discovered skills to the model and provides read-only `list_skills` and `read_skill` tools.
- If a prompt names a skill with `$skill-name`, the agent attaches that `SKILL.md` to that model request. If the task clearly matches a skill description, the model is instructed to call `read_skill` before acting.

## Desktop workflow

- Startup and `New chat` start a fresh draft without assigning a workspace or project.
- Before the first prompt, the prompt `+` menu can route the draft chat to `No project`, a recent project, or a workspace opened from the selector. After the first prompt is sent, project selection is hidden.
- `Open` switches to an existing workspace folder.
- `New workspace` creates a folder and switches the app into it.
- The Workspaces section shows recent workspaces from saved project chats. Click the folder/name area to reopen that workspace, or use the chevron to expand its chats. If a saved workspace folder is missing, the row is marked unavailable and can be forgotten while keeping its chats in standalone history. Chats with `No project` appear in the top-level Chats section.
- `History` shows saved chats across workspaces, can reopen them, rename them, pin or unpin them, and delete saved sessions. Pinned chats sort above normal recency order in history, workspace chat groups, and standalone chat previews.
- Header actions are icon-only with hover/focus tooltips. `Search chat` opens a browser-style find bar with match navigation. `Browser window` opens, focuses, or hides the separate browser window. `Refresh state` reloads workspace, config, and active session state from the Electron main process. `Compact context` summarizes older saved messages locally and keeps the most recent messages for future model requests; oversized in-flight model requests are also compacted transiently before provider calls without rewriting the visible chat, with the active user request pinned separately from trimmed tool/browser output. When that pinned request is multimodal, Arivu preserves its `image_url` parts while capping oversized text parts.
- Desktop keyboard shortcuts mirror common header/composer actions: `Cmd/Ctrl+K` focuses the composer, `Cmd/Ctrl+N` starts a new chat, `Cmd/Ctrl+F` opens chat search, `Cmd/Ctrl+,` toggles Settings, `Cmd/Ctrl+R` refreshes Arivu state, `Cmd/Ctrl+Shift+B` toggles the browser window, `Cmd/Ctrl+Shift+T` opens Tools, and `Cmd/Ctrl+Shift+S` opens Skills.
- Press `Enter` to send a message, or `Shift+Enter` for a newline.
- User messages expose icon-only Edit and Copy actions. Failed user messages also expose Retry without removing the original query. Agent replies expose icon-only Retry and Copy actions; Retry regenerates from the related user query without posting a duplicate user bubble. Hover or focus shows each action label.
- Failed prompts remain in the transcript and also show an icon-only Retry action in the error strip. A blank assistant response without tool calls is treated as a failed run instead of a completed empty reply.
- Large pasted text is checked against a local estimated token budget before it is inserted. Pasted or dropped PNG, JPEG, WebP, and GIF images are attached to the next prompt automatically. Workspace text/code files can be attached from the prompt `+` menu or `/files`; Arivu sends their bounded contents as quoted file context with the next prompt.
- The composer supports slash commands. Type `/` to open local commands: `/compact` compacts the current chat context, `/session` shows chat id, estimated context used/remaining, model/provider, agent loop state, latest task-run status, and workspace details, `/tools` opens the available tools list, `/skills` opens the skills selector, `/files` attaches workspace text/code files to the next prompt, `/browser` opens the separate browser window, `/plan` toggles read-only plan approval for the next prompt, `/loop` toggles bounded loop mode for the next prompt, and `/worktree` toggles isolated git worktree mode for the next prompt.
- The TUI supports local slash commands including `/status`, `/diff`, `/compact [n]`, `/sessions [n] [--pick] [--search text] [--workspace text] [--pinned|--unpinned] [--project|--standalone]`, and `/resume <id>`. `/compact` compacts the active saved session locally, `/sessions --pick` opens a selectable session picker, and `/diff` shows a read-only staged, unstaged, and untracked git summary for the active workspace. TUI pane shortcuts include `PageUp`/`PageDown` for the focused pane, `Shift+PageUp`/`Shift+PageDown` for Activity, `Ctrl+Home`/`Ctrl+End` for focused-pane top/bottom, and `Ctrl+Shift+Home`/`Ctrl+Shift+End` for Activity top/bottom.
- Plan approval mode is off by default and one-shot when enabled from the composer or `/plan`. A planning run may use local read/discovery tools such as list/read/search/git status, but it does not expose write, shell, browser, web-search, or MCP tools. The resulting task run is marked as Plan approval in Activity. Captured plan cards expose Approve, Revise, and Cancel review actions; approved plans then expose Use approved plan to draft the execution follow-up prompt or Start worktree to draft the same plan while arming a new isolated task worktree. The follow-up run records the approved plan task-run id on its worktree metadata, asks the agent to end with a parseable `Completion notes:` checklist, persists that close-out checklist on the task run, and Activity renders an Approved plan source review card with the source checklist, changed paths, patch-preview state, verification cues, and evidence-based completion notes for each planned step. Completion bullets can carry bounded `[evidence: file=...; command=...; report=...; check=...]` labels, and notes cite those labels plus matching changed files, verification commands, parsed report evidence, TypeScript and ESLint diagnostics, refreshed PR checks, or assistant-authored close-out bullets when Arivu can find a conservative textual match; otherwise the step stays marked as needing evidence.
- Agent loop mode is off by default and one-shot when enabled from the composer. A looped prompt runs up to 5 high-level iterations, asks the model to continue/done/blocked at the end of each iteration, strips that control line from the transcript, and can be stopped cooperatively after the current iteration. When a continued loop iteration produces failed parsed JUnit/SARIF evidence, Arivu carries the latest structured report evidence into the next iteration once. Loop progress is saved on the session, and each task run keeps a compact iteration ledger with the decision, tool/artifact deltas, and output preview for Activity and copied audits.
- Task worktree mode is off by default and one-shot when enabled from the composer or `/worktree`. It requires a git-backed project with at least one commit, creates a branch named `arivu/task-...` under Arivu's app-data `task-worktrees` directory, runs agent tools against that isolated checkout, and records the branch/path/base commit on the task run. The Activity rail can open the worktree folder, refresh the changed-file summary, generate a bounded patch preview, sync the task branch with the current original checkout, show conflicted files when sync needs manual resolution, open individual conflicted files from the conflict card, continue or abort that conflict resolution, prepare a pull-request draft, create a remote draft PR through GitHub CLI, refresh created PR review/check/comment status plus line-level review threads and bounded check evidence through GitHub CLI manually or through a user-started Watch PR background refresh, persist compact PR-update notifications when refreshed review/check/feedback state changes, derive GitHub Actions log commands and external check-detail capture commands from check URLs when possible, fetch failed/cancelled/unknown check evidence into bounded command artifacts, derive a ready/blocked/waiting PR merge cue from the last refreshed snapshot, fast-forward merge a previewed completed worktree into the original clean checkout, discard an unmerged task worktree, and clean up a merged worktree/branch. Failed verification summaries and active conflicts block PR draft/Create PR/Merge promotion until fixed, Activity can draft a repair prompt that continues the same managed worktree branch, continued repair runs with unknown verification can draft a Rerun checks prompt seeded from the previous failed commands, created PR cards can draft a Review PR continuation prompt that includes the last refreshed PR status, named check evidence, recent PR updates, derived check-evidence commands, fetched evidence artifact ids, and bounded review feedback when present, continued worktree attempts render as a repair history chain with Details actions for prior Activity evidence, Open controls for managed worktrees, Compare summaries with per-file deltas against the current attempt, Replay prompts that rerun prior verification commands in the current worktree while recording replay lineage and grouped replay outcomes on the resulting run, and a Review handoff prompt when repeated replay outcomes fail for the same evidence run. Passed worktree verification shows the next promotion step directly in Activity. Settings also lists recorded task worktrees across saved sessions with present/missing folder state, verification status, Open for present managed worktrees, PR draft prep/Create PR for eligible previewed worktrees, Discard for ready/failed worktrees, and Clean up for merged worktrees.
- The prompt `+` menu contains project routing, image attachment, browser-window access, the tools drawer, skills list, add-skill access, and MCP settings access. Model switching is available directly from the composer model button.
- Images are encoded as data URLs and sent through OpenAI-compatible `image_url` content parts.
- Assistant responses are rendered as Markdown. Fenced code blocks use Shiki highlighting and include an icon-only copy button.
- Each desktop prompt creates a durable task run on the saved session. A run records status, selected model/provider, plan/loop/worktree metadata, loop iteration history when Loop mode is active, any captured assistant plan, tool capabilities such as read/write/browser/MCP/network, approval decisions, individual tool calls, and artifacts such as browser screenshots, direct file changes, and command output.
- Runtime self-management is intentionally narrower than Settings. The model can inspect status, switch among user-configured browser fallbacks, temporarily disable tools, and submit inert MCP proposals. Persistent provider credentials, saved tool state, and executable MCP activation remain user-owned.
- Direct-edit approval rows include bounded pre-apply previews for `apply_patch` diffs and `write_file` content, so approved, denied, blocked, and automatically allowed non-worktree writes keep review evidence in Activity after reload or compaction. Successful direct-edit artifacts also include bounded applied diffs/content previews and can draft a revert prompt seeded from the saved edit evidence. Large direct `apply_patch` / `write_file` changes are treated as risky write reviews even in Trusted mode unless a managed task worktree already owns the review boundary.
- Command artifacts include the command text, shell-vs-argv mode, parser-derived risk/analysis summary, execution profile/isolation/cwd metadata, exit code, timeout limit, timeout/signal state, duration, bounded stdout/stderr snippets, detected test-report paths, parsed JUnit/SARIF summaries, bounded failing-test/finding previews when matching report files exist inside the execution workspace, and bounded TypeScript compiler plus ESLint diagnostics from command output. Completed runs derive a verification summary from command/report artifacts, including failed exits and timed-out commands, and failed summaries gate task-worktree promotion actions. Tool calls and tool results are grouped under the user query that triggered them; the chat transcript summarizes them as paired tool steps, while the Activity rail enriches each query group with durable run metadata, per-call policy chips/details, command/report/diagnostic evidence, guarded open-report/source actions, Draft fix prompts for failed reports, timeout-aware worktree-level Fix verification and Rerun checks prompts, created-PR Review PR prompts seeded by refreshed PR review/check/comment/thread/check snapshots, derived check-evidence commands, and fetched check evidence artifacts when present, verification summaries, latest screenshot preview, and a copyable Markdown audit summary for the run. Audit summaries include the matching policy effect, reason, and compact target scope for each tool when approval audit evidence is available.
- Settings includes a Capability policy matrix backed by the same trust-mode rules used by approvals and the Tools drawer. The active trust mode is highlighted with per-capability examples, risk notes, default posture, active-mode reasons, risky-action differences, and workspace override state. The same panel can save per-workspace stricter overrides for repo reads, writes, commands, network fetches, browser control, MCP tools, and unknown capabilities, plus target-specific scope rules for paths, network domains, MCP servers, and browser target classes. Preset buttons can fill the current workspace policy with default, review-first, local-only, or locked-down profiles before saving, a Team bundle row can discover and apply `.arivu/workspace-policy.json`, named profiles can save/apply reusable local bundles, and Workspace policy JSON lets users copy/apply normalized override and scope-rule bundles. Settings and the Tools popover both summarize active scope restrictions so users can see which tool families are narrowed before a call runs.
- The left sidebar, sidebar sections, Activity rail, Activity query groups, and Activity rows can collapse. The left sidebar and expanded Activity panel can also be resized by dragging their divider handles.

## Commands

```bash
open via desktop: npm run desktop:dev
arivu                 # TUI mode
arivu "fix the failing tests"  # one-shot mode
arivu sessions
arivu sessions --search fallback --workspace arivu --pinned
arivu resume <session-id>
arivu compact <session-id>
arivu compact <session-id> --recent 12 --dry-run
arivu config get
arivu config set <key> <value>
arivu doctor
arivu doctor --json
```

Inside the TUI, use `/compact [n]` to compact the active saved session while keeping the most recent non-system messages, `/sessions` to list recent saved sessions, add the same filter flags for search/workspace/pinned/project slices, use `/sessions --pick` to choose one interactively, `/resume <session-id>` to switch into one without leaving the terminal UI, and `/diff` to inspect local staged, unstaged, and untracked changes.

## Development docs

- [Project handoff](docs/HANDOFF.md): current state, decisions, caveats, and next best work.
- [Architecture](docs/ARCHITECTURE.md): module map and runtime flow.
- [Harness](docs/HARNESS.md): control-plane/execution-plane direction, current task-run foundation, and next harness milestones.
- [Development guide](docs/DEVELOPMENT.md): setup, commands, verification, and linking.
- [Safety model](docs/SAFETY_MODEL.md): trust modes, tool permissions, and command/file guardrails.
- [Roadmap](docs/ROADMAP.md): recommended next milestones.
- [Contributing](CONTRIBUTING.md): standards for changes and reviews.
