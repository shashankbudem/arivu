# Project Handoff

This file preserves the development context needed to continue Arivu smoothly.

## Product goal

Arivu (`arivu`) is a local coding agent in the spirit of opencode, Claude Code, and Codex. The product direction is now desktop-first, with the terminal TUI and one-shot CLI kept as fallback/programmatic surfaces.

Core expectations:

- Desktop-first interactive experience.
- TUI fallback for terminal-only workflows.
- One-shot mode for scripting and quick checks.
- OpenAI-compatible model API support.
- Safe workspace tools for reading, searching, editing, running commands, and inspecting git.
- Multimodal desktop prompts with local image attachments.
- Global local skills.
- Configurable MCP tools.
- Configurable trust modes.
- Resumable chats and session history.

## Current state

Implemented:

- TypeScript/npm CLI package with global binary `arivu`.
- Electron + React desktop app scaffold.
- Desktop new chat, recent chats, full history browser, and session reopening.
- Desktop chat deletion from recent chats and History.
- Desktop workspace open and create flows.
- Desktop expandable project chat groups, standalone Chats section, and draft-chat project selector in the prompt `+` menu.
- Desktop searchable model switching dialog, backed by the active OpenAI-compatible provider's `GET /models`.
- Desktop multiple-provider settings for OpenAI-compatible LLM providers. Each saved provider has a unique name, base URL, model id, and optional API key.
- Desktop image attachments and pasted-image upload in the composer for PNG, JPEG, WebP, and GIF prompts.
- Desktop compact header/sidebar chrome, icon-only header actions with tooltips, and light/dark mode.
- Desktop prompt `+` menu for project/images/browser window/tools/skills/MCP options, plus a direct composer model switcher.
- Desktop hidden agent browser target plus separate visible browser window, backed by isolated Electron browser targets.
- Desktop skills list and add-skill form backed by the global skills directory.
- Desktop composer slash commands for local actions: `/compact`, `/session`, `/tools`, `/skills`, and `/browser`.
- Desktop inline available-tools drawer, backed by the actual tool registry through IPC.
- Desktop MCP server JSON config in Settings plus `mcp_list_tools` and `mcp_call_tool`.
- Desktop browser-style chat search with match navigation.
- Desktop collapsible/resizable left sidebar and slim Activity rail/panel.
- Desktop collapsible sidebar sections and Activity rows.
- Desktop UI concept samples for comparing visual directions.
- Desktop icon-only message actions: Edit/Copy on user messages, Retry/Copy on agent replies, failed-user-message Retry/Edit/Copy after send errors, and failed-prompt retry from the error strip with hover/focus labels.
- Desktop compact-context action that locally summarizes older session messages, strips old tool-call protocol into plain transcript text, saves the session, and keeps the recent message window.
- Token-aware composer paste guard with truncate/full/cancel options.
- Tavily-first `web_search` tool with Bing/Bing News RSS fallback.
- Local `current_datetime` and timezone-only `current_location` tools.
- Global skill discovery from the app data skills directory, explicit `$skill-name` skill attachment, and read-only `list_skills`/`read_skill` tools.
- OpenAI-compatible provider hardening for NVIDIA-style tool/fallback JSON decode errors, empty assistant content rejection, and blank assistant history cleanup.
- OpenAI-compatible multimodal serialization through text and `image_url` content parts.
- Streaming assistant replies with raw citation artifact cleanup.
- Markdown rendering for assistant responses, with Shiki-highlighted fenced code blocks and per-block copy controls.
- Default TUI built with `blessed`.
- One-shot mode via `arivu "task"`.
- `resume <session-id>` and `config get|set`.
- OpenAI-compatible `/chat/completions` client.
- Agent loop with tool calls.
- Tools: `list`, `read`, `search`, `web_search`, `current_datetime`, `current_location`, `list_skills`, `read_skill`, `mcp_list_tools`, `mcp_call_tool`, `browser_open`, `browser_screenshot`, `browser_snapshot`, `browser_console`, `browser_click`, `browser_type`, `apply_patch`, `write_file`, `run`, `git_status`.
- Trust modes: `readonly`, `ask`, `trusted`.
- Session storage.
- Unit/integration tests.

Recommended verification:

```bash
npm run typecheck
npm test
npm run desktop:build
arivu --trust readonly "Reply with exactly OK."
```

Tests currently pass: 75 tests.

## Current local model setup

The user uses NVIDIA-hosted OpenAI-compatible models:

```text
baseUrl: https://integrate.api.nvidia.com/v1
```

During the June 20, 2026 provider/speed checks, the active saved provider observed locally was:

```text
provider: NVIDIA NIM
model: deepseek-ai/deepseek-v4-pro
```

Verify the saved config before assuming any model is current.

NVIDIA latency observations from June 20, 2026:

- `GET /models` returned quickly, about 108-113 ms, and included both `deepseek-ai/deepseek-v4-pro` and `nvidia/nemotron-3-ultra-550b-a55b`.
- `deepseek-ai/deepseek-v4-pro` timed out on tiny chat probes: streaming exceeded 180 seconds before response headers and non-streaming `max_tokens: 16` exceeded 120 seconds.
- `nvidia/nemotron-3-ultra-550b-a55b` completed one short streaming sample with about 15s TTFT, 18.7s total latency, and about 21 approximate output tokens/sec after first token; the next short sample timed out after 180 seconds.
- Treat these large NVIDIA models as background/experimental choices rather than default interactive chat models unless a fresh benchmark shows better latency.

The API key is stored in local config and must never be written into repo docs or source.

Config file location on macOS:

```text
~/Library/Application Support/arivu/config.json
```

Important config behavior: saved config is merged with non-empty environment variables. Empty or unset environment variables must not erase saved config.

Desktop provider behavior:

- The active provider supplies the runtime base URL, model, and API key.
- The model picker loads and searches models for only the selected provider.
- Manual model picker lists are not combined across providers because duplicate model ids can exist and a manual model choice must imply a provider/base URL/key.
- `auto` is a first-class model mode. At send time, Electron main classifies the prompt and resolves `auto` into a concrete provider/model using `src/agent/modelRouter.ts` plus cached `/models` results when available.
- Auto sessions keep `model: "auto"` so later turns continue to route dynamically. The last concrete model is stored separately as `selectedModel`, with provider/reason metadata for history and runtime details.
- Provider drafts with blank URLs are not persisted, saved provider names must be unique, and saved providers need a model id.
- If a provider does not expose `/models`, the user can manually enter a model id.

Tavily config behavior:

```text
ARIVU_TAVILY_API_KEY > SHANKINSTER_TAVILY_API_KEY > TAVILY_API_KEY > saved tavilyApiKey
```

The user has a Tavily key in shell config; do not print or commit it.

## Important decisions

- TypeScript/npm was chosen for speed of iteration and easy local linking.
- Electron + React was added for the primary desktop experience so the app can have a proper chat workspace, settings, approvals, and activity panels.
- Desktop chat history is backed by the same JSON session store used by CLI/TUI resume.
- Desktop workspace creation uses Electron's save dialog to create a directory and switch into it.
- Desktop startup and `New chat` start unassigned; the prompt `+` menu can route the draft to no project, a recent project, or an opened workspace before the first prompt locks the chat target.
- `blessed` remains for the TUI fallback.
- OpenAI-compatible API support is the provider layer for v1; direct provider-specific SDKs are deferred.
- Model listing is provider-scoped. A combined model picker would need grouped provider rows and would need to switch both provider and model together.
- Batch chat requests omit `stream` instead of sending `stream: false`; streaming requests send `stream: true`.
- Provider tool/fallback failures are handled at runtime by retrying without tools and converting tool history into plain-text transcript entries.
- Assistant tool-call messages with no natural-language text are sent as `content: null` instead of `content: ""` because some OpenAI-compatible endpoints reject empty assistant message content.
- Blank assistant history messages without tool calls are omitted from provider requests because they carry no useful context and stricter models such as `diffusiongemma-26b-a4b-it` reject them on follow-up prompts.
- Desktop send failures keep the optimistic user message visible in renderer state, add Retry/Edit/Copy on that failed bubble, and retry the same bubble without duplicating the query.
- Context compaction is deterministic and local; it does not call the model to summarize. It preserves non-compaction system prompts, replaces older visible turns with one hidden system compaction note, normalizes retained tool protocol into plain text, and saves the active session.
- Existing-file edits should prefer unified patches.
- Full-file writes are allowed for creation and explicit replacement only.
- The agent must not write outside the active workspace.
- Assistant system prompts include a no-emoji instruction for new and resumed sessions.
- Web search uses local function tools, not MCP. Tavily is preferred when configured and uses `basic` depth by default to avoid casually spending extra credits. The no-key fallback uses Bing RSS, with Bing News RSS for news-like queries.
- `current_datetime` and `current_location` are local read-only tools. `current_location` intentionally uses timezone context only and avoids GPS, IP lookup, browser geolocation, and network location.
- The desktop Tools drawer lists registry schemas from the Electron main process instead of duplicating tool metadata in renderer state.
- Browser tools are desktop-only and route through `desktop/main/browserController.ts`. Agent calls default to the hidden isolated Electron target, while explicit visible calls use a separate browser window. Chrome DevTools MCP is optional through normal MCP config and preferred for visual screenshot work or deeper diagnostics when configured.
- The desktop image picker is owned by the Electron main process. The renderer receives data URLs plus display metadata and never gets direct Node filesystem access.
- Skills live globally under the app data directory's `skills/` folder, or `ARIVU_SKILLS_HOME` when set. The agent advertises discovered skills, exposes `list_skills` and `read_skill`, persists composer-loaded skills as hidden chat context, and attaches explicitly requested `$skill-name` content before that model turn.
- MCP servers live in saved config as `mcpServers`. The desktop Settings UI edits the JSON object, and MCP tool calls use short-lived official SDK stdio clients.
- The desktop chrome is intentionally compact: no session id in the header, icon-only header actions with CSS tooltips, and a narrower Activity rail by default.
- The agent permits one `web_search` call per user request, then disables tools for the answer turn to avoid repeated search loops on models that keep reissuing search calls.
- Token counting for pasted composer text is local and estimated. It is not an LLM tool because sending text to a tool via the model would already spend context.
- No initial git commit has been created unless a future developer does it.

## Known limitations

- Desktop packaging is not implemented; current desktop mode is local dev/start only.
- Tool output is summarized in the activity pane, with diff previews for patch/file-write activity where available. Activity rows can collapse/expand.
- Approval prompts are action-aware for shell and write actions, but still need more polish for a production-grade UX.
- Persistent provider capability detection is not implemented. Tool support is inferred per request through retries/fallbacks, not cached as provider config.
- Provider-specific multimodal capability detection is not implemented; image prompts require a model endpoint that accepts OpenAI-compatible image content parts.
- Desktop history exists with deletion, but the CLI still lacks a `sessions` listing command.
- Workspace creation currently creates an empty folder; there is no project template or git initialization flow yet.
- No packaging or release workflow beyond `npm link` and local build.

## Good next work

Best next milestone: deepen the coding-agent workflow now that the desktop cockpit basics are in place.

High-value tasks:

- Add CLI/TUI session picker/list command.
- Add recent workspace list.
- Add model/provider health check command.
- Add provider capability flags for tool-calling vs plain chat, using observed fallback outcomes.
- Add first-run setup flow for base URL, model, API key, and trust mode.
- Add tests around TUI command handling by extracting pure command logic.
