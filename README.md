# Arivu

Arivu (`arivu`) is a local coding agent with a desktop app, terminal TUI, and one-shot CLI mode. It can inspect a workspace, call an OpenAI-compatible model, send multimodal text+image prompts, run validated tools, search the web, control hidden and visible isolated browser targets, use globally installed local skills, call configured MCP tools, get local date/time context, edit files, execute approved shell commands, and save resumable sessions.

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

The desktop app includes a compact workspace sidebar, expandable project chat groups, standalone chats, new/open/create workspace controls, full chat history with delete controls, a prompt `+` menu, direct searchable model switching from the composer, browser-style chat search, a separate browser window with hidden agent browser tools by default, a token-aware multimodal composer with pasted-image attachments, inline available-tools drawer, local context compaction for long chats, Markdown-rendered replies with highlighted copyable code blocks, light/dark modes, UI concept samples, a slim collapsible Activity rail, settings view, and approval modal. The TUI remains available as a terminal fallback.

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

Supported trust modes:

- `ask`: reads are automatic; writes and shell commands require confirmation.
- `readonly`: list/search/read/web search/local context/browser tools/git status are allowed.
- `trusted`: workspace writes and non-destructive shell commands are allowed; destructive shell commands still require confirmation.

In the desktop app, Settings can save multiple OpenAI-compatible LLM providers. Each provider has a unique name, base URL, model id, and optional API key. Blank provider drafts are not saved; enter a valid URL and model id before saving a provider. Use `Auto` as the model id when Arivu should choose a concrete model for each prompt.

The active provider determines the base URL, model, and API key used for chat. The model picker opens from the composer model button or Settings and loads models from the selected provider's OpenAI-compatible `GET /models` endpoint. If two or more providers are configured, manual picker lists still show only the active provider's models, so switching providers changes which model list is searched. `Auto` is the exception: at send time, Arivu classifies the prompt as fast, coding, reasoning, vision, background, or general work, checks cached provider model lists when available, picks a concrete model, and stores the last picked model in the session history. If a provider does not expose `/models`, or returns no models, enter the model id manually or rely on the provider's Auto fallback. Settings also allow saving a Tavily API key for web search.

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

Configured MCP servers expose tools to the agent through `mcp_list_tools` and `mcp_call_tool`. MCP tool calls require approval and are blocked in `readonly` mode.

Web search uses Tavily when `ARIVU_TAVILY_API_KEY`, `TAVILY_API_KEY`, or saved `tavilyApiKey` is available. Without a Tavily key, the tool falls back to keyless Bing RSS search; news-like queries use Bing News RSS, normalize stale generated years to the current date, and decode Bing news redirect links.

Browser control:

- The desktop app has a hidden isolated browser target for agent-driven page inspection and a separate visible browser window for explicit visible browsing.
- Browser tools are exposed to the agent as `browser_open`, `browser_screenshot`, `browser_snapshot`, `browser_console`, `browser_click`, and `browser_type`.
- Agent browser tool calls run hidden/background by default. Explicit `mode: "visible"` opens or targets the separate browser window.
- Browser tool calls do not ask for approval in any trust mode.
- The prompt `+` menu and `/browser` command can open or focus the separate browser window for the user.
- Hidden browser screenshots are saved to temporary PNG files. For visual screenshot work that needs a real Chrome surface, configure Chrome DevTools MCP and let the agent call it through `mcp_list_tools`/`mcp_call_tool`.
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
- Project chats appear under their expandable project in the sidebar. Chats with `No project` appear in the top-level Chats section.
- `History` shows saved chats across workspaces, can reopen them, and can delete saved sessions.
- Header actions are icon-only with hover/focus tooltips. `Search chat` opens a browser-style find bar with match navigation. `Browser window` opens, focuses, or hides the separate browser window. `Refresh state` reloads workspace, config, and active session state from the Electron main process. `Compact context` summarizes older saved messages locally and keeps the most recent messages for future model requests.
- Press `Enter` to send a message, or `Shift+Enter` for a newline.
- User messages expose icon-only Edit and Copy actions. Failed user messages also expose Retry without removing the original query. Agent replies expose icon-only Retry and Copy actions. Hover or focus shows each action label.
- Failed prompts remain in the transcript and also show an icon-only Retry action in the error strip.
- Large pasted text is checked against a local estimated token budget before it is inserted. Pasted PNG, JPEG, WebP, and GIF images are attached to the next prompt automatically.
- The composer supports slash commands. Type `/` to open local commands: `/compact` compacts the current chat context, `/session` shows chat id, estimated context used/remaining, model/provider, and workspace details, `/tools` opens the available tools list, `/skills` opens the skills selector, and `/browser` opens the separate browser window.
- The prompt `+` menu contains project routing, image attachment, browser-window access, the tools drawer, skills list, add-skill access, and MCP settings access. Model switching is available directly from the composer model button.
- Images are encoded as data URLs and sent through OpenAI-compatible `image_url` content parts.
- Assistant responses are rendered as Markdown. Fenced code blocks use Shiki highlighting and include an icon-only copy button.
- The left sidebar, sidebar sections, Activity rail, and Activity rows can collapse. The left sidebar and expanded Activity panel can also be resized by dragging their divider handles.

## Commands

```bash
open via desktop: npm run desktop:dev
arivu                 # TUI mode
arivu "fix the failing tests"  # one-shot mode
arivu resume <session-id>
arivu config get
arivu config set <key> <value>
```

## Development docs

- [Project handoff](docs/HANDOFF.md): current state, decisions, caveats, and next best work.
- [Architecture](docs/ARCHITECTURE.md): module map and runtime flow.
- [Development guide](docs/DEVELOPMENT.md): setup, commands, verification, and linking.
- [Safety model](docs/SAFETY_MODEL.md): trust modes, tool permissions, and command/file guardrails.
- [Roadmap](docs/ROADMAP.md): recommended next milestones.
- [Contributing](CONTRIBUTING.md): standards for changes and reviews.
