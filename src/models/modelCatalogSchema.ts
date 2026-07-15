import { z } from "zod";

/**
 * Shape of the per-model catalog maintained by `arivu models sync` (see src/models/syncModelCatalog.ts).
 *
 * Why this exists: a model's context window is a per-MODEL fact, but config only carries a
 * per-provider, hand-entered `contextWindowTokens`. The provider's own /v1/models endpoint returns no
 * context metadata, so the only source is probing — and probed facts don't belong in config.json
 * (the provider normalizer drops unknown keys, and config is user-owned and holds secrets).
 */

/**
 * `not_entitled` is first-class on purpose: a provider's /v1/models list is a catalog, not an
 * entitlement list — most listed models 404 with "Not found for account" when actually called.
 */
export const ModelStatusSchema = z.enum(["available", "not_entitled", "busy", "rate_limited", "unknown", "error"]);

export const ModelContextSchema = z.object({
  tokens: z.number().int().min(1).max(10_000_000),
  source: z.enum(["probe_max_tokens", "probe_oversized", "runtime_error", "manual"]),
  observedAt: z.string()
});

export const CatalogModelSchema = z.object({
  id: z.string().min(1),
  status: ModelStatusSchema,
  statusDetail: z.string().max(500).optional(),
  statusCheckedAt: z.string(),
  /** Absent means "not known yet" — callers must degrade, never guess a window from the model name. */
  context: ModelContextSchema.optional(),
  contextProbe: z
    .object({
      attempts: z.number().int().min(0).default(0),
      lastAttemptAt: z.string().optional(),
      lastError: z.string().max(300).optional()
    })
    .optional(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  /** Tombstone. Set when the model disappears from the provider list; keeps removal detection idempotent. */
  removedAt: z.string().optional()
});

export const CatalogProviderSchema = z.object({
  baseUrl: z.string(),
  /** Display only — the record is keyed by normalized baseUrl, not by these ids. */
  providerIds: z.array(z.string()).default([]),
  lastFullSyncAt: z.string().optional(),
  lastActiveSweepAt: z.string().optional(),
  /** Keyed by model id for O(1) lookup on the agent's hot path. */
  models: z.record(z.string(), CatalogModelSchema).default({})
});

export const ModelCatalogSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  /** Keyed by normalizeCapabilityBaseUrl(baseUrl). */
  providers: z.record(z.string(), CatalogProviderSchema).default({})
});

export const CatalogEventSchema = z.union([
  z.object({ at: z.string(), type: z.literal("model_added"), baseUrl: z.string(), model: z.string() }),
  z.object({ at: z.string(), type: z.literal("model_removed"), baseUrl: z.string(), model: z.string() }),
  z.object({
    at: z.string(),
    type: z.literal("status_changed"),
    baseUrl: z.string(),
    model: z.string(),
    from: ModelStatusSchema,
    to: ModelStatusSchema
  }),
  z.object({
    at: z.string(),
    type: z.literal("context_resolved"),
    baseUrl: z.string(),
    model: z.string(),
    tokens: z.number().int(),
    source: z.string()
  }),
  z.object({
    at: z.string(),
    type: z.literal("context_changed"),
    baseUrl: z.string(),
    model: z.string(),
    from: z.number().int(),
    to: z.number().int(),
    source: z.string()
  })
]);

export type ModelStatus = z.infer<typeof ModelStatusSchema>;
export type ModelContextFact = z.infer<typeof ModelContextSchema>;
export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export type CatalogProvider = z.infer<typeof CatalogProviderSchema>;
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;
export type CatalogEvent = z.infer<typeof CatalogEventSchema>;

export const CATALOG_VERSION = 1 as const;

export function emptyCatalog(now: Date = new Date()): ModelCatalog {
  return { version: CATALOG_VERSION, updatedAt: now.toISOString(), providers: {} };
}
