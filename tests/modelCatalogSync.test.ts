import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { ModelCatalogStore } from "../src/models/ModelCatalogStore.js";
import { isActiveSweepDay, recordContextFact, runModelCatalogSync } from "../src/models/syncModelCatalog.js";
import type { FetchLike } from "../src/models/probe.js";

let tempDir: string;
const BASE_URL = "https://integrate.api.nvidia.com/v1";
const MONDAY = new Date("2026-07-13T07:00:00.000Z");
const TUESDAY = new Date("2026-07-14T07:00:00.000Z");

function config(): AppConfig {
  return {
    apiKey: "test-key",
    baseUrl: BASE_URL,
    model: "active/model",
    toolCalling: "auto",
    imageInput: "auto",
    activeProviderId: "nvidia",
    providers: [
      {
        id: "nvidia",
        name: "NVIDIA",
        baseUrl: BASE_URL,
        model: "active/model",
        toolCalling: "auto",
        imageInput: "auto",
        apiKey: "test-key"
      }
    ],
    trustMode: "ask",
    mcpServers: {},
    workspacePolicies: {},
    workspacePolicyProfiles: {}
  } as AppConfig;
}

/**
 * Builds a fetcher over a declarative model table. `chat` decides what /chat/completions returns for
 * a given model, letting each test describe provider behavior rather than wire up HTTP.
 */
function fetcherFor(models: string[], chat: (model: string, body: Record<string, unknown>) => Response): FetchLike {
  return async (input, init) => {
    if (input.endsWith("/models")) {
      return Response.json({ data: models.map((id) => ({ id })) });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return chat(String(body.model), body);
  };
}

const okChat = () => Response.json({ choices: [{ message: { role: "assistant", content: "hi" } }] });
const contextLimit = (tokens: number) =>
  new Response(
    JSON.stringify({ error: { message: `This model's maximum context length is ${tokens} tokens and your request has 9 input tokens` } }),
    { status: 400 }
  );
const notEntitled = () => new Response(JSON.stringify({ status: 404, detail: "Function 'abc': Not found for account" }), { status: 404 });

/** Oversized max_tokens resolves context; max_tokens:1 is the cheap status ping. */
function chatWithContext(tokens: number) {
  return (_model: string, body: Record<string, unknown>) => (body.max_tokens === 1 ? okChat() : contextLimit(tokens));
}

describe("isActiveSweepDay", () => {
  it("is true only on Monday", () => {
    expect(isActiveSweepDay(MONDAY)).toBe(true);
    expect(isActiveSweepDay(TUESDAY)).toBe(false);
  });
});

describe("runModelCatalogSync", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-sync-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const options = (extra: Record<string, unknown> = {}) => ({
    store: new ModelCatalogStore(tempDir),
    now: TUESDAY,
    rpm: 100_000,
    ...extra
  });

  it("records new models, their status, and their probed context length", async () => {
    const store = new ModelCatalogStore(tempDir);
    const summary = await runModelCatalogSync(config(), {
      ...options({ store }),
      fetcher: fetcherFor(["vendor/small", "vendor/large"], chatWithContext(131_072))
    });

    expect(summary.added.sort()).toEqual(["vendor/large", "vendor/small"]);
    expect(summary.statusCounts.available).toBe(2);
    expect(summary.contextResolved).toHaveLength(2);

    const catalog = await store.load();
    expect(catalog.providers[BASE_URL].models["vendor/small"].context?.tokens).toBe(131_072);
    expect(catalog.providers[BASE_URL].models["vendor/small"].context?.source).toBe("probe_max_tokens");
    expect((await store.readEvents()).some((event) => event.type === "context_resolved")).toBe(true);
  });

  it("does not re-probe context on a second run, and emits no duplicate events", async () => {
    const store = new ModelCatalogStore(tempDir);
    let contextProbes = 0;
    const fetcher = fetcherFor(["vendor/small"], (_model, body) => {
      if (body.max_tokens === 1) {
        return okChat();
      }
      contextProbes += 1;
      return contextLimit(4_096);
    });

    await runModelCatalogSync(config(), { ...options({ store }), fetcher });
    expect(contextProbes).toBe(1);

    const second = await runModelCatalogSync(config(), { ...options({ store }), fetcher });
    // Context is static: probe once, then cache forever.
    expect(contextProbes).toBe(1);
    expect(second.events).toEqual([]);
    expect(second.added).toEqual([]);
  });

  it("tombstones a removed model once and stays idempotent afterwards", async () => {
    const store = new ModelCatalogStore(tempDir);
    await runModelCatalogSync(config(), {
      ...options({ store }),
      fetcher: fetcherFor(["vendor/a", "vendor/b"], chatWithContext(4_096))
    });

    const removal = await runModelCatalogSync(config(), {
      ...options({ store }),
      fetcher: fetcherFor(["vendor/a"], chatWithContext(4_096))
    });
    expect(removal.removed).toEqual(["vendor/b"]);
    expect((await store.load()).providers[BASE_URL].models["vendor/b"].removedAt).toBeTruthy();

    const again = await runModelCatalogSync(config(), {
      ...options({ store }),
      fetcher: fetcherFor(["vendor/a"], chatWithContext(4_096))
    });
    // The tombstone is what stops a removal being re-reported every morning.
    expect(again.removed).toEqual([]);
    expect(again.events).toEqual([]);
  });

  it("reports a returning model as added again and clears its tombstone", async () => {
    const store = new ModelCatalogStore(tempDir);
    await runModelCatalogSync(config(), { ...options({ store }), fetcher: fetcherFor(["vendor/a"], chatWithContext(4_096)) });
    await runModelCatalogSync(config(), { ...options({ store }), fetcher: fetcherFor([], chatWithContext(4_096)) });

    const back = await runModelCatalogSync(config(), {
      ...options({ store }),
      fetcher: fetcherFor(["vendor/a"], chatWithContext(4_096))
    });
    expect(back.added).toEqual(["vendor/a"]);
    expect((await store.load()).providers[BASE_URL].models["vendor/a"].removedAt).toBeUndefined();
  });

  it("skips the active model on a normal day and sweeps it on Monday", async () => {
    const store = new ModelCatalogStore(tempDir);
    const probed: string[] = [];
    const fetcher = fetcherFor(["active/model", "vendor/other"], (model, body) => {
      if (body.max_tokens === 1) {
        probed.push(model);
      }
      return body.max_tokens === 1 ? okChat() : contextLimit(4_096);
    });

    const tuesday = await runModelCatalogSync(config(), { ...options({ store }), now: TUESDAY, fetcher });
    expect(tuesday.includedActiveModel).toBe(false);
    expect(probed).toEqual(["vendor/other"]);

    probed.length = 0;
    const monday = await runModelCatalogSync(config(), { ...options({ store }), now: MONDAY, fetcher });
    expect(monday.includedActiveModel).toBe(true);
    expect(probed.sort()).toEqual(["active/model", "vendor/other"]);
  });

  it("includes the active model on any day with forceActive", async () => {
    const summary = await runModelCatalogSync(config(), {
      ...options({ now: TUESDAY, forceActive: true }),
      fetcher: fetcherFor(["active/model"], chatWithContext(4_096))
    });
    expect(summary.includedActiveModel).toBe(true);
    expect(summary.statusCounts.available).toBe(1);
  });

  it("classifies a listed-but-unentitled model and does not probe its context", async () => {
    const store = new ModelCatalogStore(tempDir);
    let contextProbes = 0;
    const summary = await runModelCatalogSync(config(), {
      ...options({ store }),
      fetcher: fetcherFor(["vendor/locked"], (_model, body) => {
        if (body.max_tokens !== 1) {
          contextProbes += 1;
        }
        return notEntitled();
      })
    });

    // /v1/models is a catalog, not an entitlement list — most listed models 404 for a given account.
    expect(summary.statusCounts.not_entitled).toBe(1);
    expect(contextProbes).toBe(0);
    expect((await store.load()).providers[BASE_URL].models["vendor/locked"].context).toBeUndefined();
  });

  it("classifies busy and rate-limited responses distinctly", async () => {
    const summary = await runModelCatalogSync(config(), {
      ...options(),
      fetcher: fetcherFor(["vendor/busy", "vendor/limited"], (model) =>
        model === "vendor/busy"
          ? new Response("ResourceExhausted: All workers are busy, please retry later", { status: 503 })
          : new Response("Too Many Requests", { status: 429 })
      )
    });
    expect(summary.statusCounts.busy).toBe(1);
    expect(summary.statusCounts.rate_limited).toBe(1);
  });

  it("emits a status_changed event when a model's status flips", async () => {
    const store = new ModelCatalogStore(tempDir);
    await runModelCatalogSync(config(), { ...options({ store }), fetcher: fetcherFor(["vendor/a"], chatWithContext(4_096)) });

    const flipped = await runModelCatalogSync(config(), {
      ...options({ store }),
      fetcher: fetcherFor(["vendor/a"], () => notEntitled())
    });
    expect(flipped.events).toContainEqual(
      expect.objectContaining({ type: "status_changed", model: "vendor/a", from: "available", to: "not_entitled" })
    );
  });

  it("leaves context unresolved when the model ignores the probe, without guessing", async () => {
    const store = new ModelCatalogStore(tempDir);
    const summary = await runModelCatalogSync(config(), {
      ...options({ store }),
      // Mirrors llama-3.1-8b / glm-5.2, which silently accept an absurd max_tokens.
      fetcher: fetcherFor(["vendor/permissive"], () => okChat())
    });

    expect(summary.contextUnresolved).toBe(1);
    const entry = (await store.load()).providers[BASE_URL].models["vendor/permissive"];
    expect(entry.context).toBeUndefined();
    expect(entry.contextProbe?.attempts).toBe(1);
  });

  it("still resolves context when the status ping times out", async () => {
    const store = new ModelCatalogStore(tempDir);
    // Real behavior of the active model (seed-oss-36b): the status ping runs inference and can time
    // out, while the context probe is rejected at validation and answers immediately. A timeout must
    // not be treated as a verdict, or the one model whose window we actually need stays unknown.
    const summary = await runModelCatalogSync(config(), {
      ...options({ store }),
      fetcher: fetcherFor(["vendor/slow"], (_model, body) => {
        if (body.max_tokens === 1) {
          throw new Error("The operation was aborted due to timeout");
        }
        return contextLimit(524_288);
      })
    });

    expect(summary.statusCounts.unknown).toBe(1);
    expect(summary.contextResolved).toEqual([{ model: "vendor/slow", tokens: 524_288 }]);
    expect((await store.load()).providers[BASE_URL].models["vendor/slow"].context?.tokens).toBe(524_288);
  });

  it("does not probe context for models with a definitive negative verdict", async () => {
    let contextProbes = 0;
    await runModelCatalogSync(config(), {
      ...options(),
      fetcher: fetcherFor(["vendor/busy"], (_model, body) => {
        if (body.max_tokens !== 1) {
          contextProbes += 1;
        }
        return new Response("ResourceExhausted: All workers are busy", { status: 503 });
      })
    });
    expect(contextProbes).toBe(0);
  });

  it("writes nothing on a dry run", async () => {
    const store = new ModelCatalogStore(tempDir);
    const summary = await runModelCatalogSync(config(), {
      ...options({ store, dryRun: true }),
      fetcher: fetcherFor(["vendor/a"], chatWithContext(4_096))
    });

    expect(summary.added).toEqual(["vendor/a"]);
    expect(summary.dryRun).toBe(true);
    expect((await store.load()).providers).toEqual({});
  });
});

describe("recordContextFact", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-sync-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists a manual probe result with its source and emits an event", async () => {
    const store = new ModelCatalogStore(tempDir);
    const selection = { baseUrl: BASE_URL, model: "vendor/permissive" };
    await recordContextFact(store, selection, { tokens: 196_608, source: "probe_oversized" }, TUESDAY);

    const entry = (await store.load()).providers[BASE_URL].models["vendor/permissive"];
    expect(entry.context).toEqual({ tokens: 196_608, source: "probe_oversized", observedAt: TUESDAY.toISOString() });
    expect(await store.readEvents()).toContainEqual(
      expect.objectContaining({ type: "context_resolved", model: "vendor/permissive", tokens: 196_608, source: "probe_oversized" })
    );
  });

  it("records a change event when a probe corrects an earlier window", async () => {
    const store = new ModelCatalogStore(tempDir);
    const selection = { baseUrl: BASE_URL, model: "vendor/permissive" };
    await recordContextFact(store, selection, { tokens: 131_072, source: "probe_max_tokens" }, MONDAY);
    await recordContextFact(store, selection, { tokens: 196_608, source: "probe_oversized" }, TUESDAY);

    expect((await store.load()).providers[BASE_URL].models["vendor/permissive"].context?.tokens).toBe(196_608);
    expect(await store.readEvents()).toContainEqual(
      expect.objectContaining({ type: "context_changed", from: 131_072, to: 196_608, source: "probe_oversized" })
    );
  });
});
