# Project: Arivu P1 Improvements

## Architecture

- **Agent core** (`src/agent/`): agent loop, OpenAI-compatible chat client, streaming events, fallback handling.
- **Chat content** (`src/agent/content.ts`): shared text/image content model and plain-text projection helpers.
- **Skills** (`src/agent/skills.ts`): workspace skill discovery for `.arivu/skills`.
- **Electron main** (`desktop/main/main.ts`): `DesktopController`, IPC handlers, workspace/session/config/model/tool metadata.
- **Electron preload** (`desktop/main/preload.ts`): context-isolated `window.arivu` API.
- **React renderer** (`desktop/renderer/src/App.tsx`): chat workspace, compact chrome, Activity rail, composer, tools drawer, approvals, settings, history, UI samples.
- **Styles** (`desktop/renderer/src/styles.css`): desktop layout, themes, UI concepts, tooltips, Activity/diff/approval styling.
- **TUI** (`src/tui/TuiApp.ts`): blessed-based terminal fallback.
- **Tools** (`src/tools/`): local tool registry, path safety, patching, web search, local context tools.
- **Tests** (`tests/`): vitest suite covering agent, tools, provider fallback, safety, config, sessions, and token budgeting.

Tech: TypeScript, ESM, React 19, Electron 42, blessed, tsup, Vite, vitest.

## Current P1 State

| # | Area | Status |
|---|------|--------|
| 1 | Response streaming | Implemented via optional `ChatClient.stream()` and renderer `agent:event` updates. |
| 2 | Provider fallback hardening | Implemented for NVIDIA-style JSON/tool payload failures, empty assistant content rejection, blank history cleanup, and no-tools Markdown retry. |
| 3 | Diff/activity rendering | Implemented for patch/file-write activity previews where available. |
| 4 | Rich approvals | Implemented for parsed shell/write approvals; still needs copy/polish. |
| 5 | Desktop chrome | Implemented compact header/sidebar, icon-only header actions with tooltips, light/dark mode, UI samples. |
| 6 | Tool discovery | Implemented `tools:list` IPC and inline composer tools drawer. |
| 7 | Local context tools | Implemented `current_datetime` and timezone-only `current_location`. |
| 8 | Multimodal prompts | Implemented desktop image attachments and OpenAI-compatible `image_url` content parts. |
| 9 | Local skills | Implemented workspace skill discovery and read-only `list_skills`. |

## Interface Notes

- `ChatClient.stream(request, onEvent)` streams assistant deltas and tool-call deltas; `complete()` remains the batch fallback.
- Assistant tool-call history with no text is serialized with `content: null` instead of `content: ""` for stricter OpenAI-compatible endpoints.
- Desktop main forwards stream updates to renderer through `agent:event`.
- The preload bridge exposes `listTools()` so the renderer can display registry metadata without duplicating schemas.
- The preload bridge exposes `chooseImages()` so the main process owns image file selection and base64 encoding.
- `ChatMessage.content` supports plain strings or text/image content parts; saved sessions preserve image metadata for renderer display.
- Activity rows derive from assistant tool calls and tool result messages.
- Approval dialogs parse approval text into shell/write views while preserving approve/deny behavior.

## Current Tool Set

- `list`
- `read`
- `search`
- `web_search`
- `current_datetime`
- `current_location`
- `list_skills`
- `apply_patch`
- `write_file`
- `run`
- `git_status`

## Build & Validation

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run desktop:build`
- `npm run desktop:dev`

Current test suite: 56 tests.

## Next Work

- Add recent workspace list.
- Add first-run setup for base URL, model, API key, and trust mode.
- Add CLI/TUI session listing.
- Add provider health/doctor view in desktop.
- Polish approval copy and risk summaries.
- Add packaging/release workflow.
