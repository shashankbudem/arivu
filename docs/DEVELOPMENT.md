# Development Guide

## Requirements

- Node.js 20.17.0 or newer.
- npm.
- `rg` installed for the search tool.
- `git` installed for workspace detection and status.
- Optional: a Tavily API key for higher-quality web search.
- Optional: MCP server commands for testing `mcp_list_tools` and `mcp_call_tool`.

## Setup

```bash
cd /Users/shashankbudem/Documents/arivu
npm install
```

## Common commands

```bash
npm run typecheck
npm test
npm run build
npm run desktop:build
npm run desktop:dev
npm run desktop:start
npm run dev
npm run dev -- "summarize this repo"
```

Use the global command after linking:

```bash
npm link
arivu
arivu "summarize this repo"
```

## Model config

Use saved config:

```bash
arivu config set baseUrl https://integrate.api.nvidia.com/v1
arivu config set model minimaxai/minimax-m2.7
arivu config set apiKey "..."
arivu config set tavilyApiKey "tvly-..."
arivu config get
```

Or environment variables:

```bash
export ARIVU_API_KEY="..."
export ARIVU_TAVILY_API_KEY="tvly-..."
export ARIVU_BASE_URL="https://integrate.api.nvidia.com/v1"
export ARIVU_MODEL="minimaxai/minimax-m2.7"
```

Environment variables override saved config only when they are non-empty.

For Tavily, `ARIVU_TAVILY_API_KEY` takes precedence over `TAVILY_API_KEY`; both override saved `tavilyApiKey`. Use `TAVILY_API_KEY` if that is already exported in your shell.

## Manual verification

Provider health check:

```bash
arivu doctor
arivu doctor --json
arivu config set toolCalling disabled
arivu config set imageInput disabled
```

The doctor command checks API key presence, `GET /models`, selected model membership, chat completions, streaming, tool calling, and Tavily. Without an API key it reports skipped network checks, which is useful for offline setup validation. When `toolCalling` is `disabled`, doctor skips the tool-calling probe because the active provider is intentionally configured for plain chat. In desktop Settings, an unsupported tool-calling probe saves Tool calling as Disabled for auto-mode saved providers.

Basic one-shot model check:

```bash
arivu --trust readonly "Reply with exactly OK."
```

Per-model context catalog check:

```bash
arivu models sync --dry-run --max-probes 1
arivu models status
arivu models probe-context <model-id>
arivu models schedule
```

The dry run lists and probes through the configured provider without writing catalog files. A normal
sync writes `model-catalog.json` and its append-only event log under the Arivu app-data directory.
Unit tests use injected fetchers and temporary stores; they never call a real provider.

For NVIDIA-hosted very large models, do not assume `/models` availability means interactive speed is acceptable. On June 20, 2026, `deepseek-ai/deepseek-v4-pro` was available but timed out on tiny chat probes, and `nvidia/nemotron-3-ultra-550b-a55b` varied from about 15s TTFT to a 180s timeout. Re-benchmark before making either one the default desktop chat model.

Tool-calling check:

```bash
arivu --trust readonly "Use the list tool to list top-level files, then summarize them."
```

Desktop agent-loop check:

1. Run `npm run desktop:dev`.
2. Toggle `Loop` in the composer or run `/loop`.
3. Send a bounded task such as "Inspect the repo and tell me one thing to improve."
4. Confirm the working pill shows loop progress, Activity shows an agent-loop system item, the task-run group shows Loop iterations with decision/tool/artifact counts after each pass, copied audit text includes `## Loop Iterations`, and Stop Loop changes the status to stopping until the current iteration finishes.

Desktop task-run audit check:

1. Run `npm run desktop:dev`.
2. Send a prompt that uses at least one tool, for example "List top-level files and summarize them."
3. Confirm the Activity query group shows the selected model/provider, run status, and capability chips such as `Read`.
4. When an assistant reply includes a `Plan:`/`Approach:`/`Next steps:` checklist, confirm the Activity query group shows the captured plan and that reopening the saved chat keeps it.
5. Send or inspect prompts that apply a patch and write a file, then confirm the Activity result rows show persisted patch/file-change summaries, diff-style previews, and Draft revert actions after reopening the chat.
6. Send or inspect a prompt that runs a command, then confirm the approval prompt and command result row show command mode (`shell` or `argv`), parser-derived risk/analysis, command text, execution profile/isolation/cwd metadata, timeout limit, timeout/signal state when applicable, exit code, duration, and separated stdout/stderr details.
7. Confirm a completed command-producing run shows a Verification panel with command count, failed exits, timed-out commands, and parsed report counts derived from task-run artifacts.
8. Click the copy-audit icon on the Activity query group and confirm the clipboard contains a Markdown `Arivu task run audit` summary with run id, prompt, status, model/provider, capabilities, tools, approval policy reason/effect, compact approval target scope, approvals, artifacts including command timeout evidence when present, verification, and worktree/PR state when present.
9. For a worktree-backed run whose verification failed, confirm Activity shows the promotion-blocked message and PR draft/Create PR/Merge controls are unavailable or disabled while Preview/Open/Refresh/Discard still work.
10. Click Fix verification on that failed worktree run, confirm the composer is filled with a repair prompt, the Worktree control shows continuation state, and the next send creates a new run whose worktree points at the same branch/path with `continuedFromTaskRunId`.
11. If that continued repair run completes with unknown verification, confirm Activity shows Rerun checks, clicking it fills the composer with a verification prompt, and the Worktree control continues the same branch again.
12. For a worktree with multiple continued repair attempts, confirm Activity shows a Repair history chain with the original run and each continuation in order. Click Details on a prior attempt and confirm Activity focuses and expands that run's evidence; click Open where available and confirm the managed worktree folder opens; click Compare and confirm the panel compares selected versus current verification, command, report, and change summaries plus added/removed/shared file deltas; click Replay on an attempt with commands and confirm the composer drafts a replay-checks prompt continuing the current worktree. After sending that replay prompt, confirm the new run shows Replay metadata, appears in Replay outcomes under its evidence attempt, and that both remain after reopening the chat. If two replay outcomes for the same evidence run fail verification, confirm the Replay outcomes group shows Review and drafts a review handoff prompt with a failure-pattern summary and minimal verification plan.
13. If a worktree run has passed verification, confirm Activity shows the next promotion step, such as Preview before PR/Merge, PR draft available, Create PR available, or draft PR already created. For a created draft PR, click Refresh PR and confirm Activity stores a review/check/comment/thread summary plus bounded named check evidence from GitHub CLI, derives `gh run view ... --log-failed` commands for failed GitHub Actions check URLs and `curl -L --max-time 30 ...` capture commands for failed external check-detail URLs when available, shows a ready/blocked/waiting merge cue and bounded review feedback from that snapshot. Refresh again after changing PR/check/review state and confirm the PR updates block summarizes changed state, review decision, merge state, check transitions, check summary, or feedback summary. Click Fetch evidence and confirm failed/cancelled/unknown check evidence is saved as command artifacts linked from the check evidence row and stays linked after the next matching Refresh PR. Click Watch PR and confirm the card shows Watching/refresh status before stopping it. Click Review PR and confirm the composer is filled with a PR review handoff prompt that includes the refreshed PR status/check/comment/thread/check summary, recent PR updates, derived check-evidence commands, fetched evidence artifact ids when present, and the Worktree control continues the same branch.
14. For commands that emit report paths such as `reports/junit.xml` or `reports/scan.sarif`, confirm the Activity result includes the detected report path, parsed report summary, and bounded failing-test or SARIF finding previews when the file exists in the execution workspace.
15. Confirm parsed report results and TypeScript/ESLint diagnostic results show compact open-report/source buttons, and that clicking one opens only the attached evidence path from the session/worktree root.
16. Confirm failed parsed report results show Draft fix, and that clicking it fills the composer with a focused repair prompt containing the report path and bounded failing test or SARIF finding details.
17. When Loop is enabled and a report-producing iteration ends with `Loop: continue`, confirm the next iteration receives one hidden `Arivu report remediation evidence artifact:` system message for the latest failed report artifact only once.
18. For a current-browser prompt such as "Can you see the website opened in the browser?", confirm the run records `browser_state` followed by a targeted `browser_screenshot` before the answer even if the model did not explicitly ask for those tools.
19. For browser prompts that call `browser_screenshot`, confirm the Activity rail shows a screenshot artifact and the task-run metadata reports an artifact count.

Desktop plan-approval check:

1. Run `npm run desktop:dev`.
2. Toggle `Plan` in the composer or run `/plan`.
3. Send a larger implementation prompt and confirm the model responds with a `Plan:` instead of editing files or running commands.
4. Confirm Activity marks the run as Plan approval and shows only local read/discovery capabilities if any tools were used.
5. Click Approve on the captured plan card and confirm Activity shows the persisted approved status.
6. Click Use approved plan and confirm the composer is filled with an approved-plan follow-up prompt.
7. Click Start worktree on the approved plan card and confirm the composer is filled with the worktree-specific approved-plan prompt and the Worktree control shows `Plan tree`.
8. Send that prompt from a git-backed project and confirm the new task run records a task worktree with the approved plan id visible in Activity metadata, the assistant's final response includes a parseable `Completion notes:` checklist, and the Approved plan source card shows plan checklist, evidence cues, and completion notes. Passed verification with changed files and a patch preview should mark a planned step supported only when a changed file, verification command, parsed report, refreshed PR check, model-authored evidence label, or assistant close-out bullet matches that step; unmatched steps should show Needs evidence, and failed verification should mark notes blocked. When a completion bullet uses `[evidence: file=src/example.ts; command=npm test]`, confirm those labels persist after reload and appear in the note evidence/audit summary.
9. On another plan run, click Revise or Cancel and confirm the review status persists after reopening the saved chat.

Desktop task-worktree check:

1. Open a git-backed workspace with at least one commit.
2. Toggle `Worktree` in the composer or run `/worktree`.
3. Send a small coding prompt such as "Create a tiny note file named arivu-worktree-check.txt."
4. Confirm Activity and `/session` show a task worktree branch/path.
5. Use Open in Activity to open the managed worktree folder, then confirm the file was created there and not in the original checkout.
6. In Activity, use Refresh to show the changed-file count.
7. Use Preview to render the bounded patch preview in Activity.
8. Use PR draft in Activity and confirm the run shows a pull-request draft card with title, branch, commit, and push/create commands when an `origin` remote exists.
9. When GitHub CLI is authenticated and a disposable remote is available, use Create PR and confirm the returned URL is stored on the task run. Click Refresh PR on the created PR card and confirm Activity shows the persisted GitHub review/check/comment/thread summary, bounded named check evidence, derived GitHub Actions log commands or external check-detail capture commands for matching check URLs, plus a ready/blocked/waiting merge cue and bounded latest feedback previews. Refresh again after a remote PR/check/review change and confirm recent PR updates persist after reopening the chat. Click Fetch evidence when failed/cancelled/unknown check evidence commands are available and confirm the resulting command artifact id or fetch issue appears on the matching check row, survives reopening the chat, and survives a later matching Refresh PR. Click Watch PR and confirm it switches to Watching with a status line, then stop it. Click Review PR and confirm the composer drafts a PR review handoff prompt that includes the refreshed snapshot and keeps the created task worktree armed. Otherwise, verify the Create PR button is shown only for prepared previewed worktrees with an origin remote and base branch.
10. Open Settings and confirm Task worktrees lists the run, shows present/missing folder state plus verification status, Open works for the recorded managed folder, and PR draft/Create PR is available only for eligible previewed ready worktrees whose verification has not failed.
11. For a sync-conflict check, change the same tracked file differently in the original checkout and in the managed task worktree, then use Sync in Activity. Confirm the conflict panel appears, lists the conflicted file, lets you open that specific conflicted file, blocks Preview/PR/Merge actions, and keeps Open/Refresh/Discard available.
12. Resolve the conflict markers in the managed task worktree, then click Continue and confirm the conflict panel clears, the diff summary updates, and Preview/PR/Merge actions become available again when verification allows them.
13. Repeat the divergent setup and click Abort instead; confirm Git aborts the merge in the managed task worktree, the conflict panel clears, and the original checkout is unchanged.
14. With the original checkout clean, use Merge to fast-forward the previewed worktree to the task branch.
15. Use Clean up to remove the merged task worktree and branch. For an unmerged task, use Discard instead and confirm the original checkout is unchanged. Repeat the cleanup/discard path from Settings for a saved run and confirm the inventory refreshes afterward.

Current-news/web-search check:

```bash
arivu --trust readonly "What's the latest news on Indian cricket team?"
```

Local context tool check:

```bash
arivu --trust readonly "What is the current local date and time?"
arivu --trust readonly "What approximate location context can you infer locally?"
```

Local skills check:

```bash
export ARIVU_SKILLS_HOME="$(mktemp -d)"
mkdir -p "$ARIVU_SKILLS_HOME/example"
printf '# Example Skill\ndescription: Use for test skill discovery.\n' > "$ARIVU_SKILLS_HOME/example/SKILL.md"
arivu --trust readonly 'Use $example and summarize available skills.'
```

MCP tools check:

1. Open desktop Settings.
2. Add an MCP server JSON object under `MCP servers`.
3. Save settings.
4. Ask the agent to call `mcp_list_tools` and inspect the Activity panel.

Runtime self-management check:

1. Configure a primary Browser task model and at least two ordered fallbacks in Settings, then save and reopen the Browser section to confirm order and provider/model values persist.
2. Ask Arivu to inspect its runtime. Confirm `arivu_runtime_status` exposes sanitized endpoints, candidate ids, effective disabled tools, and protected control tools without API keys, URL credentials, query strings, or fragments.
3. Ask Arivu to switch to a fallback for this run, then call `browser_task`. Confirm the delegated task receives that model while saved Settings remain unchanged.
4. Repeat with session scope and send a second prompt in the same chat. Confirm the selected browser model remains active only for that chat session.
5. Ask Arivu to disable a normal tool for the run and confirm it is unavailable on the next model step. Confirm attempts to disable `ask_user` or an `arivu_*` tool fail, and a tool disabled in saved Settings cannot be re-enabled through runtime control.
6. Ask Arivu to add an MCP capability. Confirm Settings > Integrations shows a pending proposal containing command, arguments, requested environment-variable names, and reason. Dismiss it once; then create another and choose Add disabled. Confirm the MCP JSON receives a unique disabled server entry with blank credential placeholders and no process starts before review.

With NVIDIA-style OpenAI-compatible endpoints, batch/fallback requests should omit `stream`; only streaming requests should send `stream: true`. Assistant tool-call history with no text should serialize as `content: null`, not `content: ""`, and blank assistant history messages without tool calls should be omitted from provider payloads. If a model/provider rejects tool payloads or empty assistant tool-call content, the client should retry without tools and convert tool history into plain-text transcript entries.

For image-capable models, desktop image prompts should serialize as OpenAI-compatible text and `image_url` content parts. When `imageInput` is `disabled`, multimodal prompts should fail before sending a provider request. When an auto-mode provider rejects `image_url` content parts, desktop should save that provider's Image input mode as Disabled. Proactive multimodal provider capability probing is not implemented, so use a model endpoint that is known to accept image content when testing attachments.

TUI check:

```bash
arivu
arivu compact <session-id> --dry-run
```

Desktop check:

```bash
npm run desktop:dev
```

For a built desktop launch:

```bash
npm run desktop:start
```

Headless-ish desktop smoke check:

```bash
npm run desktop:build
ARIVU_DESKTOP_SMOKE=1 ./node_modules/.bin/electron dist-desktop/main/main.js
```

Smoke mode loads the built renderer, captures a screenshot in the system temp directory, prints the path, and exits.

Browser tab smoke check:

```bash
npm run desktop:build
ARIVU_BROWSER_SMOKE=1 ./node_modules/.bin/electron dist-desktop/main/main.js
```

Browser smoke mode opens the visible browser window and exercises the native browser release path end to end. It verifies normal tabs, popup adoption and self-close cleanup, nonblank tab screenshots, shell tab cycling, scaled 4K device emulation, region annotation handoff to the Arivu composer, visible/background tab transfer, the categorized load-error page, and the expanded Settings surface. It prints tab ids plus page, shell, and review screenshot paths, then exits nonzero on any failed assertion.

Benchmarks (scenarios captured from dev/test sessions, scored against the real model):

```bash
npm run bench -- list
npm run bench -- run coding-fix-failing-test
```

See `BENCHMARKS.md` for the capture workflow, the automated browser bench entry (`ARIVU_BENCH_TASK`), and the live-site policy.

Desktop workflows to check manually after UI changes:

- Startup and `New chat` start with no project selected.
- The draft-chat selector in the prompt `+` menu can choose `No project`, a recent project, or an opened workspace before the first prompt.
- The prompt `+` menu contains project routing, image attachment, browser window access, tools, skills, and MCP settings access. Model switching is available directly from the composer model button.
- After the first prompt is sent, the project selector hides.
- `Open` switches to an existing workspace folder.
- `New workspace` creates a directory and switches into it.
- The Workspaces sidebar section shows recent workspaces from saved project chats. Click the folder/name area to reopen that workspace and use the chevron to expand chats beneath it.
- The top-level Chats section shows saved chats that are not associated with any project.
- `History` lists saved sessions, can reopen them, rename them, pin/unpin them, and delete them. Pinned chats should remain above normal recency order after reload. Session updates are serialized per chat and use fsync-backed atomic replacement; each update preserves the previous validated JSON as an unlisted `.bak` file. If the primary JSON is truncated or invalid, history falls back to that previous copy and opening the chat repairs the primary. Deleting a chat removes both copies.
- Typing `/` in the desktop composer opens slash commands. Verify `/session` shows chat id plus estimated context used/remaining and latest task-run status, `/tools` opens the tools list, `/skills` opens the skills selector, `/files` attaches workspace text/code files to the next prompt, `/browser` opens or focuses the separate browser window, `/plan` toggles one-shot read-only plan approval, `/worktree` toggles one-shot task worktree mode for git projects, `/compact` runs the existing compact-context flow when enough messages exist, and unknown slash commands are not sent as model prompts.
- Skills in the prompt `+` menu show the installed global skills list. Load queues a skill for the next prompt, the composer shows a queued chip, and after the prompt succeeds the chat shows the skill as loaded context. The Add skill action opens Settings where a new skill can be saved as `<name>/SKILL.md`.
- Model selection opens a dialog with search, loads options from the selected provider's `GET /models`, and keeps manual model id entry available when the provider has no list or no match.
- Settings can save multiple OpenAI-compatible LLM providers, a Tavily key, and MCP server JSON. Confirm the model picker searches only the selected provider's models and does not combine lists across providers. Confirm each provider's Tool calling mode saves as Auto fallback, Enabled, or Disabled, and Disabled makes doctor skip the tool-calling probe. Confirm Settings doctor saves Tool calling as Disabled for auto-mode saved providers when the probe says tools are unsupported. Confirm each provider's Image input mode saves as Auto, Enabled, or Disabled, and Disabled blocks image prompts before a provider request. For auto-mode providers, rejected tool schemas or image parts should persist the matching capability as Disabled.
- Header actions are icon-only and expose hover/focus tooltips.
- The Browser header action opens or hides the separate maximized browser window. Verify explicit visible URL opens in that window, default agent browser tools remain hidden/background, and the main workspace layout does not gain an embedded browser column.
- In the visible browser window, verify the tab strip can create a new tab, select between tabs, close a tab, keep each tab's URL/title/history separate, navigate with the address bar/back/forward/reload controls, and convert non-URL address text into a Google search.
- Open Review, select an element and a region, add comments and design adjustments, hold the original, discard one annotation, and send the remaining evidence to Arivu. Confirm the composer receives the notes and rounded image attachments without losing their aspect ratios.
- In Review, send a visible page to the background agent, then adopt it back into a visible tab. Confirm `browser_state` lists the transferred tab and the agent can target every visible tab by `tabId`.
- Enable Device mode and select 4K. Confirm the page is scaled to fit the maximized window and the shell reports the preview percentage.
- Open Browser Settings and verify download settings, privacy controls, password/autofill entries, Chrome password CSV or Arivu JSON import, and unpacked extension load/remove/options flows. Confirm saved password values are absent from the profile JSON on disk.
- Switch macOS appearance between light and dark, then complete tab selection, address navigation, Review selection, and Settings navigation using only the keyboard. Confirm focus remains visible and no toolbar text overlaps at the minimum browser size.
- For browser tool QA, verify `browser_state` reports the active visible tab and visible tab list, `browser_select_tab` switches tabs by `tabId`, `browser_open` with `mode: "visible"` opens the active visible tab, `browser_open` with `newTab: true` creates a visible tab, `tabId` targets a specific visible tab, and `browser_screenshot` produces a fresh Activity screenshot preview for the intended tab.
- Verify browser opens, clicks, coordinate clicks, and typing do not show approval dialogs by default, while the Activity rail still records browser-control activity. Then set the current workspace browser-control policy override to `Require approval` or `Block` in Settings and confirm the override is honored.
- `Refresh state` reloads workspace, config, and active session state.
- Recent workspace rows mark missing folders and expose a forget action that moves those saved chats to standalone history instead of deleting them.
- `Compact context` summarizes older saved messages locally, strips old tool-call protocol into plain transcript text, saves the session, and keeps the recent message window.
- The `Tools` item in the prompt `+` menu opens an inline drawer listing available tools, parameters, and status.
- Confirm the Tools drawer lists `arivu_runtime_status`, `arivu_set_tool_state`, `arivu_select_browser_model`, and `arivu_propose_mcp_server`; control-boundary tools must remain enabled even when other tools are runtime-disabled.
- Browser tools appear in the Tools drawer in desktop mode. Verify `browser_state`, `browser_select_tab`, `browser_open`, `browser_snapshot`, `browser_console`, `browser_screenshot`, `browser_click`, `browser_type`, and `browser_execute_javascript` are listed with hidden-browser status.
- Ask the agent to run `browser_execute_javascript` with a script that returns a plain value (confirm it comes back as the actual result, not a stringified duplicate) and with one that throws (confirm a clean `ok:false` error, not a raw tool failure). Try a script with a blocking `while(true){}` loop: confirm the tool call itself returns a timeout message within ~15s and that the tab still recovers after a reload.
- Run a `browser_task` on a page with an unfamiliar control and confirm the in-page agent's activity trace shows it calling `search_web` when stuck rather than repeating the same failed interaction indefinitely. Confirm the search still succeeds with no Tavily key configured (Bing RSS fallback) and that revoking/expiring the task's proxy token also cuts off search, not just the LLM calls.
- In Settings, choose a Browser task LLM provider and open the Browser task model picker. Confirm it loads models from that provider, excludes the chat-only `Auto` choice, supports search and manual model IDs, and the reset icon returns to the provider's default model.
- Add, reorder, and remove Browser task fallbacks. Confirm each row can use a different configured provider, model search stays provider-specific, manual model ids work, and no more than five fallbacks can be saved.
- Open prompt options and select Browser LLM; confirm the same picker opens above the composer. Verify `/browsermodel` opens it and `/browsermodel <model-id>` pins the exact model without sending a chat prompt.
- Set browser task max loops and loop delay in Settings, save, reopen Settings, and confirm both values persist. Blank values should restore the 100-loop and 35000-ms defaults; delay values above 120000 ms must be rejected by the input/schema boundary.
- Exercise a browser-task provider that returns a temporary 429/503 and confirm bounded backoff occurs inside the proxy. On a terminal failure, confirm Activity preserves the model/provider, trace, stop reason, and endpoint diagnostics and that an immediate retry is stopped by the model-specific circuit.
- Start a browser task and inspect the injected page-agent configuration. Confirm the default loop cap is 100, the delay between loops is 35 seconds, and cancelling the chat run stops the browser task without waiting for the full 70-minute wall-clock budget.
- The `Images` item in the prompt `+` menu opens a native image picker, attaches PNG/JPEG/WebP/GIF files, renders removable thumbnails, and sends those images with the next prompt.
- The `Files` item in the prompt `+` menu opens a native picker rooted in the active workspace, attaches bounded text/code files, renders removable file chips, includes the file text in the composer token estimate, and sends the contents as quoted file context with the next prompt.
- Pasting or dropping PNG/JPEG/WebP/GIF image data into the composer attaches thumbnails without inserting text.
- The send button is icon-only and remains disabled for empty prompts.
- Search chat opens a find bar, reports match counts, and scrolls between matches.
- `Enter` sends a message; `Shift+Enter` inserts a newline.
- User message actions show icon-only Edit and Copy controls below the message. Failed user messages also show Retry. Edit loads the query into the composer for revision; Copy changes the tooltip to `Copied`.
- Editing a multimodal user message restores its text and image thumbnails to the composer. Retrying a failed multimodal prompt resends the same text/image content.
- Agent reply actions show icon-only Retry and Copy controls below the reply. Retry regenerates from the related user prompt by replacing the old assistant/tool tail, not by posting a duplicate user bubble.
- A failed send keeps the user bubble in the transcript, marks it retryable, and exposes icon-only Retry in the error strip.
- Large pasted text opens the token-budget review dialog before insertion.
- Tool-call activity is grouped by the triggering user query. Verify a prompt that uses multiple tools shows one expandable tool-run marker in the chat transcript with `For this query` copy and one matching expandable query group in the Activity panel. Expand the chat marker and confirm each tool step pairs its call details with the matching result details. Expand Activity rows and confirm each call/result shows a policy chip/detail with recorded approval evidence when available, or an explicit inferred-capability note for restored transcript-only rows. Use the Activity group's copy-audit icon to copy a Markdown audit summary for that run and confirm each tool includes a policy line.
- Plan approval mode is one-shot. After sending a prompt with Plan armed, verify the composer returns to normal mode, Loop/Worktree are not armed, the task run shows Plan approval metadata, write/shell/browser/web/MCP tools are not advertised, Approve/Revise/Cancel persist review state, Use approved plan drafts an execution follow-up only after approval, and Start worktree drafts the approved plan while arming a new worktree that records the plan source id and shows source-plan review cues plus completion notes in Activity. Confirm matching changed files, commands, parsed reports, TypeScript/ESLint command diagnostics, refreshed PR checks, model-authored evidence labels, or assistant close-out bullets appear in the note evidence when available.
- Worktree mode is one-shot. After sending a prompt with Worktree armed, verify the composer returns to normal mode and the task run retains the generated branch/path. After a failed-verification run, verify Fix verification drafts a repair prompt and arms continuation of the same branch. After a continued repair run without command evidence, verify Rerun checks drafts a verification prompt and arms continuation of the same branch again. For multi-attempt repairs, verify Activity shows the original run and each continuation in the Repair history chain, Details focuses the selected attempt's Activity evidence, Open uses the existing managed-worktree action when available, Compare summarizes selected versus current evidence with per-file deltas, and Replay drafts a current-worktree verification prompt from the selected attempt's commands. After sending Replay, verify the resulting run persists `Replay of ...` metadata after reload and appears in the Replay outcomes group for the evidence run. After two replay failures for the same evidence run, verify Review drafts a handoff prompt that asks whether the repeated failure is a real defect, stale command, environment issue, or missing precondition, includes the repeated-failure pattern, and suggests the smallest verification command to run first. After passed verification, verify Activity shows whether to Preview, prepare PR, create PR, or review an already created draft PR; when a PR URL exists, verify Refresh PR stores a review/check/comment/thread/check snapshot, renders a ready/blocked/waiting merge cue plus bounded check evidence, recent PR updates after changed refreshes, derived check-evidence commands, and review feedback, Fetch evidence saves failed/cancelled/unknown GitHub Actions logs or external check-detail captures as bounded command artifacts linked from check evidence, Watch PR changes to Watching with a refresh status line, and Review PR drafts a created-PR review prompt with the last refreshed PR status while keeping the same task worktree armed. Stop Watch PR and confirm the card returns to the non-watching state. After a completed run, verify Activity can refresh changed-file metadata, preview the patch, sync with the current original checkout, show conflicted files when Sync needs manual resolution, open individual conflicted files, continue or abort that conflict, prepare/create a PR, and expose the correct merge/discard/cleanup action for the worktree state. Verify Settings lists the recorded task worktree with present/missing folder state, opens the managed folder when present, and exposes PR draft/Create PR, Discard, or Clean up for eligible saved task worktrees.
- Sidebar sections, the left sidebar, the compact Activity rail/panel, Activity query groups, and Activity rows collapse/expand.
- The left sidebar and expanded Activity panel resize by dragging their divider handles.
- Assistant replies render as Markdown; fenced code blocks are syntax-highlighted and expose an icon-only copy button.
- Light/dark mode and UI concept samples remain usable after layout changes.

Inside the TUI:

- `/help` shows commands.
- `/status` shows workspace/model state.
- `/diff` shows staged, unstaged, and untracked git changes without sending anything to the model.
- `/compact [n]` compacts the active saved session locally, keeping the most recent non-system messages.
- `/sessions [n] [--pick] [--search text] [--workspace text] [--pinned|--unpinned] [--project|--standalone]` lists and filters recent saved sessions, and opens a selectable picker when `--pick` is present.
- `/resume <session-id>` switches the live TUI into that session.
- `/clear` clears visible conversation.
- `/exit` exits.
- `PageUp`/`PageDown`, `Shift+PageUp`/`Shift+PageDown`, and the `Ctrl+Home`/`Ctrl+End` variants scroll or jump the conversation and activity panes.

Use a terminal wider than about 100 columns to see the activity pane.

## Working on the TUI

The TUI is in `src/tui/TuiApp.ts`. Keep these behaviors intact:

- Default `arivu` opens the TUI.
- One-shot mode stays non-interactive.
- `sessions` prints recent saved sessions newest first, supports `--search`, `--workspace`, `--pinned`, `--unpinned`, `--project`, and `--standalone`; `resume <session-id>` opens the TUI with session history; and `compact <session-id>` compacts a saved transcript with `--recent`, `--entry-limit`, and `--dry-run` controls.
- Inside the TUI, `/compact [n]` compacts the active saved session, `/sessions [n]` lists recent saved sessions, accepts the same filter flags, `/sessions --pick` opens a keyboard-selectable resume picker, `/resume <session-id>` switches the live TUI into that session, `/diff` shows a local git change summary, and pane scrolling shortcuts keep long conversation/activity logs reachable without mouse support.
- Narrow terminals remain usable.
- Approval prompts still resolve the same permission promise.

## Working on the desktop app

Desktop files live under `desktop/`.

- `desktop/main/main.ts` owns Electron, IPC, workspace selection, and agent execution.
- `desktop/main/main.ts` also owns workspace creation, session history loading, model listing, and config/session persistence.
- `desktop/main/preload.ts` exposes a small `window.arivu` API.
- `desktop/renderer/src/App.tsx` owns the React UI.
- `desktop/renderer/src/styles.css` owns the desktop styling.

Keep these boundaries intact:

- Renderer code must not access Node APIs directly.
- Main process owns filesystem, model calls, shell execution, workspace creation, and config/session IO.
- Approvals flow from main process to renderer by IPC and resolve back to `ApprovalManager`.
- Desktop changes must not break `arivu` TUI mode or one-shot CLI mode.

## Working on tools

When adding or changing a tool:

- Add a schema in `src/tools/registry.ts`.
- Validate arguments with `zod`.
- Keep paths contained with `resolveWorkspacePath`.
- Route sensitive actions through `ApprovalManager` and update `src/permissions/capabilityPolicy.ts` when a new harness capability or trust decision is needed. If the capability should be user-hardenable per workspace, expose it through the workspace policy override allowlist as a stricter `prompt`/`deny` option.
- For repo read tools, verify `read_repo` workspace overrides can require approval or block `list`, `read`, `search`, and `git_status` without affecting local context tools.
- For direct write preview evidence, create a small trusted `apply_patch`, a prompted or denied write, and a large `apply_patch` or `write_file` review outside task-worktree execution. Confirm Activity approval rows show bounded proposed patch/content previews before/without relying on the later applied artifact, denied rows keep the preview, and the large approval modal says "Write review" with a review-boundary reason before any file is changed. Confirm the same large patch inside a managed task worktree relies on the worktree patch-preview boundary instead of adding the extra direct-edit review prompt.
- For workspace policy presets, verify each preset button updates both override selects and scope fields before save, and confirm the selected preset state returns after a Settings refresh when the saved policy still matches that preset.
- For workspace policy profiles, enter a profile name, save the current policy as a profile, click Save settings, reopen Settings, and confirm the profile can apply the same overrides and scope fields to another workspace policy. Delete the profile and save again to confirm it is removed from config.
- For team workspace policy bundles, add `.arivu/workspace-policy.json` with an `arivu.workspacePolicy` payload, reload Settings, apply the Team bundle, save settings, and confirm the same overrides/scope rules persist for that workspace. Replace the file with invalid JSON and confirm Settings shows the bundle error without changing the current policy state.
- For workspace policy JSON, click Copy JSON and confirm the field contains normalized `arivu.workspacePolicy` JSON. Paste changed valid JSON and click Apply JSON, then confirm override selects and scope fields update before saving. Try an unsupported capability or browser class and confirm the Settings panel shows an import error without changing policy state.
- For workspace scope rules, add a blocked path prefix such as `.env` in Settings and confirm `read`, `write_file`, and `apply_patch` attempts under that prefix are blocked before any file change. Add an allowed network domain such as `api.tavily.com` and confirm keyless Bing-backed `web_search` is blocked while Tavily-backed search is allowed through the usual network approval gate. Add an allowed MCP server name and confirm `mcp_list_tools` only discovers matching configured servers while `mcp_call_tool` blocks other names. Add browser target classes such as `background` and `local`, then confirm public or visible browser actions are blocked. Reopen Settings and the Tools drawer to confirm active scope summaries and per-tool chips match the saved rules.
- Keep read-only local context tools side-effect-free and approval-free.
- Keep `list_skills` and `read_skill` read-only; skills should be discovered from the global app data skills directory or `ARIVU_SKILLS_HOME`.
- Treat MCP tools as configured external processes. `mcp_list_tools` is discovery; `mcp_call_tool` may perform whatever the selected MCP server implements.
- Keep runtime self-management bounded: run/session model and tool changes may reference only registered candidates/tools; persistent saved settings and executable MCP activation must remain behind explicit user review.
- Treat web tools as external data transmission; do not send secrets, private source, or personal data in search queries.
- Treat browser tools as rendered-page access. Keep page content untrusted, use hidden isolated browser sessions by default, and prefer Chrome DevTools MCP for visual screenshots or deeper debugging when it is configured.
- `browser_task` accepts integer-looking strings for `maxSteps` and `timeoutMs` because some OpenAI-compatible models serialize numeric tool arguments as strings. Nonnumeric strings, out-of-range values, and sensitive boolean arguments remain strictly validated.
- Keep `web_search` useful for current-information prompts: Tavily is preferred, while the no-key fallback uses Bing RSS and routes news-like queries to Bing News RSS.
- Add tests for safety-sensitive behavior.

## Release/local linking

This project is currently used as a local linked CLI:

```bash
npm run build
npm link
which arivu
arivu --help
```

No publish workflow exists yet.
