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
- Desktop chat deletion, rename, and pin/unpin from recent chats and History.
- Desktop workspace open and create flows.
- Desktop expandable project chat groups, standalone Chats section, and draft-chat project selector in the prompt `+` menu.
- Desktop searchable model switching dialog, backed by the active OpenAI-compatible provider's `GET /models`.
- Desktop multiple-provider settings for OpenAI-compatible LLM providers. Each saved provider has a unique name, base URL, model id, tool-calling capability mode, image-input capability mode, and optional API key.
- Desktop image attachments and pasted/dropped-image upload in the composer for PNG, JPEG, WebP, and GIF prompts.
- Desktop workspace file-context attachments from the prompt `+` menu and `/files`, with bounded UTF-8 text sent as quoted prompt context.
- Desktop compact header/sidebar chrome, icon-only header actions with tooltips, and light/dark mode.
- Desktop prompt `+` menu for project/images/browser window/tools/skills/MCP options, plus a direct composer model switcher.
- Desktop hidden agent browser target plus separate tabbed visible browser window, backed by isolated Electron browser targets and a persistent Arivu browser profile.
- Desktop skills list and add-skill form backed by the global skills directory.
- Desktop composer slash commands for local actions: `/compact`, `/session`, `/tools`, `/skills`, `/files`, `/browser`, `/plan`, and `/loop`.
- Desktop one-shot read-only Plan approval mode with a composer toggle and `/plan`, persisted `planMode` task-run metadata, local read/discovery tool allowlisting for the planning run, persisted approve/revise/cancel plan review state, approved-plan drafting, and approved-plan-to-worktree handoff from captured Activity plan cards.
- Desktop one-shot bounded agent loop mode with a composer toggle, cooperative Stop Loop action, persisted loop metadata, per-iteration task-run ledger rows in Activity and copied audits, Activity/sidebar/history status, and hidden loop-control markers stripped from visible assistant replies.
- Desktop one-shot task worktree mode with a composer toggle and `/worktree`, creating an isolated git branch/worktree for the next prompt, recording the branch/path/base commit on the task run, exposing Activity actions to open the managed worktree folder, refresh diff summary, preview patch, sync the task branch with the current original checkout, open individual conflict files, continue or abort sync conflicts, prepare/create a draft PR, refresh created PR review/check/comment status plus bounded named check evidence, persisted review-state notifications, derived GitHub Actions log commands and external check-detail capture commands, persisted failed/cancelled/unknown check evidence command artifacts, and line-level review threads through GitHub CLI, derive ready/blocked/waiting merge cues from refreshed PR snapshots, merge, discard, or clean up the task worktree, blocking PR/merge promotion when run verification failed or a conflict is active, drafting Fix verification prompts that continue the same managed worktree branch, drafting Rerun checks prompts for continued repairs with unknown verification, drafting Review PR prompts from created PR cards with the last refreshed PR status, PR updates, check evidence, check-evidence commands, fetched evidence artifact ids, and bounded review feedback when present, showing a persisted repair history chain across continued attempts with Details/Open/Compare/Replay affordances, per-file attempt deltas, stored replay lineage, grouped replay outcomes, and Review handoff prompts with repeated-failure summaries plus minimal verification plans, showing promotion guidance when verification passes, and showing a Settings inventory for opening, preparing/creating PRs, discarding, or cleaning up recorded task worktrees across saved sessions.
- Desktop inline available-tools drawer, backed by the actual tool registry through IPC.
- Desktop Capability policy matrix in Settings, backed by the same trust-mode table used by approvals and tool status labels, with stricter per-workspace overrides for enforceable capabilities including repo reads plus path-prefix, network-domain, MCP-server, and browser target-class scope rules. Preset buttons apply common default, review-first, local-only, and locked-down workspace policies, named local profiles save/apply reusable bundles, and Workspace policy JSON can copy/apply normalized override and scope-rule bundles. Active scope rules are summarized in Settings and shown as chips on affected Tools drawer rows.
- Desktop MCP server JSON config in Settings plus `mcp_list_tools` and `mcp_call_tool`.
- Desktop Settings doctor and CLI `arivu doctor` diagnostics for API key, model listing, selected model, basic chat completions, streaming, tool calling, and Tavily. Settings doctor persists Tool calling as disabled for auto-mode saved providers when the tool probe proves unsupported.
- Desktop browser-style chat search with match navigation.
- Desktop collapsible/resizable left sidebar and slim Activity rail/panel.
- Desktop collapsible sidebar sections and Activity rows.
- Desktop durable per-query task runs. Each prompt stores run status, selected model/provider, plan/loop metadata, captured assistant plan state, coarse tool capabilities, approval records, tool-call records, and artifacts on the saved session, including screenshots and structured command/report evidence. The inline chat tool summary pairs each tool call with its matching result as a single step, while Activity rows keep the underlying call/result audit details lossless with recorded or inferred policy capability/effect details. Activity groups can copy a bounded Markdown audit summary for the run with per-tool policy evidence.
- Desktop UI concept samples for comparing visual directions.
- Desktop icon-only message actions: Edit/Copy on user messages, Retry/Copy on agent replies, assistant-reply retry that regenerates from the existing user bubble instead of duplicating it, failed-user-message Retry/Edit/Copy after send errors, and failed-prompt retry from the error strip with hover/focus labels.
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
- `sessions`, `resume <session-id>`, `compact <session-id>`, and `config get|set`; `arivu sessions` and TUI `/sessions [n]` support shared search/workspace/pinned/project filters, TUI `/sessions --pick` opens an interactive resume picker, `/resume <session-id>` switches the live TUI into that saved session, `/compact [n]` compacts the active saved session, and `/diff` shows a read-only staged/unstaged/untracked git summary for the active workspace.
- OpenAI-compatible `/chat/completions` client.
- Agent tool-call loop plus desktop bounded agent-loop mode for multi-iteration tasks.
- Harness foundation docs in `docs/HARNESS.md`, with task runs plus opt-in task worktrees and local worktree lifecycle actions implemented; sandbox execution remains a future milestone.
- Tools: `list`, `read`, `search`, `web_search`, `current_datetime`, `current_location`, `list_skills`, `read_skill`, `mcp_list_tools`, `mcp_call_tool`, `browser_open`, `browser_screenshot`, `browser_snapshot`, `browser_console`, `browser_click`, `browser_click_at`, `browser_type`, `apply_patch`, `write_file`, `run`, `git_status`.
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

Tests currently pass: run `npm test` for the current count.

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
- The active provider also supplies the runtime tool-calling mode: `auto` sends tools and downgrades on provider schema errors, `enabled` sends tools and surfaces errors, and `disabled` starts in Markdown/no-tools mode for plain-chat endpoints.
- The active provider also supplies the runtime image-input mode: `auto` keeps OpenAI-compatible image parts enabled, `enabled` marks the provider as a known image-capable endpoint for Auto routing, and `disabled` fails image prompts before sending image data.
- Auto-mode provider capability observations are persisted after real provider failures: tool-schema rejection saves Tool calling as `disabled`, and image-part rejection saves Image input as `disabled`. Explicit `enabled` choices are not overwritten.
- Settings doctor can also persist Tool calling as `disabled` when its forced tool-call probe gets an unsupported-tools response.
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
- The sidebar Workspaces section doubles as the recent workspace list: folder/name rows reopen a saved workspace directly, while the chevron expands that workspace's chats.
- `blessed` remains for the TUI fallback.
- OpenAI-compatible API support is the provider layer for v1; direct provider-specific SDKs are deferred.
- Model listing is provider-scoped. A combined model picker would need grouped provider rows and would need to switch both provider and model together.
- Batch chat requests omit `stream` instead of sending `stream: false`; streaming requests send `stream: true`.
- Provider tool/fallback failures are handled at runtime by retrying without tools and converting tool history into plain-text transcript entries.
- Assistant tool-call messages with no natural-language text are sent as `content: null` instead of `content: ""` because some OpenAI-compatible endpoints reject empty assistant message content.
- Blank assistant history messages without tool calls are omitted from provider requests because they carry no useful context and stricter models such as `diffusiongemma-26b-a4b-it` reject them on follow-up prompts.
- Desktop send failures keep the optimistic user message visible in renderer state, add Retry/Edit/Copy on that failed bubble, and retry the same bubble without duplicating the query. Completed assistant replies can also be retried from their source user message; the old assistant/tool tail is replaced before the new run starts.
- Desktop sends create a durable task run before the model starts. Tool events update the active run, and the Activity rail attaches run status, model/provider, capabilities, loop metadata, and artifacts to the query group.
- Plan approval mode is one-shot. It records `planMode`, injects a planning instruction, disables Loop/Worktree for that prompt, advertises only local read/discovery tools, persists approve/revise/cancel review state on captured plan cards, and only drafts follow-up prompts after approval. Approved cards can either draft a normal execution prompt or draft the plan into a new task worktree that persists `plannedFromTaskRunId`; plan-derived worktrees ask for and persist final `Completion notes:` from the agent, then show an Approved plan source card with checklist, changed-path, patch-preview, verification cues, and per-step completion notes. Notes cite matching changed files, verification commands, parsed reports, TypeScript/ESLint command diagnostics, refreshed PR checks, model-authored evidence labels, or assistant close-out bullets when a conservative text match exists, keep unmatched steps as needing evidence, and mark all steps blocked when verification fails. Command-result rows render captured TypeScript and ESLint diagnostics and expose guarded Open actions for diagnostic source files.
- Task worktree mode keeps saved chats attached to the original project while constructing the agent with the isolated worktree as the execution cwd. It requires a git-backed project with at least one commit. Activity worktree merge requires the original checkout to be clean, the changed worktree to have a stored patch preview, the task run verification not to be failed, and no active worktree conflict; it auto-commits dirty task worktree changes and fast-forwards the original checkout to the task branch. Sync merges the current original checkout into the task branch, records conflicted files when Git stops, and exposes Continue/Abort conflict actions from Activity. Created PR cards can refresh PR review/check/comment/thread/check snapshots manually or through a user-started Watch PR timer in the current session, store compact notifications for review/check/feedback changes since the previous snapshot, then fetch failed/cancelled/unknown GitHub Actions logs or external check-detail captures into bounded command artifacts linked from the check evidence rows. Repair and verification-rerun prompts can continue a previous ready worktree by sending `worktree: { enabled: true, taskRunId }`, and the new run records `continuedFromTaskRunId`.
- Trust-mode decisions flow through `src/permissions/capabilityPolicy.ts`. `ApprovalManager`, the desktop Tools drawer, and Settings all use the same capability table for allow/prompt/deny behavior across `write_workspace`, `run_command`, `network_fetch`, `browser_control`, and `mcp_call`. Browser control is allowed without approval by default to avoid interrupting agent browsing, but saved workspace policy overrides can still tighten browser and other enforceable capabilities to prompt or deny. Settings can discover `.arivu/workspace-policy.json` as an explicit-apply team bundle, while named local profiles and JSON transfer use the same normalized policy payload.
- Context compaction is deterministic and local; it does not call the model to summarize. It preserves non-compaction system prompts, replaces older visible turns with one hidden system compaction note, normalizes retained tool protocol into plain text, and saves the active session. Desktop exposes it through `Compact context` and `/compact`, the TUI exposes `/compact [n]`, and the CLI exposes `arivu compact <session-id>` with `--recent`, `--entry-limit`, and `--dry-run`.
- Existing-file edits should prefer unified patches.
- Full-file writes are allowed for creation and explicit replacement only.
- The agent must not write outside the active workspace.
- Assistant system prompts include a no-emoji instruction for new and resumed sessions.
- Web search uses local function tools, not MCP. Tavily is preferred when configured and uses `basic` depth by default to avoid casually spending extra credits. The no-key fallback uses Bing RSS, with Bing News RSS for news-like queries.
- `current_datetime` and `current_location` are local read-only tools. `current_location` intentionally uses timezone context only and avoids GPS, IP lookup, browser geolocation, and network location.
- The desktop Tools drawer lists registry schemas from the Electron main process instead of duplicating tool metadata in renderer state, and it receives active workspace scope labels from the same policy path used for enforcement.
- Browser tools are desktop-only and route through `desktop/main/browserController.ts`. Agent calls default to the hidden isolated Electron target, while explicit visible calls use a separate maximized tabbed browser window. Visible tabs are individual `BrowserView`s, share Arivu's persistent browser partition, and can be targeted by `tabId`; `browser_open` can also create a visible tab with `newTab: true` and turns non-URL text into a Google search URL. Chrome DevTools MCP is optional through normal MCP config and preferred for visual screenshot work or deeper diagnostics when configured.
- The desktop image picker is owned by the Electron main process. The renderer receives picker data URLs plus display metadata and never gets direct Node filesystem access. Pasted and dropped images are read by the renderer as data URLs and follow the same attachment limits.
- Skills live globally under the app data directory's `skills/` folder, or `ARIVU_SKILLS_HOME` when set. The agent advertises discovered skills, exposes `list_skills` and `read_skill`, persists composer-loaded skills as hidden chat context, and attaches explicitly requested `$skill-name` content before that model turn.
- MCP servers live in saved config as `mcpServers`. The desktop Settings UI edits the JSON object, and MCP tool calls use short-lived official SDK stdio clients.
- The desktop chrome is intentionally compact: no session id in the header, icon-only header actions with CSS tooltips, and a narrower Activity rail by default.
- The agent permits one `web_search` call per user request, then disables tools for the answer turn to avoid repeated search loops on models that keep reissuing search calls.
- Token counting for pasted composer text is local and estimated. It is not an LLM tool because sending text to a tool via the model would already spend context.
- No initial git commit has been created unless a future developer does it.

## Known limitations

- Desktop packaging is not implemented; current desktop mode is local dev/start only.
- Tool output is summarized in the activity pane, with diff previews for patch/file-write activity where available. Activity rows can collapse/expand.
- Task runs record captured plan/capability/tool/artifact metadata. Direct write approval rows store bounded pre-apply previews for proposed `apply_patch` diffs or `write_file` content, direct `apply_patch` edits are captured as bounded patch artifacts with changed paths and line stats after success, direct `write_file` edits are captured as bounded file-change artifacts with write mode and new-content preview after success, direct edit artifacts can draft revert prompts from their saved evidence, and large direct edits are marked as risky write reviews before applying outside managed task worktrees. Command output is captured as an artifact with command text, shell-vs-argv mode, parser-derived risk/analysis summary, execution profile/isolation/cwd metadata, exit code, duration, bounded stdout/stderr snippets, detected test-report paths, parsed JUnit/SARIF summaries, bounded failing-test/finding previews, and Activity can copy a bounded Markdown audit summary for a whole run. PR check evidence fetches also use bounded command artifacts and link the saved artifact id back to the refreshed check evidence row. Refreshed PR snapshots keep compact update notifications for changed review/check/feedback state. Tool Activity rows and audit summaries now show matching policy effect/reason when approval audit evidence exists, or an explicit tool-name capability inference when only transcript protocol is available. Run-level verification summaries gate task-worktree PR/merge promotion when failed. Passed-verification promotion hints, created-PR Review PR prompts seeded with manually refreshed or watched PR review/check/comment/check snapshots, PR updates, derived check-evidence commands, fetched evidence artifact ids, and line-level thread summaries when present, persisted repair history chains with focus/open/compare/replay controls plus `replayOfTaskRunId` lineage, Activity open actions for attached report/source evidence, Draft fix prompts, worktree-level Fix verification and Rerun checks prompts, replay failure Review prompts with pattern summaries and focused verification plans, and one-shot Loop continuation injection for the latest failed report evidence inside the execution workspace are implemented.
- Task worktree open/sync/merge/discard/cleanup and PR creation are local desktop actions. Create PR requires GitHub CLI credentials and a usable origin remote. Conflict resolution is Activity-driven today: open the managed folder or individual conflicted files from the conflict card, resolve files, then Continue or Abort the recorded sync conflict.
- Approval prompts are action-aware for shell and write actions, but still need more polish for a production-grade UX.
- Automatic provider capability persistence from observed tool-schema and image-part failures is implemented for auto-mode providers. Settings doctor writeback is implemented for unsupported tool calling, but proactive image capability probing is not implemented.
- Desktop history exists with deletion, and the CLI can list/filter recent sessions with `arivu sessions`.
- Workspace creation currently creates an empty folder; there is no project template or git initialization flow yet.
- No packaging or release workflow beyond `npm link` and local build.

## Good next work

Best next milestone: deepen the coding-agent workflow now that the desktop cockpit basics are in place.

High-value tasks:

- Add provider-specific PR-check artifact ingestion beyond generic GitHub Actions log and external check-detail captures.
- Deepen command diagnostics into broader language-server evidence beyond TypeScript and ESLint command-output parsing.
- Add signed or centrally managed workspace policy distribution for teams that need stronger provenance than a checked-in bundle file.
- Polish stale-path recovery and cleanup for recent workspace rows.
- Add richer remediation and proactive provider capability probes beyond the implemented Settings doctor tool-calling writeback.
- Add provider-specific multimodal capability probes beyond observed image-part request failures.
- Add first-run setup flow for base URL, model, API key, and trust mode.
- Add tests around TUI command handling by extracting pure command logic.
