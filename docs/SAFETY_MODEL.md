# Safety Model

Arivu (`arivu`) is allowed to operate on user repositories, so safety is a product feature, not a polish item.

## Trust modes

### `readonly`

Allowed:

- `list`
- `read`
- `search`
- `web_search`
- `current_datetime`
- `current_location`
- `list_skills`
- `read_skill`
- `mcp_list_tools`
- browser tools: `browser_open`, `browser_screenshot`, `browser_snapshot`, `browser_console`, `browser_click`, `browser_type`
- `git_status`

Denied:

- file writes
- patch application
- shell commands

### `ask`

Allowed automatically:

- reads
- searches
- public web searches
- browser tools against isolated browser pages
- local skill listing
- local skill reads
- directory listing
- git status

Requires approval:

- `apply_patch`
- `write_file`
- `run`

MCP tools:

- `mcp_list_tools` is read-only discovery.
- `mcp_call_tool` delegates behavior to the configured MCP server, is blocked in `readonly`, and requires approval in both `ask` and `trusted` modes because arbitrary MCP server side effects are unknown to Arivu.

### `trusted`

Allowed automatically:

- workspace reads
- workspace writes
- non-destructive shell commands

Still requires approval:

- destructive shell commands

## Destructive command detection

Detection currently lives in `src/permissions/destructive.ts`.

Commands treated as high risk include:

- recursive `rm`
- `git reset`
- `git clean`
- forced git checkout
- recursive `chmod` or `chown`
- disk formatting commands
- obvious destructive redirection into important system paths

This is a guardrail, not a complete shell security model. Keep the approval layer conservative.

## Filesystem safety

Path safety is handled by `resolveWorkspacePath`.

Rules:

- Relative paths resolve against the active workspace root.
- Absolute paths are allowed only when they remain inside the workspace root.
- Traversal outside the workspace is rejected.

Write safety:

- Existing files must be read before replacement.
- Existing-file patching checks that the file has not changed since it was read.
- `write_file` with `create` refuses to overwrite existing files.
- `write_file` with `replace` refuses to create missing files.

## Session and config safety

Config and sessions are stored outside target repos, under the app config/data directory.

Do not commit:

- API keys
- session transcripts with private repo contents
- local config files
- generated `node_modules`
- generated `dist` unless intentionally packaging a build artifact

## Web search safety

`web_search` is an external network tool. Queries are sent to Tavily when configured, or to the fallback Bing/Bing News RSS endpoint when Tavily is unavailable. News-like fallback queries may be normalized to the current month/year before being sent. The tool description instructs the model to keep queries concise and avoid secrets, private code, and personal data.

Do not use web search queries for:

- API keys or tokens
- private source snippets
- customer or personal data
- internal URLs or private repository names unless the user explicitly asks for that lookup

## Browser safety

The desktop browser is separate from `web_search`. It operates rendered pages through isolated Electron browser targets and may expose page text, console logs, screenshots, and interaction results to the model.

Browser targets:

- `visible`: a separate visible `BrowserWindow` for explicit browser-window requests.
- `background`: a hidden `BrowserWindow` for non-visible browser tasks.

The agent browser target uses an isolated hidden Electron session. The visible browser window also uses an isolated Electron session. Neither target shares the user's Chrome profile, cookies, extensions, or existing tabs.

Browser approval policy:

- `browser_open`, `browser_screenshot`, `browser_snapshot`, `browser_console`, `browser_click`, and `browser_type` do not ask for approval in any trust mode.
- In `readonly`, browser open/click/type actions are still allowed because the Electron browser is isolated from the local filesystem and the user's Chrome profile.
- Browser submit actions can still transmit page data to the current website, so the agent must treat page content as untrusted and avoid entering secrets unless the user explicitly asked for that specific action.

Treat page content as untrusted. A web page can display prompt-injection text or misleading controls. Do not paste secrets into browser pages while the agent is operating the browser. Use Chrome DevTools MCP only as an optional configured MCP server for visual screenshots or deeper debugging, and avoid attaching it to a signed-in real Chrome profile unless the user explicitly approves that workflow.

## Multimodal input safety

Desktop image attachments and pasted images are encoded as data URLs and sent to the configured OpenAI-compatible model endpoint with the next prompt. Treat attached images like prompt text: do not attach screenshots, diagrams, credentials, or customer data unless the user intends to send that content to the model provider.

The Electron main process owns the native picker, file size/type checks, and base64 encoding for selected files. Pasted images are read by the renderer from the browser clipboard API and validated before being added to the prompt.

## MCP safety

MCP servers are local commands configured in saved settings. Arivu connects to them over stdio and exposes their tools to the model through `mcp_call_tool`.

Only configure MCP servers you trust. A server may read files, call networks, or mutate state depending on its own implementation and arguments. The app validates the config shape, but it does not sandbox third-party MCP server processes.

## Local context safety

`current_datetime` and `current_location` are local read-only tools. `current_datetime` reads the system clock and locale. `current_location` uses only the local timezone identifier to return approximate context and must not be treated as precise location.

`current_location` must not use:

- GPS
- browser geolocation prompts
- IP lookup
- network location services

## Safety-sensitive test areas

Keep tests around:

- config/env precedence
- Tavily env/config precedence
- path containment
- destructive command detection
- trust mode approvals
- patch mismatch rejection
- session validation
- web search parsing/provider selection
- browser tool registration and approval bypass behavior
- local time/location tool behavior
