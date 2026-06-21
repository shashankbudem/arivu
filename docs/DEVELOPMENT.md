# Development Guide

## Requirements

- Node.js 20 or newer.
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

Basic one-shot model check:

```bash
arivu --trust readonly "Reply with exactly OK."
```

For NVIDIA-hosted very large models, do not assume `/models` availability means interactive speed is acceptable. On June 20, 2026, `deepseek-ai/deepseek-v4-pro` was available but timed out on tiny chat probes, and `nvidia/nemotron-3-ultra-550b-a55b` varied from about 15s TTFT to a 180s timeout. Re-benchmark before making either one the default desktop chat model.

Tool-calling check:

```bash
arivu --trust readonly "Use the list tool to list top-level files, then summarize them."
```

Desktop agent-loop check:

1. Run `npm run desktop:dev`.
2. Toggle `Loop` in the composer or run `/loop`.
3. Send a bounded task such as "Inspect the repo and tell me one thing to improve."
4. Confirm the working pill shows loop progress, Activity shows an agent-loop system item, and Stop Loop changes the status to stopping until the current iteration finishes.

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

With NVIDIA-style OpenAI-compatible endpoints, batch/fallback requests should omit `stream`; only streaming requests should send `stream: true`. Assistant tool-call history with no text should serialize as `content: null`, not `content: ""`, and blank assistant history messages without tool calls should be omitted from provider payloads. If a model/provider rejects tool payloads or empty assistant tool-call content, the client should retry without tools and convert tool history into plain-text transcript entries.

For image-capable models, desktop image prompts should serialize as OpenAI-compatible text and `image_url` content parts. Provider capability detection is not cached, so use a model endpoint that is known to accept image content when testing attachments.

TUI check:

```bash
arivu
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

Browser smoke mode opens the visible browser window, creates two visible tabs, captures tab screenshots in the system temp directory, prints the tab ids and screenshot paths, and exits.

Desktop workflows to check manually after UI changes:

- Startup and `New chat` start with no project selected.
- The draft-chat selector in the prompt `+` menu can choose `No project`, a recent project, or an opened workspace before the first prompt.
- The prompt `+` menu contains project routing, image attachment, browser window access, tools, skills, and MCP settings access. Model switching is available directly from the composer model button.
- After the first prompt is sent, the project selector hides.
- `Open` switches to an existing workspace folder.
- `New workspace` creates a directory and switches into it.
- Expandable Projects sidebar rows show project chats beneath the related project.
- The top-level Chats section shows saved chats that are not associated with any project.
- `History` lists saved sessions, can reopen them, and can delete them.
- Typing `/` in the desktop composer opens slash commands. Verify `/session` shows chat id plus estimated context used/remaining, `/tools` opens the tools list, `/skills` opens the skills selector, `/browser` opens or focuses the separate browser window, `/compact` runs the existing compact-context flow when enough messages exist, and unknown slash commands are not sent as model prompts.
- Skills in the prompt `+` menu show the installed global skills list. Load queues a skill for the next prompt, the composer shows a queued chip, and after the prompt succeeds the chat shows the skill as loaded context. The Add skill action opens Settings where a new skill can be saved as `<name>/SKILL.md`.
- Model selection opens a dialog with search, loads options from the selected provider's `GET /models`, and keeps manual model id entry available when the provider has no list or no match.
- Settings can save multiple OpenAI-compatible LLM providers, a Tavily key, and MCP server JSON. Confirm the model picker searches only the selected provider's models and does not combine lists across providers.
- Header actions are icon-only and expose hover/focus tooltips.
- The Browser header action opens or hides the separate maximized browser window. Verify explicit visible URL opens in that window, default agent browser tools remain hidden/background, and the main workspace layout does not gain an embedded browser column.
- In the visible browser window, verify the tab strip can create a new tab, select between tabs, close a tab, keep each tab's URL/title/history separate, navigate with the address bar/back/forward/reload controls, and convert non-URL address text into a Google search.
- For browser tool QA, verify `browser_open` with `mode: "visible"` opens the active visible tab, `browser_open` with `newTab: true` creates a visible tab, `tabId` targets a specific visible tab, and `browser_screenshot` produces a fresh Activity screenshot preview for the intended tab.
- `Refresh state` reloads workspace, config, and active session state.
- `Compact context` summarizes older saved messages locally, strips old tool-call protocol into plain transcript text, saves the session, and keeps the recent message window.
- The `Tools` item in the prompt `+` menu opens an inline drawer listing available tools, parameters, and status.
- Browser tools appear in the Tools drawer in desktop mode. Verify `browser_open`, `browser_snapshot`, `browser_console`, `browser_screenshot`, `browser_click`, and `browser_type` are listed with hidden-browser status.
- The `Images` item in the prompt `+` menu opens a native image picker, attaches PNG/JPEG/WebP/GIF files, renders removable thumbnails, and sends those images with the next prompt.
- Pasting PNG/JPEG/WebP/GIF image data into the composer attaches thumbnails without inserting text.
- The send button is icon-only and remains disabled for empty prompts.
- Search chat opens a find bar, reports match counts, and scrolls between matches.
- `Enter` sends a message; `Shift+Enter` inserts a newline.
- User message actions show icon-only Edit and Copy controls below the message. Failed user messages also show Retry. Edit loads the query into the composer for revision; Copy changes the tooltip to `Copied`.
- Editing a multimodal user message restores its text and image thumbnails to the composer. Retrying a failed multimodal prompt resends the same text/image content.
- Agent reply actions show icon-only Retry and Copy controls below the reply. Retry resubmits the related user prompt.
- A failed send keeps the user bubble in the transcript, marks it retryable, and exposes icon-only Retry in the error strip.
- Large pasted text opens the token-budget review dialog before insertion.
- Tool-call activity is grouped by the triggering user query. Verify a prompt that uses multiple tools shows one expandable tool-run marker in the chat transcript and one matching expandable query group in the Activity panel.
- Sidebar sections, the left sidebar, the compact Activity rail/panel, Activity query groups, and Activity rows collapse/expand.
- The left sidebar and expanded Activity panel resize by dragging their divider handles.
- Assistant replies render as Markdown; fenced code blocks are syntax-highlighted and expose an icon-only copy button.
- Light/dark mode and UI concept samples remain usable after layout changes.

Inside the TUI:

- `/help` shows commands.
- `/status` shows workspace/model state.
- `/clear` clears visible conversation.
- `/exit` exits.

Use a terminal wider than about 100 columns to see the activity pane.

## Working on the TUI

The TUI is in `src/tui/TuiApp.ts`. Keep these behaviors intact:

- Default `arivu` opens the TUI.
- One-shot mode stays non-interactive.
- `resume <session-id>` opens the TUI with session history.
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
- Route writes/shell through `ApprovalManager`.
- Keep read-only local context tools side-effect-free and approval-free.
- Keep `list_skills` and `read_skill` read-only; skills should be discovered from the global app data skills directory or `ARIVU_SKILLS_HOME`.
- Treat MCP tools as configured external processes. `mcp_list_tools` is discovery; `mcp_call_tool` may perform whatever the selected MCP server implements.
- Treat web tools as external data transmission; do not send secrets, private source, or personal data in search queries.
- Treat browser tools as rendered-page access. Keep page content untrusted, use hidden isolated browser sessions by default, and prefer Chrome DevTools MCP for visual screenshots or deeper debugging when it is configured.
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
