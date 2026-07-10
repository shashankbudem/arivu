# Improvement Plan

Reviewed 2026-07-08 against the full codebase (agent core, provider client, tool registry, permissions, sessions, compaction, desktop main/renderer, TUI, docs). Test suite at review time: 284 passing across 29 files (`npm test`). This plan is ordered by leverage; an agent picking this up should start at P0 item 1 and work down unless directed otherwise.

## Progress log

Updated 2026-07-08 (implementation pass). Test suite now 319 passing across 33 files (`npm test`; the ~10 `tests/cli.test.ts` failures that appear only in sandboxes blocking `/tmp` IPC pipes, or when the shell forces chalk colors, pass in a normal environment). `npm run typecheck`, `npm run build`, and `npm run desktop:build` are all green.

**P0 — all done.**

- **P0.1 Mid-run cancellation — DONE.** `AbortSignal` threads through `AgentRunOptions` → chat client `fetch` → `execa` (`cancelSignal`) and is checked between agent steps. Desktop: per-session `AbortController`, `agent:stopRun` IPC, composer Stop button. TUI: Esc cancels a running turn. Stopped runs record `"stopped"` and roll the session back.
- **P0.2 Editing/reading tool overhaul — DONE.** New `edit` tool; `read` paging + line numbers; `search` context/glob/max-results + pure-JS fallback; `run` output truncation.
- **P0.3 Web-search lockout — DONE.** Only `web_search` is withheld after a search.
- **P0.4 Provider resilience & usage — DONE.** Backoff retry (honoring `Retry-After`), configurable `requestTimeoutMs`, `stream_options.include_usage`, usage parsed and persisted on `AgentTaskRun.usage`, surfaced in desktop `/session` details and the TUI status line.
- **P0.5 Per-model context windows & summary compaction — DONE.** `contextWindowTokens` per provider + top-level config (with a Settings input) drives the transient-compaction token budget. Optional model-generated summary compaction via `Agent.summarizeContext()` (deterministic fallback), exposed as desktop `/summarize` and TUI `/summarize`.
- **P0.6 Loop hygiene — DONE.** Versioned system prompt rebuilt per run; MAX_STEPS message now offers continuation (TUI `/continue`, `Agent.continue()`); `shouldRefreshBrowserEvidence` gained a per-session frequency cap and skip-on-failure.

**P1 — done except the incremental monolith breakup.**

- **P1.1 Break up the monoliths — STARTED (incremental).** Extracted pure formatters from `App.tsx` into `desktop/renderer/src/format.ts` (with `tests/rendererFormat.test.ts`); structured approval rendering moved to data (see P1.4). The bulk of the App.tsx/main.ts/styles.css decomposition remains deliberately incremental future work.
- **P1.2 Delivery pipeline — DONE (needs one install step).** CI workflow, ESLint/Prettier config, and `tests/agentSmoke.test.ts`. Still requires `npm install` to pull the eslint/prettier devDeps, then triage the initial lint output and flip the CI lint job to blocking.
- **P1.3 Session durability — DONE.** Atomic `SessionStore.save` (temp file + rename); large image attachments externalized to per-session files with references and rehydrated on load (backward compatible). Tests in `session.test.ts`.
- **P1.4 Structured approval payloads — DONE.** `ApprovalManager` sends a structured `ApprovalPromptRequest` to the prompt; the desktop forwards it over IPC and renders from data, falling back to text parsing. Concurrent prompts are serialized. Tests in `approvalParsing.test.ts`.

**P2 — done (packaging needs credentials to run).**

- **P2.1 Packaging/distribution — DONE (config).** `electron-builder.yml`, notarize afterSign hook, entitlements, npm publish metadata, and `docs/PACKAGING.md`. Running installers/notarization needs `npm install` plus signing credentials.
- **P2.2 First-run onboarding — DONE.** Guided provider/API-key/trust-mode modal that saves config and validates via `doctor`.
- **P2.3 Parallel tool execution — DONE.** Consecutive read-only tool calls run concurrently (bounded); writes/commands stay sequential and ordered.
- **P2.4 Non-worktree rollback — DONE.** Per-run `ChangeCheckpoint` records pre-edit file state; desktop persists it and offers "Undo run changes"; TUI unaffected.
- **P2.5 Doc drift cleanup — DONE.** `PROJECT.md` tool list, approval note, and test count refreshed.

**P3 — Later / depth (mostly infrastructure-gated).**

- TUI polish — narrow-terminal responsive tiers + explicit wrapping landed; richer inspection remains.
- Sandboxed execution profiles, sub-agent fan-out, an Anthropic-native provider with prompt caching, and signed team-policy bundles remain open. These need infrastructure beyond a code change (an OS-level sandbox runtime, a new provider protocol, code-signing/PKI) and should be scoped as their own efforts.

Everything below is the original plan, retained for the remaining work.

## Context for the implementing agent

- Validation commands: `npm run typecheck`, `npm test`, `npm run build`, `npm run desktop:build`.
- Note: `npm test` spawns `tsx` child processes that create IPC pipes under `/tmp`; sandboxed environments that block that will show ~10 false failures in one file.
- The weaknesses cluster in three places: the core agent loop is weaker than the scaffolding around it, the renderer/main-process code has outgrown its structure, and there is no delivery pipeline (no CI, no lint config, no packaging).
- Existing strengths to preserve: capability policy + approval audit system, durable task runs, worktree/PR lifecycle, provider fallback hardening, deterministic compaction. Do not regress these; most have tests in `tests/`.

## P0 — Core agent quality (highest product leverage)

These directly cap how good the agent feels, regardless of UI polish.

### 1. Mid-run cancellation

There is no `AbortController` anywhere in `src/agent/Agent.ts`, `src/agent/OpenAICompatibleChatClient.ts`, or `src/tools/registry.ts`. The only stop control is `agent:stopLoop` (`desktop/main/main.ts:3178`), which acts only *between* bounded-loop iterations. A run can be 20 tool steps with 120s-default commands and the user can only watch.

Plan:
- Thread an `AbortSignal` through `AgentRunOptions` → the `fetch` calls in the chat client → `execa` calls (`registry.ts` `run`, `search`, `git_status`) and MCP/browser tools.
- Add a Stop button in the desktop composer (new IPC channel, e.g. `agent:stopRun`) and Esc handling in the TUI.
- Record `"stopped"` status on the task run — the `AgentTaskRunStatus` enum already includes it (`src/agent/types.ts`).
- Reuse the existing rollback path in `Agent.runWithPreparedSession` so a stopped run leaves the session consistent.

### 2. Editing/reading tool overhaul

The registry (`src/tools/registry.ts`) has only `apply_patch` (unified diff — the format models flub most) and `write_file` (full replacement). Gaps:

- No exact string-replace `edit` tool.
- `read` returns no line numbers and has a hard 20KB cap (`MAX_TOOL_READ_BYTES`, `registry.ts:43`) with **no offset/limit** — anything past the first 20KB of a file is permanently invisible to the model.
- `search` has no context lines, glob filters, or match caps, and assumes `rg` is on PATH (falls back to returning the spawn error text).
- `run` stdout/stderr are unbounded in the tool result (transient request compaction mitigates model requests, but full output is stored in the session transcript).

Plan:
- Add an `edit` tool: old-string/new-string with uniqueness check (fail if 0 or >1 matches unless `replaceAll`), routed through the same write approval path and `FileStateTracker` read-before-write checks as `write_file`.
- Add `offset`/`limit` params and `line:`-numbered output to `read`; keep a per-call byte cap but allow paging through large files.
- Add context-lines/glob/max-results options to `search`; add a pure-JS fallback scan when ripgrep is missing.
- Truncate `run` output at the tool boundary with a bounded head+tail excerpt and a truncation notice.
- Extend `tests/toolRegistry.test.ts` for all of the above.

### 3. Fix the web-search tool lockout

In the agent loop, `const availableTools = webSearchCalls > 0 ? [] : toolSchemas` (`src/agent/Agent.ts:158`) removes **every** tool for **all remaining steps** after one `web_search` — not just `web_search` for the next turn. A coding task that searches once can no longer read or edit files for the rest of the run.

Plan: after a web search, filter out only `web_search` (keeping the existing transient "answer from results" instruction for the immediately following turn), or restore the full toolset after the answer turn. Update `tests/agent.test.ts` accordingly.

### 4. Provider resilience and usage accounting

`OpenAICompatibleChatClient` treats a 429/5xx/network blip as a hard run failure (with full message rollback), and never reads `usage` from responses, so the Activity audit has no token/cost data.

Plan:
- Bounded retry with exponential backoff for retryable statuses (429, 500, 502, 503, network errors), distinct from the existing tool-schema/markdown fallback logic.
- Add a configurable request timeout.
- Request `stream_options: { include_usage: true }` when streaming; parse `usage` in batch responses; persist per-run prompt/completion token counts on the task run; surface in Activity and desktop/TUI `/session`.

### 5. Per-model context windows and smarter compaction

`AUTO_COMPACT_REQUEST_TOKEN_LIMIT = 48_000` (`src/agent/contextCompaction.ts:5`) applies to every provider/model, and context-length errors are detected by regex (`Agent.ts` `isContextLengthError`).

Plan:
- Per-provider/model context-window setting in Settings with sensible defaults (from `/models` metadata where the endpoint exposes it), consumed by the transient request compaction path.
- Optional model-generated summary compaction alongside the deterministic one (explicit user action first; keep the deterministic path as default/fallback).

### 6. Loop hygiene

- `MAX_STEPS = 20` (`Agent.ts:12`) ends with a dead-end "Stopped after reaching the maximum tool-call depth." — offer continuation (desktop button / TUI command) that resumes with `Agent.continue()`.
- The system-prompt migration block (`Agent.ts:89-115`) patches saved sessions' system message by appending sentences and will accrete forever. Replace with a versioned system prompt rebuilt (not patched) per run; keep saved-session compatibility.
- `shouldRefreshBrowserEvidence` (`Agent.ts:388`) fires on generic words like "done"/"instance"/"login" and silently spends synthetic browser tool calls. Make it cheaper to be wrong (skip on failure, cap frequency per session) or replace the synthetic calls with a transient hint that lets the model decide.

## P1 — Structure and safety nets (keeps future work cheap)

### 1. Break up the three monoliths

- `desktop/renderer/src/App.tsx`: 10,634 lines, ~269 functions in one file; zero renderer tests.
- `desktop/renderer/src/styles.css`: 8,926 lines.
- `desktop/main/main.ts`: 3,245 lines; `DesktopController` is a god object.

Plan: extract renderer feature modules (Composer, Chat/Messages, Activity, TaskWorktree cards, Settings, Sidebar, ModelPicker) with co-located styles and shared hooks for IPC state; split `DesktopController` into services (sessions, providers/routing, task runs, worktree/PR, policy). Incremental — one feature per PR, adding component tests as modules come out. Do this **after** CI/lint exist (next item) so the refactor lands with guardrails.

### 2. Delivery pipeline

No `.github`, no ESLint/Prettier, nothing enforcing typecheck/tests (Roadmap M6 acknowledges this).

Plan: ESLint + Prettier config; GitHub Actions running typecheck/test/build on PR; a smoke test that runs the agent against a fixture repo with a scripted fake `ChatClient` (the interface in `src/agent/types.ts` makes this cheap).

### 3. Session durability and size

- `SessionStore.save` (`src/sessions/SessionStore.ts:485-490`) writes JSON in place — a crash mid-write corrupts the session. Write to a temp file in the same directory, then rename.
- Image attachments are stored as inline base64 data URLs inside session JSON (`desktop/main/main.ts:2469`). Move binaries to per-session attachment files with references; keep backward compatibility for existing sessions.

### 4. Structured approval payloads

The renderer parses approval *text* back into shell/write views (`desktop/renderer/src/approvalParsing.ts`; noted in PROJECT.md interface notes). Send the structured approval request over IPC instead and render from data; keep the text form only as fallback.

## P2 — Product gaps

1. **Packaging/distribution** — electron-builder + macOS notarization, release script, npm publish metadata. The desktop app currently only runs from a source checkout; this is the biggest barrier to outside users.
2. **First-run onboarding** — guided provider/API-key/trust-mode setup (long-standing Roadmap M1 item); reuse `arivu doctor` checks as the validation step.
3. **Parallel tool execution** — run independent read-only tool calls from one assistant turn concurrently; keep writes/commands sequential.
4. **Non-worktree rollback** — the staged patch queue Roadmap M5 mentions: checkpoint direct edits per run so "undo this run's changes" works outside worktrees.
5. **Doc drift cleanup** — PROJECT.md says "56 tests" (284 at review time) and its tool list is stale; fold it into the accurate ARCHITECTURE.md or refresh it.

## P3 — Later / depth

- Sandboxed execution profiles (the `container`/`sandbox` stubs in `src/execution/profile.ts`).
- Sub-agent fan-out for parallelizable work.
- Anthropic-native provider with prompt caching; provider presets.
- Signed/centrally managed team policy bundles.
- TUI polish (narrow-terminal wrapping, richer inspection).

## Suggested sequencing

P0 items 1–3 first (cancellation, edit/read tools, web-search lockout) — small, isolated changes in `Agent.ts`, `registry.ts`, and the chat client with existing test patterns to extend. Then P1 item 2 (CI + lint) before starting the App.tsx decomposition, so the refactor has guardrails. P0 items 4–6 can interleave.
