# Model catalog

Arivu keeps a per-model record of every model its provider advertises: whether the model is actually
callable, and how large its context window really is. A daily job maintains it; the agent reads it to
size each request.

## Why it exists

`contextWindowTokens` in `config.json` is **per-provider and hand-entered**. Context length is a
**per-model** fact, so a single provider-wide number is wrong for every model but one — a 128k setting
silently claimed a 128k window for a 4,096-token model. And when it is unset (the common case), the
agent falls back to a conservative **48,000**-token budget, which on a 512k model means compacting at
~9% of capacity. Premature compaction rewrites tool calls into prose, which is a known cause of
tool-call mimicry and failed runs.

Two facts make probing the only option:

- The provider's `/v1/models` returns just `{id, object, created, owned_by}` — **no context metadata**.
- `/v1/models` is a **catalog, not an entitlement list**. On NVIDIA NIM, ~59 of 116 advertised models
  return `404 "Function '<uuid>': Not found for account"` when actually called.

Measured windows are also frequently *not* the advertised native value — `nemotron-nano-9b-v2` is
**127,984** (not 131,072) and `mistral-small-4-119b` is **262,128** (16 below 262,144). Never infer a
window from a model card or a name; store what the provider reports.

## Storage

Two files under the app data dir (`~/Library/Application Support/arivu/`):

| File | Role |
|---|---|
| `model-catalog.json` | Current state. Keyed by normalized baseUrl → model id. Read by the agent. |
| `model-catalog-events.jsonl` | Append-only change log. Never read by the app. |

Both are `0600`. The catalog is written atomically (temp file → `rename`), so a reader never sees a
partial file. Schema lives in `src/models/modelCatalogSchema.ts`.

```jsonc
{
  "version": 1,
  "updatedAt": "2026-07-16T02:00:00.000Z",
  "providers": {
    "https://integrate.api.nvidia.com/v1": {
      "baseUrl": "https://integrate.api.nvidia.com/v1",
      "providerIds": ["nvidia"],
      "lastFullSyncAt": "2026-07-16T02:00:00.000Z",
      "lastActiveSweepAt": "2026-07-13T02:00:00.000Z",
      "models": {
        "bytedance/seed-oss-36b-instruct": {
          "id": "bytedance/seed-oss-36b-instruct",
          "status": "available",
          "statusCheckedAt": "2026-07-16T02:00:00.000Z",
          "context": { "tokens": 524288, "source": "probe_max_tokens", "observedAt": "..." },
          "firstSeenAt": "...", "lastSeenAt": "..."
        }
      }
    }
  }
}
```

**Keyed by normalized baseUrl, not provider id** — a window is a property of *(endpoint, model)* and
survives a provider row being renamed or recreated.

**Tombstones, not deletion** — a model that disappears gets `removedAt` rather than being dropped.
That makes removal detection idempotent (it isn't re-reported every morning) and preserves an
already-probed window if the model returns. Pruned after 90 days.

**Statuses**: `available`, `not_entitled`, `busy`, `rate_limited`, `unknown`, `error`.

## The daily job

```
arivu models sync                 # what launchd runs at 07:00
arivu models sync --dry-run       # compute the diff, write nothing
arivu models sync --force-active  # include the active model on a non-Monday
arivu models sync --reprobe       # re-probe context even where already known
arivu models status               # show the stored catalog
arivu models status --all         # include tombstoned models
arivu models probe-context <model> [--deep]
```

Cadence: **non-active models daily; the active model on Mondays** (it's the one you're interactively
spending quota on). The split lives in code (`isActiveSweepDay`), not in a second launchd entry.

Because Monday-only would leave the active model's window stale for up to a week, the agent also
**learns from live failures for free**: when a real request overflows, the provider names the true
limit in its rejection, and `onContextWindowObserved` latches it into the catalog with
`source: "runtime_error"` — no extra API calls.

### Probing

- **Status (daily, cheap)** — `max_tokens: 1`. Deliberately *not* the oversized-`max_tokens` trick:
  several models (`llama-3.1-8b`, `gpt-oss-120b`, `glm-5.2`, `minimax-m3`) silently accept that and
  run full inference.
- **Context (once, then cached)** — context length is static, so it's probed on first sight and cached
  forever. An absurd `max_tokens` makes most backends reject the request *at validation* while naming
  their limit — no inference, no cost. Providers agree on neither wording nor status code, so
  `src/models/contextLimitParser.ts` holds a table of the real contracts.
- A model that ignores the probe stays **unresolved** rather than guessed at, and degrades to the
  conservative default.
- **A status timeout is not a verdict.** The status ping runs inference, so a large reasoning model can
  blow the deadline while being perfectly reachable. Context is therefore still probed for `unknown`
  models — the validation-only probe usually answers where the ping timed out.
- `--deep` uses an oversized *input* (multi-MB upload). Reliable on every model, but never run on the
  schedule (~250MB/day for a value that never changes).

Paced at 30 req/min by default, under the provider's observed ~40 RPM ceiling.

## Scheduling (macOS)

```bash
npm run build                       # the plist points at dist/cli.js
arivu models schedule --install     # writes ~/Library/LaunchAgents/com.arivu.model-catalog.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.arivu.model-catalog.plist

arivu models schedule               # status
arivu models schedule --uninstall
launchctl kickstart -k gui/$(id -u)/com.arivu.model-catalog   # force a run now
```

launchd rather than cron: it runs with Arivu closed and fires a **missed** `StartCalendarInterval` on
wake — a laptop is rarely awake at 07:00 and cron would simply skip the day. Logs go to
`~/Library/Application Support/arivu/logs/model-catalog.log`. The plist is generated (not committed)
because it must embed absolute paths to this machine's `node` and `dist/cli.js`; install fails loudly
if the build is missing, since a stale path would fail silently every morning.

## How the agent uses it

`resolveContextWindowTokens(config, {model, baseUrl}, catalog)` resolves the window for the model
actually in use, then `Agent` budgets **90%** of it, always reserving ≥1,024 tokens for the reply:

```
budget = max(2_000, min(floor(window * 0.9), window - 1_024))
```

| window | budget | % | reply headroom |
|---|---|---|---|
| 4,096 | 3,072 | 75% | 1,024 |
| 127,984 | 115,185 | 90% | 12,799 |
| 524,288 | 471,859 | 90% | 52,429 |

The reserve is a **clamp, not a floor**. (The previous `max(4_000, …)` floor gave a 4,096-token model
a 4,000-token budget — 97.6% of its window, ~96 tokens to answer with.)

Tool JSON-Schemas are charged against the budget too. They ride on every request but aren't part of
`messages`, so the estimate never saw them; the old 40% headroom hid that, a 90% budget would not.

**A hand-entered `contextWindowTokens` acts only as a cap** — `min(catalog, config)`. It can lower the
budget as a cost/latency guardrail, never raise it above what the endpoint physically accepts.

**Degradation:** no catalog entry → no window → the existing conservative 48k default. Identical to
pre-catalog behavior, so a missing, corrupt, or oversized catalog is never fatal.

## Concurrency

The scheduled CLI is the only writer, except `recordContextFromRuntime`, which latches a window the
provider itself just reported. The app otherwise only reads. If that ever changes, this needs a
lockfile.
