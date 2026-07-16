import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { ModelCatalogStore, pruneTombstones, TOMBSTONE_RETENTION_MS } from "../src/models/ModelCatalogStore.js";
import { parseContextLimit } from "../src/models/contextLimitParser.js";
import { resolveContextWindowTokens } from "../src/models/contextResolver.js";
import { emptyCatalog, type ModelCatalog } from "../src/models/modelCatalogSchema.js";

let tempDir: string;

function catalogWith(models: ModelCatalog["providers"][string]["models"]): ModelCatalog {
  return {
    version: 1,
    updatedAt: "2026-07-16T00:00:00.000Z",
    providers: {
      "https://integrate.api.nvidia.com/v1": {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        providerIds: ["nvidia"],
        models
      }
    }
  };
}

function configWith(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "bytedance/seed-oss-36b-instruct",
    toolCalling: "auto",
    imageInput: "auto",
    providers: [],
    trustMode: "ask",
    mcpServers: {},
    workspacePolicies: {},
    workspacePolicyProfiles: {},
    ...overrides
  } as AppConfig;
}

describe("model catalog store", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-catalog-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("round-trips a catalog and leaves no temp files behind", async () => {
    const store = new ModelCatalogStore(tempDir);
    const catalog = catalogWith({
      "bytedance/seed-oss-36b-instruct": {
        id: "bytedance/seed-oss-36b-instruct",
        status: "available",
        statusCheckedAt: "2026-07-16T00:00:00.000Z",
        context: { tokens: 524_288, source: "probe_max_tokens", observedAt: "2026-07-16T00:00:00.000Z" },
        firstSeenAt: "2026-07-16T00:00:00.000Z",
        lastSeenAt: "2026-07-16T00:00:00.000Z"
      }
    });

    await store.save(catalog);
    const loaded = await store.load();

    expect(loaded.providers["https://integrate.api.nvidia.com/v1"].models["bytedance/seed-oss-36b-instruct"].context?.tokens).toBe(524_288);
    expect((await readdir(tempDir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect((await stat(store.catalogPath)).mode & 0o777).toBe(0o600);
  });

  it("returns an empty catalog instead of throwing when the file is corrupt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new ModelCatalogStore(tempDir);
    await store.save(emptyCatalog());
    await writeFile(store.catalogPath, "{ not json", "utf8");

    // This runs on the agent's construction path: it must degrade, never throw.
    await expect(store.load()).resolves.toEqual(expect.objectContaining({ version: 1, providers: {} }));
    expect(warn).toHaveBeenCalled();
  });

  it("returns an empty catalog when the stored shape fails the schema", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new ModelCatalogStore(tempDir);
    await store.save(emptyCatalog());
    await writeFile(store.catalogPath, JSON.stringify({ version: 99, providers: {} }), "utf8");

    await expect(store.load()).resolves.toEqual(expect.objectContaining({ providers: {} }));
  });

  it("appends and reads change events newest-first", async () => {
    const store = new ModelCatalogStore(tempDir);
    await store.appendEvents([
      { at: "2026-07-16T00:00:00.000Z", type: "model_added", baseUrl: "https://x/v1", model: "a" },
      { at: "2026-07-16T00:00:01.000Z", type: "model_removed", baseUrl: "https://x/v1", model: "b" }
    ]);

    const events = await store.readEvents();
    expect(events.map((event) => event.type)).toEqual(["model_removed", "model_added"]);
  });

  it("prunes tombstones past the retention window but keeps live and recent ones", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const old = new Date(now.getTime() - TOMBSTONE_RETENTION_MS - 1_000).toISOString();
    const recent = new Date(now.getTime() - 1_000).toISOString();
    const catalog = catalogWith({
      live: { id: "live", status: "available", statusCheckedAt: recent, firstSeenAt: recent, lastSeenAt: recent },
      recentlyRemoved: {
        id: "recentlyRemoved",
        status: "unknown",
        statusCheckedAt: recent,
        firstSeenAt: recent,
        lastSeenAt: recent,
        removedAt: recent
      },
      longGone: { id: "longGone", status: "unknown", statusCheckedAt: old, firstSeenAt: old, lastSeenAt: old, removedAt: old }
    });

    const pruned = pruneTombstones(catalog, now);
    const ids = Object.keys(pruned.providers["https://integrate.api.nvidia.com/v1"].models);
    expect(ids.sort()).toEqual(["live", "recentlyRemoved"]);
  });
});

describe("parseContextLimit", () => {
  // These are the verbatim error contracts captured from the live NVIDIA NIM endpoint. They are the
  // spec: providers agree on neither wording nor status code.
  it.each([
    ["This model's maximum context length is 524288 tokens and your request has 9 input tokens (99999999 > 524288 - 9).", 524_288],
    ['{"error":"body -> max_tokens\\n  Input should be less than or equal to 4096 (type=less_than_equal; le=4096)"}', 4_096],
    ["Input value error: prompt is [[440009]] long while only 4096 is supported", 4_096],
    ["This model's maximum context length is 131072 tokens. However, your messages resulted in 440035 tokens.", 131_072],
    [
      "Requested token count exceeds the model's maximum context length of 131072 tokens. You requested a total of 100000010 tokens.",
      131_072
    ],
    // SGLang emits this both with and without the space before "cannot" — both seen live on NIM.
    ['{"error":{"message":"max_tokens=99999999cannot be greater than max_model_len=max_total_tokens=128000. Please request fewer output tokens."}}', 128_000],
    ['{"error":{"message":"max_tokens=99999999 cannot be greater than max_model_len=max_total_tokens=262144. Please request fewer output tokens."}}', 262_144]
  ])("extracts the limit from %j", (body, expected) => {
    expect(parseContextLimit(body)).toBe(expected);
  });

  it("returns undefined rather than guessing on an unknown contract", () => {
    // gpt-oss reports "max_tokens must be at least 1, got -308994" — back-solvable only with a
    // calibration pair, so a single sample must leave the window unknown.
    expect(parseContextLimit("max_tokens must be at least 1, got -308994.")).toBeUndefined();
    expect(parseContextLimit("Too Many Requests")).toBeUndefined();
  });
});

describe("resolveContextWindowTokens", () => {
  const selection = { model: "bytedance/seed-oss-36b-instruct", baseUrl: "https://integrate.api.nvidia.com/v1" };
  const catalog = catalogWith({
    "bytedance/seed-oss-36b-instruct": {
      id: "bytedance/seed-oss-36b-instruct",
      status: "available",
      statusCheckedAt: "2026-07-16T00:00:00.000Z",
      context: { tokens: 524_288, source: "probe_max_tokens", observedAt: "2026-07-16T00:00:00.000Z" },
      firstSeenAt: "2026-07-16T00:00:00.000Z",
      lastSeenAt: "2026-07-16T00:00:00.000Z"
    }
  });

  it("uses the measured per-model window from the catalog", () => {
    expect(resolveContextWindowTokens(configWith(), selection, catalog)).toBe(524_288);
  });

  it("uses published native windows for MiniMax M2.7 and Nemotron 3 Nano", () => {
    const empty = catalogWith({});
    expect(resolveContextWindowTokens(configWith(), { ...selection, model: "minimaxai/minimax-m2.7" }, empty)).toBe(204_800);
    expect(resolveContextWindowTokens(configWith(), { ...selection, model: "nvidia/nemotron-3-nano-30b-a3b" }, empty)).toBe(1_000_000);
  });

  it("does not let an inconclusive probe replace a published native window", () => {
    const probed = catalogWith({
      "minimaxai/minimax-m2.7": {
        id: "minimaxai/minimax-m2.7",
        status: "available",
        statusCheckedAt: "2026-07-16T00:00:00.000Z",
        context: { tokens: 196_608, source: "probe_oversized", observedAt: "2026-07-16T00:00:00.000Z" },
        firstSeenAt: "2026-07-16T00:00:00.000Z",
        lastSeenAt: "2026-07-16T00:00:00.000Z"
      }
    });
    expect(resolveContextWindowTokens(configWith(), { ...selection, model: "minimaxai/minimax-m2.7" }, probed)).toBe(204_800);
  });

  it("honors a smaller endpoint limit learned from a real request rejection", () => {
    const runtimeLimited = catalogWith({
      "nvidia/nemotron-3-nano-30b-a3b": {
        id: "nvidia/nemotron-3-nano-30b-a3b",
        status: "available",
        statusCheckedAt: "2026-07-16T00:00:00.000Z",
        context: { tokens: 262_144, source: "runtime_error", observedAt: "2026-07-16T00:00:00.000Z" },
        firstSeenAt: "2026-07-16T00:00:00.000Z",
        lastSeenAt: "2026-07-16T00:00:00.000Z"
      }
    });
    expect(resolveContextWindowTokens(configWith(), { ...selection, model: "nvidia/nemotron-3-nano-30b-a3b" }, runtimeLimited)).toBe(
      262_144
    );
  });

  it("matches the endpoint regardless of trailing slash or case", () => {
    const messy = { ...selection, baseUrl: "HTTPS://Integrate.API.NVIDIA.com/v1/" };
    expect(resolveContextWindowTokens(configWith(), messy, catalog)).toBe(524_288);
  });

  it("lets a hand-entered provider value LOWER the budget but never raise it", () => {
    const capped = configWith({
      providers: [
        {
          id: "nvidia",
          name: "NVIDIA",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          model: "bytedance/seed-oss-36b-instruct",
          toolCalling: "auto",
          imageInput: "auto",
          contextWindowTokens: 128_000
        }
      ]
    });
    expect(resolveContextWindowTokens(capped, selection, catalog)).toBe(128_000);

    const inflated = configWith({
      providers: [
        {
          id: "nvidia",
          name: "NVIDIA",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          model: "bytedance/seed-oss-36b-instruct",
          toolCalling: "auto",
          imageInput: "auto",
          contextWindowTokens: 2_000_000
        }
      ]
    });
    // The user cannot claim more window than the endpoint physically accepts.
    expect(resolveContextWindowTokens(inflated, selection, catalog)).toBe(524_288);
  });

  it("returns undefined for a model the catalog has never seen, so the caller degrades", () => {
    expect(resolveContextWindowTokens(configWith(), { ...selection, model: "unknown/model" }, catalog)).toBeUndefined();
  });

  it("falls back to the per-provider value when the catalog has no entry", () => {
    const config = configWith({
      providers: [
        {
          id: "nvidia",
          name: "NVIDIA",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          model: "unknown/model",
          toolCalling: "auto",
          imageInput: "auto",
          contextWindowTokens: 32_000
        }
      ]
    });
    expect(resolveContextWindowTokens(config, { ...selection, model: "unknown/model" }, catalog)).toBe(32_000);
  });
});
