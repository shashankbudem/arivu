# Safety Model

Arivu (`arivu`) is allowed to operate on user repositories, so safety is a product feature, not a polish item.

## Trust modes

Trust modes are enforced through the capability policy table in `src/permissions/capabilityPolicy.ts`. The table maps harness capabilities to `allow`, `prompt`, or `deny` decisions, and `ApprovalManager` uses those decisions before sensitive tools run.

Desktop Settings can save stricter capability overrides for the current workspace root. Overrides can require approval or block enforceable capabilities such as repo reads, writes, shell commands, network fetches, browser control, MCP calls, and unknown tool activity. Overrides cannot grant `allow` or weaken a built-in `prompt`/`deny` decision. Settings can also save scope rules that block workspace-relative path prefixes for repo reads, direct writes, and patch targets; restrict network tools to an explicit destination-domain allowlist; restrict MCP discovery/calls to named configured servers; and restrict browser actions to target classes such as `background`, `visible`, `local`, `file`, and `public`. Default, review-first, local-only, and locked-down presets fill common workspace policy combinations before the user saves. Active scope rules are summarized in Settings and shown on matching Tools drawer rows.

Desktop task runs persist approval audit records for automatic allows, policy blocks, requested approvals, approvals, and denials. Each approval audit can include a compact action scope, such as the path being read or written, shell command, network host, browser target, or MCP server/tool. The Activity rail renders those records beside tool calls so restored sessions keep the control-plane decision history and the relevant target. Path, network, MCP server, and browser target-class scopes are enforceable through workspace scope rules today.

Shell commands currently run only through the explicit `host` execution profile, which means a local host process in the active workspace or task worktree. The `run` tool accepts future `container` and `sandbox` profile names, but those profiles fail closed before approval or execution until a real isolated backend is configured.

### `readonly`

Repo read tools are allowed by default in `readonly`, but a workspace `read_repo` override can require approval or block them.

Allowed:

- `list`
- `read`
- `search`
- `current_datetime`
- `current_location`
- `list_skills`
- `read_skill`
- browser tools against isolated Arivu browser targets: `browser_open`, `browser_screenshot`, `browser_snapshot`, `browser_console`, `browser_click`, `browser_click_at`, `browser_type`
- `git_status`

Requires approval:

- `web_search`

Denied:

- file writes
- patch application
- shell commands
- MCP tool listing/calls when they would start or use configured MCP servers

### `ask`

Repo read tools are allowed automatically in `ask`, unless a workspace `read_repo` override requires approval or blocks them.

Allowed automatically:

- reads
- searches
- browser open/click/type/screenshot/snapshot/console actions against isolated browser pages
- local skill listing
- local skill reads
- directory listing
- git status

Requires approval:

- `apply_patch`
- `write_file`
- `run`
- `web_search`
- MCP tool listing/calls

MCP tools:

- `mcp_list_tools` can start configured MCP server processes, so it requires approval when servers are configured.
- `mcp_call_tool` delegates behavior to the configured MCP server, is blocked in `readonly`, and requires approval in both `ask` and `trusted` modes because arbitrary MCP server side effects are unknown to Arivu.

### `trusted`

Repo read tools are allowed automatically in `trusted`, unless a workspace `read_repo` override requires approval or blocks them.

Allowed automatically:

- workspace reads
- workspace writes
- local browser interactions that do not submit data or open external targets

Still requires approval:

- shell commands
- network searches
- MCP tool listing/calls

Browser actions remain allowed by default in `trusted`, but workspace browser-control overrides and browser target-class scope rules can require approval or block them for sensitive workspaces.

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

The background browser target and visible tabbed browser window share Arivu's persistent isolated Electron browser partition. Cookies and login state can carry across Arivu browser sessions, but neither target shares the user's Chrome profile, extensions, or existing tabs.

Browser control policy:

- `browser_open`, `browser_screenshot`, `browser_snapshot`, `browser_console`, `browser_click`, `browser_click_at`, and `browser_type` route through the capability policy table.
- In `readonly`, `ask`, and `trusted`, browser open/read/click/type actions are allowed without approval by default.
- Browser actions are still recorded in the task-run audit trail as browser-control activity.
- Workspace capability overrides can require approval or block browser control for sensitive workspaces.
- Workspace scope rules can restrict browser actions to target classes. `background` and `visible` describe the browser mode; `local`, `file`, and `public` describe the page URL when Arivu can identify it.
- Browser submit actions can still transmit page data to the current website, so the agent must treat page content as untrusted and avoid entering secrets unless the user explicitly asked for that specific action.

Treat page content as untrusted. A web page can display prompt-injection text or misleading controls. Do not paste secrets into browser pages while the agent is operating the browser. Use Chrome DevTools MCP only as an optional configured MCP server for visual screenshots or deeper debugging, and avoid attaching it to a signed-in real Chrome profile unless the user explicitly approves that workflow.

## Multimodal input safety

Desktop image attachments and pasted images are encoded as data URLs and sent to the configured OpenAI-compatible model endpoint with the next prompt. Desktop file-context attachments are read from the active workspace, bounded, and sent as quoted prompt text. Treat attached images and files like prompt text: do not attach screenshots, diagrams, credentials, source files, or customer data unless the user intends to send that content to the model provider.

The Electron main process owns the native picker, file size/type checks, and base64 encoding for selected files. Pasted images are read by the renderer from the browser clipboard API and validated before being added to the prompt.

## MCP safety

MCP servers are local commands configured in saved settings. Arivu connects to them over stdio and exposes their tools to the model through `mcp_call_tool`.

Only configure MCP servers you trust. A server may read files, call networks, or mutate state depending on its own implementation and arguments. The app validates the config shape, but it does not sandbox third-party MCP server processes.

Workspace MCP server allowlists filter `mcp_list_tools` discovery to matching configured servers and block `mcp_call_tool` attempts against other server names before the MCP process is used.

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
- browser tool registration and approval policy behavior
- local time/location tool behavior
