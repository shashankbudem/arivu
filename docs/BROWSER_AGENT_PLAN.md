# Browser Agent Plan — page-agent delegation

Drafted 2026-07-08. Goal: make Arivu's in-app browser tasks faster, more precise, and
cheaper on main-agent context by delegating the in-page observe→act loop to Alibaba's
[page-agent](https://github.com/alibaba/page-agent) (MIT), while keeping our existing
Electron browser as the shell. This document is the plan only; implementation is scoped
separately.

## TL;DR

- We do **not** use Playwright/Puppeteer anywhere today (verified: only a `playwright-report`
  filename regex in `src/agent/taskRuns.ts`; nothing installed). Our browser automation is
  100% Electron `webContents` in `desktop/main/browserController.ts`. There is nothing to
  "replace" — the choice is Electron-shell + page-agent-loop vs. our current manual
  `browser_*` tools.
- Split of responsibilities:
  - **Shell** (open window, tabs, navigate, back/forward, screenshots, console, network) →
    our existing Electron `browserController`. page-agent has no shell layer by design.
  - **In-page loop** (read DOM, click, type, scroll, select) → injected page-agent.
  - **Navigation survival** (re-inject + resume across page loads) → a new main-process
    supervisor. This is the real engineering work; page-agent alone loses its state on
    navigation, which is why upstream ships a Chrome extension for multi-page tasks.
- Why it's faster than a Playwright-style stack: the loop runs *inside* the page (no
  CDP/IPC round-trip per action), and each LLM step sends only a small "dehydrated" DOM
  text, so a cheap/fast model can drive it.
- Main win beyond speed: **context preservation**. Today a browser task spends the main
  agent's context on snapshot → click → snapshot → type rounds. Delegation collapses that
  to one `browser_task` tool call and one result.

## Boundary: what this stack cannot do

Electron only ever automates its *own* embedded Chromium. This stack is complete for the
in-app browser, but the following remain out of scope and are the genuine Playwright/CDP
use cases — call them out to the main agent so it can decline or route elsewhere:

- Driving the user's **own installed Chrome** with their logged-in profile/extensions.
- **Headless/server/CI** browser runs with no Electron window.
- **Cross-origin iframes**, OS-level file dialogs, and browser download/upload prompts —
  page-agent runs in page context and cannot reach these; the supervisor must detect and
  hand back to the main agent's manual tools.
- Anti-bot / trusted-event gating: page-agent clicks are synthetic (`isTrusted: false`),
  same limitation as our current click. Our Electron `sendInputEvent` path (below) is the
  only workaround and lives on the manual tools, not inside page-agent.

## Current state (baseline)

- `desktop/main/browserController.ts` — Electron browser: visible/background modes, tabs,
  `open`/`selectTab`, screenshots, console capture, multi-frame + shadow-DOM snapshots,
  script injection via `webContents.executeJavaScript`.
- `src/tools/registry.ts` — wires `browser_state`, `browser_select_tab`, `browser_open`,
  `browser_screenshot`, `browser_snapshot`, `browser_console`, `browser_click`,
  `browser_click_at`, `browser_type`.
- Known weaknesses these tasks expose (retained as the manual/escalation path, improved in
  Phase 4):
  1. `snapshotScript` returns a flat JSON array (≤220 elements) with fuzzy CSS selectors;
     `browser_click` re-finds the element by text at click time → wrong-element clicks on
     pages with repeated labels, and a token-heavy format.
  2. Click dispatches only `mouseover/mousedown/click/mouseup` — no pointer events, no
     focus, no hit-testing; modern frameworks often ignore it.
  3. No scroll (page or container), no explicit dropdown select, no wait, no in-page JS
     escape hatch.
  4. Each snapshot is from scratch; the model gets no "what changed" delta after an action.

## Architecture

```
main agent  ──browser_open──►  Electron browserController  (shell: tab + navigate)
main agent  ──browser_task──►  Supervisor (main process)
                                   │  inject page-agent bundle into tab
                                   │  configure baseURL → localhost model proxy
                                   ▼
                               page-agent loop (in page): observe DOM → act → …→ done
                                   │  onAskUser → ApprovalManager / TUI
                                   │  step events → streamed status
                                   │  did-navigate → re-inject + resume with history
                                   ▼
                               done(text) ──► single tool result to main agent
```

Delegate `core` (its LLM loop) and `ui` (virtual pointer/mask) via the injected bundle;
do **not** adopt its MCP server or its own model-config surface. Reuse `page-controller`'s
DOM dehydration and W3C-faithful actions — that is the battle-tested, browser-use-derived
part.

## Phases (leverage-ordered)

### Phase 1 — `browser_task` delegation tool  (est. 3–4 days)

The core of the feature.

- Bundle `page-agent` as an IIFE asset; inject into the target tab via the existing
  `executeJavaScript` path in `browserController.ts`.
- New tool **`browser_task(instruction, mode?, tabId?, maxSteps?, timeoutMs?)`**: main agent
  hands over a natural-language task; page-agent loops autonomously; return its `done` text
  (and success flag) as the single tool result.
- Bridge page-agent callbacks into our stack:
  - `onAskUser` → `ApprovalManager` / TUI prompt.
  - step/progress events → streamed status lines in TUI and desktop UI.
  - abort → our existing `AbortSignal` cancellation.
- **Model routing with key protection.** page-agent takes `baseURL`/`apiKey`, but injecting
  a real key into arbitrary page context leaks it to that page's scripts. Run a tiny
  localhost proxy in the Electron **main** process holding the real key; point page-agent's
  `baseURL` at it. Bonus: `src/config.ts` can specify a *separate, cheaper/faster* model for
  page tasks than the main agent — a large part of the perceived speed.
- Gate task start behind an approval (it clicks autonomously), with a step budget and
  wall-clock timeout.

**Done when:** a single-page task ("fill this form with X", "find the cheapest option on
this page") completes end-to-end from one `browser_task` call, with the key never present
in page context, honoring cancel + budgets.

### Phase 2 — Navigation survival  (est. 2–3 days)

Without this, `browser_task` only reliably handles single-page tasks.

- Main-process **supervisor** owns the durable task state: original instruction, accumulated
  step history, budgets.
- Listen to `did-navigate` / `did-navigate-in-page` / new-document loads on the task's tab;
  on navigation, re-inject the page-agent bundle and resume with "steps already completed: …"
  context so the loop continues instead of restarting.
- We are better positioned than upstream's Chrome extension because we own the browser and
  the main process — no extension messaging, direct `webContents` control.

**Done when:** a task spanning a navigation (e.g. search → results page → detail page)
completes without losing progress.

### Phase 3 — UX and safety polish  (est. combined 2–3 days with Phase 4)

- Visible mode: keep page-agent's virtual-pointer/mask UI (the demo behavior the user
  liked) so the user watches the sub-agent work; **suppress its prompt box** (instructions
  come from our agent). Background mode: disable the UI entirely.
- Safety rails on the supervisor: per-task domain allowlist; hard stops on sensitive
  patterns (payment / delete / submit-order confirmations route back through `ask_user`);
  full step log to the session store.

### Phase 4 — Interop + manual-path hardening  (est. combined with Phase 3)

- Keep the granular `browser_*` tools as the **escalation path**: main agent delegates
  first; on `browser_task` failure it takes over manually, and can verify page-agent's
  claimed result with one screenshot/snapshot instead of trusting it.
- Backport the high-ROI page-controller techniques to the manual tools so that path also
  improves:
  - **Indexed snapshots**: stamp interactive elements with an index held in a page-side
    `window.__arivu_selectorMap`; emit the browser-use text tree
    (`[i]<tag>label</tag>`, indented, `*` for new-since-last) that models are trained on,
    instead of / alongside the JSON blob.
  - `browser_click` / `browser_type` accept `index` (keep `target` as fallback), resolving
    through the selector map → exact targeting, no fuzzy re-match.
  - Upgrade click to the full W3C pointer sequence + hit-testing; adopt page-agent's input
    refinements (click-to-focus, contenteditable `beforeinput`/`execCommand` fallback, blur
    previous). Where element bounds are known, prefer Electron `webContents.sendInputEvent`
    at the element center so events are `isTrusted: true` — strictly better than any
    synthetic dispatch and something page-agent itself cannot do.
  - Add `browser_scroll` (container-aware, both axes, boundary feedback) and
    `browser_select_option`.
  - Auto-attach a fresh snapshot (with `*new` markers) to every browser action result so
    the model sees the effect without a second call.

## Model / config touchpoints

- `src/config.ts`: add a browser-task model block (separate `model`/`baseURL`/`apiKey`, or a
  reference to an existing provider) so page tasks can run on a cheaper/faster model.
- Localhost proxy lifecycle owned by the Electron main process; started lazily on first
  `browser_task`, bound to loopback only, real key injected server-side.

## Testing

- Local HTML fixtures for the cases the current manual path fails on and page-agent must
  pass: React-style pointer-event listeners, duplicate-label tables, shadow DOM,
  contenteditable, container scroll, a two-page navigation flow.
- Extend `tests/toolRegistry.test.ts` for the new `browser_task` tool wiring, approval
  gating, budgets, and cancellation.
- Assert the API key never appears in any string passed to `executeJavaScript`.

## Decisions to confirm before implementation

1. Bundle strategy: vendor a pinned page-agent IIFE build vs. depend on the npm package and
   build our own IIFE. (Pinned vendored build recommended for supply-chain control.)
2. Whether the browser-task model defaults to the main agent's model or requires explicit
   config (recommend: fall back to main model, allow override).
3. Default mode for `browser_task` (recommend: background, with visible opt-in matching the
   existing `browser_open` convention).

## Explicit non-goals

- No Playwright/Puppeteer/CDP dependency (nothing to remove; nothing to add).
- Not adopting page-agent's `core` LLM loop config surface or its MCP server.
- Not attempting user's-real-Chrome, headless/server, or cross-origin-iframe automation in
  this effort — noted as the boundary above.
