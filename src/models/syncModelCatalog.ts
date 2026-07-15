import { normalizeCapabilityBaseUrl, resolveModelListEndpoint, type AppConfig } from "../config.js";
import { pruneTombstones, ModelCatalogStore } from "./ModelCatalogStore.js";
import { emptyCatalog, type CatalogEvent, type CatalogModel, type ModelCatalog, type ModelStatus } from "./modelCatalogSchema.js";
import { listProviderModels, probeContextViaMaxTokens, probeStatus, type FetchLike } from "./probe.js";

/**
 * Daily catalog sync (see docs/model-catalog.md). Records each model's status, resolves unknown
 * context windows once, and diffs the provider's list to detect additions/removals.
 *
 * `now` and `fetcher` are injected so the whole job is testable without a clock or a network, the
 * same seam `src/diagnostics/doctor.ts` uses.
 */

export type SyncOptions = {
  fetcher?: FetchLike;
  now?: Date;
  /** Requests per minute. Kept under the provider's observed ~40 RPM ceiling. */
  rpm?: number;
  /** Include the active model even when it isn't Monday. */
  forceActive?: boolean;
  /** Re-probe context even for models that already have a resolved window. */
  reprobe?: boolean;
  /** Cap on context probes per run, so a first run against a huge catalog stays bounded. */
  maxProbes?: number;
  /** Compute the diff and probes but write nothing. */
  dryRun?: boolean;
  providerId?: string;
  store?: ModelCatalogStore;
};

export type SyncSummary = {
  baseUrl: string;
  checkedAt: string;
  includedActiveModel: boolean;
  listed: number;
  /** Why the active model was (or wasn't) swept — the cadence is easy to misread from a bare flag. */
  activeReason: "monday sweep" | "forced" | "skipped";
  added: string[];
  removed: string[];
  statusCounts: Record<ModelStatus, number>;
  contextResolved: Array<{ model: string; tokens: number }>;
  contextUnresolved: number;
  events: CatalogEvent[];
  dryRun: boolean;
};

const DEFAULT_RPM = 30;
const MAX_CONTEXT_PROBE_ATTEMPTS = 3;
const DEFAULT_MAX_PROBES = 150;

/** Monday. Matches the requested cadence: non-active models daily, the active model weekly. */
export function isActiveSweepDay(now: Date): boolean {
  return now.getDay() === 1;
}

export async function runModelCatalogSync(config: AppConfig, options: SyncOptions = {}): Promise<SyncSummary> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? new Date();
  const store = options.store ?? new ModelCatalogStore();
  const rpm = Math.max(1, options.rpm ?? DEFAULT_RPM);
  const throttle = createThrottle(rpm);

  const endpoint = resolveModelListEndpoint(config, { providerId: options.providerId ?? config.activeProviderId });
  if (!endpoint.baseUrl) {
    throw new Error("No provider base URL configured; nothing to sync.");
  }
  const key = normalizeCapabilityBaseUrl(endpoint.baseUrl);
  const nowIso = now.toISOString();

  const catalog = structuredClone(await store.load());
  if (catalog.version !== 1) {
    Object.assign(catalog, emptyCatalog(now));
  }
  const provider = catalog.providers[key] ?? { baseUrl: endpoint.baseUrl, providerIds: [], models: {} };
  catalog.providers[key] = provider;
  const providerId = options.providerId ?? config.activeProviderId;
  if (providerId && !provider.providerIds.includes(providerId)) {
    provider.providerIds.push(providerId);
  }

  const events: CatalogEvent[] = [];
  const listed = await listProviderModels(endpoint, fetcher);
  const listedSet = new Set(listed);

  // --- Diff: additions and removals (tombstones make this idempotent across runs) ---
  const added: string[] = [];
  for (const id of listed) {
    const existing = provider.models[id];
    if (!existing) {
      provider.models[id] = {
        id,
        status: "unknown",
        statusCheckedAt: nowIso,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso
      };
      added.push(id);
      events.push({ at: nowIso, type: "model_added", baseUrl: endpoint.baseUrl, model: id });
      continue;
    }
    existing.lastSeenAt = nowIso;
    if (existing.removedAt) {
      // Came back after a removal: clear the tombstone and report it as an addition again.
      delete existing.removedAt;
      added.push(id);
      events.push({ at: nowIso, type: "model_added", baseUrl: endpoint.baseUrl, model: id });
    }
  }

  const removed: string[] = [];
  for (const entry of Object.values(provider.models)) {
    if (!listedSet.has(entry.id) && !entry.removedAt) {
      entry.removedAt = nowIso;
      removed.push(entry.id);
      events.push({ at: nowIso, type: "model_removed", baseUrl: endpoint.baseUrl, model: entry.id });
    }
  }

  // --- Choose what to check: non-active daily; active only on Mondays (or --force-active) ---
  const activeModel = config.model;
  const includeActive = options.forceActive === true || isActiveSweepDay(now);
  const targets = listed.filter((id) => includeActive || id !== activeModel);

  const statusCounts = emptyStatusCounts();
  const contextResolved: Array<{ model: string; tokens: number }> = [];
  let contextUnresolved = 0;
  let probeBudget = options.maxProbes ?? DEFAULT_MAX_PROBES;

  for (const id of targets) {
    const entry = provider.models[id];
    if (!entry) {
      continue;
    }

    await throttle();
    const status = await probeStatus({ baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, model: id }, fetcher);
    if (entry.status !== status.status) {
      events.push({
        at: nowIso,
        type: "status_changed",
        baseUrl: endpoint.baseUrl,
        model: id,
        from: entry.status,
        to: status.status
      });
    }
    entry.status = status.status;
    entry.statusDetail = status.detail;
    entry.statusCheckedAt = nowIso;
    statusCounts[status.status] += 1;

    if (!shouldProbeContext(entry, options.reprobe === true) || probeBudget <= 0 || !canProbeContext(status.status)) {
      continue;
    }

    probeBudget -= 1;
    await throttle();
    const probe = await probeContextViaMaxTokens({ baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, model: id }, fetcher);
    const attempts = (entry.contextProbe?.attempts ?? 0) + 1;
    if (probe.tokens && probe.source) {
      const previous = entry.context?.tokens;
      entry.context = { tokens: probe.tokens, source: probe.source, observedAt: nowIso };
      entry.contextProbe = { attempts, lastAttemptAt: nowIso };
      contextResolved.push({ model: id, tokens: probe.tokens });
      events.push(
        previous === undefined
          ? { at: nowIso, type: "context_resolved", baseUrl: endpoint.baseUrl, model: id, tokens: probe.tokens, source: probe.source }
          : {
              at: nowIso,
              type: "context_changed",
              baseUrl: endpoint.baseUrl,
              model: id,
              from: previous,
              to: probe.tokens,
              source: probe.source
            }
      );
    } else {
      entry.contextProbe = { attempts, lastAttemptAt: nowIso, lastError: probe.error?.slice(0, 300) };
      contextUnresolved += 1;
    }
  }

  provider.lastFullSyncAt = nowIso;
  if (includeActive) {
    provider.lastActiveSweepAt = nowIso;
  }
  catalog.updatedAt = nowIso;

  if (!options.dryRun) {
    await store.save(pruneTombstones(catalog, now));
    await store.appendEvents(events);
  }

  return {
    baseUrl: endpoint.baseUrl,
    checkedAt: nowIso,
    includedActiveModel: includeActive,
    activeReason: !includeActive ? "skipped" : isActiveSweepDay(now) ? "monday sweep" : "forced",
    listed: listed.length,
    added,
    removed,
    statusCounts,
    contextResolved,
    contextUnresolved,
    events,
    dryRun: options.dryRun === true
  };
}

/**
 * A timeout on the status ping is inconclusive, not a verdict. The ping runs real inference, so a
 * large reasoning model (e.g. seed-oss-36b, which has a thinking budget) can blow the deadline while
 * being perfectly reachable. The context probe is rejected at validation *before* any generation, so
 * it routinely succeeds where the ping timed out — and the active model is exactly the one whose
 * window we most need. `not_entitled` / `busy` / `rate_limited` are real verdicts and skip.
 */
function canProbeContext(status: ModelStatus): boolean {
  return status === "available" || status === "unknown";
}

/**
 * Context length is static per model, so it's probed once and cached. Repeated failures are capped
 * so a model with an unparseable error contract isn't retried forever.
 */
function shouldProbeContext(entry: CatalogModel, reprobe: boolean): boolean {
  if (reprobe) {
    return true;
  }
  if (entry.context) {
    return false;
  }
  return (entry.contextProbe?.attempts ?? 0) < MAX_CONTEXT_PROBE_ATTEMPTS;
}

/** Records a context window learned from a live request failure. Costs no extra API calls. */
export async function recordContextFromRuntime(
  store: ModelCatalogStore,
  selection: { baseUrl: string; model: string },
  tokens: number,
  now: Date = new Date()
): Promise<void> {
  const catalog: ModelCatalog = structuredClone(await store.load());
  const key = normalizeCapabilityBaseUrl(selection.baseUrl);
  const nowIso = now.toISOString();
  const provider = catalog.providers[key] ?? { baseUrl: selection.baseUrl, providerIds: [], models: {} };
  catalog.providers[key] = provider;
  const previous = provider.models[selection.model]?.context?.tokens;
  if (previous === tokens) {
    return;
  }
  provider.models[selection.model] = {
    ...(provider.models[selection.model] ?? {
      id: selection.model,
      status: "available",
      statusCheckedAt: nowIso,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso
    }),
    context: { tokens, source: "runtime_error", observedAt: nowIso }
  };
  catalog.updatedAt = nowIso;
  await store.save(catalog);
  await store.appendEvents([
    previous === undefined
      ? { at: nowIso, type: "context_resolved", baseUrl: selection.baseUrl, model: selection.model, tokens, source: "runtime_error" }
      : {
          at: nowIso,
          type: "context_changed",
          baseUrl: selection.baseUrl,
          model: selection.model,
          from: previous,
          to: tokens,
          source: "runtime_error"
        }
  ]);
}

function emptyStatusCounts(): Record<ModelStatus, number> {
  return { available: 0, not_entitled: 0, busy: 0, rate_limited: 0, unknown: 0, error: 0 };
}

/** Simple spacing throttle: keeps the run under the provider's request-rate ceiling. */
function createThrottle(rpm: number) {
  const spacingMs = Math.ceil(60_000 / rpm);
  let last = 0;
  return async () => {
    const wait = last === 0 ? 0 : Math.max(0, spacingMs - (Date.now() - last));
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    last = Date.now();
  };
}
