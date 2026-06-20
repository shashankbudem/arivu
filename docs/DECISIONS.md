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
