import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import type { WebContents } from "electron";
import {
  ensureBrowserTaskProxy,
  getBrowserTaskProxyDiagnostics,
  registerBrowserTaskProxyEntry,
  unregisterBrowserTaskProxyEntry
} from "../desktop/main/browserTaskProxy.js";
import { __setPageAgentBundleTextForTests, circuitFailureFromDiagnostics, runBrowserTask } from "../desktop/main/browserTaskSupervisor.js";

const REAL_API_KEY = "sk-super-secret-real-key";

// browserTaskSupervisor resolves the real bundle relative to the built main.js output, which
// only exists after `desktop:main:build`. These tests run against unbundled TS source, so we
// preload a stand-in bundle instead of depending on that build step.
__setPageAgentBundleTextForTests("window.__ArivuPageAgentLib = { PageAgentCore: null, PageController: null };");

describe("browserTaskProxy", () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  let receivedAuthHeaders: (string | undefined)[] = [];
  let receivedHeaders: http.IncomingHttpHeaders[] = [];

  async function ensureUpstream() {
    if (upstream) {
      return;
    }
    upstream = http.createServer((req, res) => {
      receivedAuthHeaders.push(req.headers.authorization);
      receivedHeaders.push(req.headers);
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "https://provider.example" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${address.port}`;
  }

  afterAll(() => {
    upstream?.close();
  });

  it("swaps a per-task token for the real key before forwarding upstream", async () => {
    await ensureUpstream();
    receivedAuthHeaders = [];
    const { token, proxyBaseUrl } = await registerBrowserTaskProxyEntry({
      realBaseUrl: upstreamUrl,
      realApiKey: REAL_API_KEY,
      ttlMs: 30_000
    });

    const response = await fetch(`${proxyBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" })
    });
    expect(response.status).toBe(200);
    expect(receivedAuthHeaders).toEqual([`Bearer ${REAL_API_KEY}`]);
    expect(getBrowserTaskProxyDiagnostics(token)).toMatchObject([
      { attempt: 1, method: "POST", path: "/v1/chat/completions", status: 200, outcome: "success" }
    ]);

    unregisterBrowserTaskProxyEntry(token);
  });

  it("rejects requests with an invalid or revoked token", async () => {
    await ensureUpstream();
    const { port } = await ensureBrowserTaskProxy();
    const badResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token" }
    });
    expect(badResponse.status).toBe(401);

    const { token, proxyBaseUrl } = await registerBrowserTaskProxyEntry({
      realBaseUrl: upstreamUrl,
      realApiKey: REAL_API_KEY,
      ttlMs: 30_000
    });
    unregisterBrowserTaskProxyEntry(token);
    const revokedResponse = await fetch(`${proxyBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(revokedResponse.status).toBe(401);
  });

  it("answers OPTIONS preflights with CORS approval without requiring a token", async () => {
    const { port } = await ensureBrowserTaskProxy();
    const response = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
      method: "OPTIONS",
      headers: {
        origin: "https://dev425223.service-now.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
        "access-control-request-private-network": "true"
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://dev425223.service-now.com");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toBe("authorization,content-type");
    expect(response.headers.get("access-control-allow-private-network")).toBe("true");
    expect(response.headers.get("access-control-max-age")).toBeTruthy();
  });

  it("retries upstream 429s with backoff before surfacing them to the page", async () => {
    let hits = 0;
    const flaky = http.createServer((req, res) => {
      req.resume();
      hits += 1;
      if (hits < 3) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ status: 429, title: "Too Many Requests" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", resolve));
    const flakyUrl = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`;
    try {
      const { token, proxyBaseUrl } = await registerBrowserTaskProxyEntry({
        realBaseUrl: flakyUrl,
        realApiKey: REAL_API_KEY,
        ttlMs: 30_000
      });
      const response = await fetch(`${proxyBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" })
      });
      expect(response.status).toBe(200);
      expect(hits).toBe(3);
      // In-flight retries are flagged so endpoint-health consumers (the model circuit) skip them.
      expect(getBrowserTaskProxyDiagnostics(token)).toMatchObject([
        { status: 429, outcome: "upstream_error", willRetry: true },
        { status: 429, outcome: "upstream_error", willRetry: true },
        { status: 200, outcome: "success" }
      ]);
      unregisterBrowserTaskProxyEntry(token);
    } finally {
      flaky.close();
    }
  });

  it("retries transient gateway failures before surfacing them to the page", async () => {
    let hits = 0;
    const flaky = http.createServer((req, res) => {
      req.resume();
      hits += 1;
      if (hits < 3) {
        res.writeHead(hits === 1 ? 502 : 504, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ error: "temporary gateway failure" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", resolve));
    const flakyUrl = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`;
    try {
      const { token, proxyBaseUrl } = await registerBrowserTaskProxyEntry({
        realBaseUrl: flakyUrl,
        realApiKey: REAL_API_KEY,
        ttlMs: 30_000
      });
      const response = await fetch(`${proxyBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" })
      });
      expect(response.status).toBe(200);
      expect(hits).toBe(3);
      expect(getBrowserTaskProxyDiagnostics(token)).toMatchObject([
        { status: 502, willRetry: true },
        { status: 504, willRetry: true },
        { status: 200, outcome: "success" }
      ]);
      unregisterBrowserTaskProxyEntry(token);
    } finally {
      flaky.close();
    }
  });

  it("strips parameters a gateway rejects as unsupported and retries the request without them", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const picky = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        bodies.push(body);
        if ("thinking" in body) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: 400, title: "Validation", detail: "Unsupported parameter(s): `thinking`" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => picky.listen(0, "127.0.0.1", resolve));
    const pickyUrl = `http://127.0.0.1:${(picky.address() as AddressInfo).port}`;
    try {
      const { token, proxyBaseUrl } = await registerBrowserTaskProxyEntry({
        realBaseUrl: pickyUrl,
        realApiKey: REAL_API_KEY,
        ttlMs: 30_000
      });
      const response = await fetch(`${proxyBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", thinking: { type: "disabled" }, messages: [] })
      });
      expect(response.status).toBe(200);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toHaveProperty("thinking");
      expect(bodies[1]).not.toHaveProperty("thinking");
      expect(bodies[1]).toHaveProperty("model", "deepseek-v4-flash");
      const cachedResponse = await fetch(`${proxyBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", thinking: { type: "disabled" }, messages: [] })
      });
      expect(cachedResponse.status).toBe(200);
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).not.toHaveProperty("thinking");
      const diagnostics = getBrowserTaskProxyDiagnostics(token);
      expect(diagnostics[0]).toMatchObject({ status: 400, willRetry: true });
      expect(String(diagnostics[0].message)).toMatch(/rejected parameter\(s\) thinking/);
      unregisterBrowserTaskProxyEntry(token);
    } finally {
      picky.close();
    }
  });

  it("passes through unrelated 400s untouched instead of retrying", async () => {
    let hits = 0;
    const strict = http.createServer((req, res) => {
      req.resume();
      hits += 1;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: 400, title: "Validation", detail: "messages must not be empty" }));
    });
    await new Promise<void>((resolve) => strict.listen(0, "127.0.0.1", resolve));
    const strictUrl = `http://127.0.0.1:${(strict.address() as AddressInfo).port}`;
    try {
      const { token, proxyBaseUrl } = await registerBrowserTaskProxyEntry({
        realBaseUrl: strictUrl,
        realApiKey: REAL_API_KEY,
        ttlMs: 30_000
      });
      const response = await fetch(`${proxyBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] })
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ detail: "messages must not be empty" });
      expect(hits).toBe(1);
      unregisterBrowserTaskProxyEntry(token);
    } finally {
      strict.close();
    }
  });

  it("gives up on a persistent 429 after the retry budget and returns the rate-limit response", async () => {
    let hits = 0;
    const limited = http.createServer((req, res) => {
      req.resume();
      hits += 1;
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ status: 429, title: "Too Many Requests" }));
    });
    await new Promise<void>((resolve) => limited.listen(0, "127.0.0.1", resolve));
    const limitedUrl = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
    try {
      const { token, proxyBaseUrl } = await registerBrowserTaskProxyEntry({
        realBaseUrl: limitedUrl,
        realApiKey: REAL_API_KEY,
        ttlMs: 30_000
      });
      const response = await fetch(`${proxyBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" })
      });
      expect(response.status).toBe(429);
      // Initial attempt + 3 retries.
      expect(hits).toBe(4);
      unregisterBrowserTaskProxyEntry(token);
    } finally {
      limited.close();
    }
  });

  it("adds CORS headers to proxied and error responses so page-context fetches can read them", async () => {
    await ensureUpstream();
    receivedHeaders = [];
    const { token, proxyBaseUrl } = await registerBrowserTaskProxyEntry({
      realBaseUrl: upstreamUrl,
      realApiKey: REAL_API_KEY,
      ttlMs: 30_000
    });

    const okResponse = await fetch(`${proxyBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: "https://dev425223.service-now.com",
        referer: "https://dev425223.service-now.com/some/page",
        "sec-fetch-mode": "cors"
      },
      body: JSON.stringify({ hello: "world" })
    });
    expect(okResponse.status).toBe(200);
    // Our reflected origin must win over the upstream provider's own ACAO value.
    expect(okResponse.headers.get("access-control-allow-origin")).toBe("https://dev425223.service-now.com");
    // Browser-context headers must not leak upstream: the forwarded call is server-to-server.
    // (Node's own fetch stamps a fresh sec-fetch-mode on the outbound request, so only the
    // page-identifying headers are assertable here.)
    expect(receivedHeaders[0]?.origin).toBeUndefined();
    expect(receivedHeaders[0]?.referer).toBeUndefined();

    unregisterBrowserTaskProxyEntry(token);

    const unauthorizedResponse = await fetch(`${proxyBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "https://dev425223.service-now.com" }
    });
    expect(unauthorizedResponse.status).toBe(401);
    expect(unauthorizedResponse.headers.get("access-control-allow-origin")).toBe("https://dev425223.service-now.com");
  });
});

describe("circuitFailureFromDiagnostics", () => {
  const base = { attempt: 1, timestamp: "2026-07-11T00:00:00.000Z", method: "POST", path: "/chat/completions", latencyMs: 100 };

  it("does not open the circuit for 429s the proxy is still retrying", () => {
    const diagnostics = [
      { ...base, status: 429, outcome: "upstream_error" as const, willRetry: true },
      { ...base, status: 429, outcome: "upstream_error" as const, willRetry: true },
      { ...base, status: 429, outcome: "upstream_error" as const, willRetry: true }
    ];
    expect(circuitFailureFromDiagnostics(diagnostics)).toBeUndefined();
  });

  it("still opens the circuit for terminal consecutive transient failures", () => {
    const diagnostics = [
      { ...base, status: 429, outcome: "upstream_error" as const },
      { ...base, status: 503, outcome: "upstream_error" as const },
      { ...base, status: 429, outcome: "upstream_error" as const }
    ];
    expect(circuitFailureFromDiagnostics(diagnostics)?.reason).toMatch(/3 consecutive attempts/);
  });

  it("skips in-flight retries but counts the terminal failures around them", () => {
    const diagnostics = [
      { ...base, status: 429, outcome: "upstream_error" as const },
      { ...base, status: 429, outcome: "upstream_error" as const, willRetry: true },
      { ...base, status: 429, outcome: "upstream_error" as const },
      { ...base, status: 429, outcome: "upstream_error" as const, willRetry: true },
      { ...base, status: 429, outcome: "upstream_error" as const }
    ];
    expect(circuitFailureFromDiagnostics(diagnostics)?.reason).toMatch(/3 consecutive attempts/);
  });

  it("resets at the most recent success", () => {
    const diagnostics = [
      { ...base, status: 429, outcome: "upstream_error" as const },
      { ...base, status: 429, outcome: "upstream_error" as const },
      { ...base, status: 200, outcome: "success" as const },
      { ...base, status: 429, outcome: "upstream_error" as const }
    ];
    expect(circuitFailureFromDiagnostics(diagnostics)).toBeUndefined();
  });
});

describe("runBrowserTask", () => {
  function createFakeContents(onScript: (script: string) => unknown, progress?: () => unknown) {
    const scripts: string[] = [];
    const navigateListeners = new Set<() => void>();
    const destroyedListeners = new Set<() => void>();
    const popupListeners = new Set<() => void>();
    const contents = {
      getURL: () => "https://example.test/",
      executeJavaScript: async (script: string) => {
        scripts.push(script);
        if (script.includes("window.__arivuPageAgentTask.history")) {
          return progress?.() ?? null;
        }
        return onScript(script);
      },
      on: (event: string, listener: () => void) => {
        if (event === "did-navigate") {
          navigateListeners.add(listener);
        }
        if (event === "destroyed") {
          destroyedListeners.add(listener);
        }
        if (event === "did-create-window") {
          popupListeners.add(listener);
        }
        return contents;
      },
      once: (event: string, listener: () => void) => {
        if (event === "destroyed") {
          destroyedListeners.add(listener);
        }
        return contents;
      },
      off: (event: string, listener: () => void) => {
        if (event === "did-navigate") {
          navigateListeners.delete(listener);
        }
        if (event === "destroyed") {
          destroyedListeners.delete(listener);
        }
        if (event === "did-create-window") {
          popupListeners.delete(listener);
        }
        return contents;
      }
    } as unknown as WebContents;
    const fireNavigate = () => {
      for (const listener of navigateListeners) {
        listener();
      }
    };
    const fireDestroyed = () => {
      for (const listener of [...destroyedListeners]) {
        destroyedListeners.delete(listener);
        listener();
      }
    };
    const firePopup = () => {
      for (const listener of popupListeners) {
        listener();
      }
    };
    return { contents, scripts, fireNavigate, fireDestroyed, firePopup };
  }

  function mainTaskScriptCount(scripts: string[]) {
    return scripts.filter(
      (script) => !script.includes("typeof window.__arivuPageAgentTask.stop") && !script.includes("__arivuPageAgentTask.history")
    ).length;
  }

  it("never passes the real API key into any injected script", async () => {
    const { contents, scripts } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return false;
      }
      // The real injected script computes stepCount from page-agent's ExecutionResult.history
      // in-page before returning; this fake stands in for that already-transformed result.
      return { ok: true, success: true, data: "Done.", stepCount: 2 };
    });

    const result = await runBrowserTask(
      contents,
      { instruction: "fill out the form" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY, contextWindowTokens: 1_000_000 }
    );

    expect(result.success).toBe(true);
    expect(result.data).toBe("Done.");
    expect(result.stepCount).toBe(2);
    expect(result.browserTaskModel).toMatchObject({
      model: "gpt-4.1",
      endpoint: "https://api.openai.com/v1",
      contextWindowTokens: 1_000_000,
      maxSteps: 100,
      timeoutMs: 4_200_000,
      stepDelayMs: 35_000
    });
    expect(result.proxyDiagnostics).toEqual([]);
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.some((script) => script.includes("maxSteps: 100"))).toBe(true);
    expect(scripts.some((script) => script.includes("stepDelay: 35"))).toBe(true);
    for (const script of scripts) {
      expect(script.includes(REAL_API_KEY)).toBe(false);
    }
  });

  it("opens a model circuit after an unavailable endpoint response and blocks immediate retries", async () => {
    const unavailable = http.createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "model not found" }));
    });
    await new Promise<void>((resolve) => unavailable.listen(0, "127.0.0.1", resolve));
    const address = unavailable.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const first = createFakeContents(async (script) => {
      const baseMatch = script.match(/baseURL: ("[^"]+")/);
      const tokenMatch = script.match(/apiKey: ("[^"]+")/);
      if (!baseMatch || !tokenMatch) {
        return false;
      }
      await fetch(`${JSON.parse(baseMatch[1])}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${JSON.parse(tokenMatch[1])}`, "content-type": "application/json" },
        body: "{}"
      });
      return { ok: false, error: "HTTP 404" };
    });

    try {
      const firstResult = await runBrowserTask(
        first.contents,
        { instruction: "test unavailable model" },
        { baseUrl, model: "missing-model" }
      );
      expect(firstResult).toMatchObject({ success: false, stopped: true, stopReason: "infrastructure" });
      expect(firstResult.proxyDiagnostics).toMatchObject([{ status: 404, outcome: "upstream_error", attempt: 1 }]);

      const second = createFakeContents(() => ({ ok: true, success: true, data: "should not run" }));
      const secondResult = await runBrowserTask(
        second.contents,
        { instruction: "retry unavailable model" },
        { baseUrl, model: "missing-model" }
      );
      expect(secondResult).toMatchObject({ success: false, stopped: true, stopReason: "infrastructure", durationMs: 0 });
      expect(second.scripts).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => unavailable.close(() => resolve()));
    }
  });

  it("stops the task and reports a timeout when the budget is exceeded", async () => {
    const { contents, scripts } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return new Promise(() => undefined);
    });

    const result = await runBrowserTask(
      contents,
      { instruction: "an instruction that never finishes", timeoutMs: 1_000 },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(result.success).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe("timeout");
    expect(scripts.some((script) => script.includes("typeof window.__arivuPageAgentTask.stop"))).toBe(true);
  }, 10_000);

  it("stops the task when the run signal aborts", async () => {
    const controller = new AbortController();
    const { contents } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return new Promise(() => undefined);
    });

    const runPromise = runBrowserTask(
      contents,
      { instruction: "an instruction that never finishes" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY },
      controller.signal
    );
    controller.abort();
    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe("cancelled");
  }, 10_000);

  it("stops immediately when a popup task closes its own browser target", async () => {
    const { contents, fireDestroyed } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return new Promise(() => undefined);
    });

    const runPromise = runBrowserTask(
      contents,
      { instruction: "select the lookup row" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );
    setTimeout(fireDestroyed, 10);
    const result = await runPromise;

    expect(result).toMatchObject({ success: false, stopped: true, stopReason: "target_closed" });
    expect(result.data).toMatch(/expected result of selecting a value in a popup lookup/i);
  }, 10_000);

  it("stops the parent task and returns an agent-target handoff when an action opens a popup", async () => {
    const { contents, scripts, firePopup } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return new Promise(() => undefined);
    });

    const runPromise = runBrowserTask(
      contents,
      { instruction: "open the category lookup" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );
    setTimeout(firePopup, 10);
    const result = await runPromise;

    expect(result).toMatchObject({ success: false, stopped: false, popupOpened: true });
    expect(result.data).toMatch(/agent target tab \(agentTargetTabId in browser_state\)/i);
    expect(result.data).toMatch(/do not repeat the popup-opening action/i);
    expect(scripts.some((script) => script.includes("typeof window.__arivuPageAgentTask.stop"))).toBe(true);
  }, 10_000);

  it("never stacks progress polls while a poll is outstanding against an unresponsive renderer", async () => {
    // Regression: a throttled/backgrounded renderer that stops answering executeJavaScript
    // used to accumulate one queued poll per second for the whole hang (~2,300 over 38
    // minutes), all of which flooded back when the renderer woke. With the in-flight guard,
    // an unanswered poll blocks further polls entirely.
    let pollCount = 0;
    const { contents } = createFakeContents(
      (script) => {
        if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
          return true;
        }
        return new Promise(() => undefined);
      },
      () => {
        pollCount += 1;
        return new Promise(() => undefined);
      }
    );

    const abort = new AbortController();
    const runPromise = runBrowserTask(
      contents,
      { instruction: "count progress polls" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY },
      abort.signal
    );
    // Three poll intervals elapse; without the guard this dispatches three polls.
    await new Promise((resolve) => setTimeout(resolve, 3_400));
    abort.abort();
    await runPromise;

    expect(pollCount).toBe(1);
  }, 15_000);

  it("resumes on a fresh document after a cross-document navigation destroys the context", async () => {
    let attempt = 0;
    const { contents, scripts, fireNavigate } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      attempt += 1;
      if (attempt === 1) {
        fireNavigate();
        throw new Error("Execution context was destroyed.");
      }
      return { ok: true, success: true, data: "Done on page two.", stepCount: 1 };
    });

    const result = await runBrowserTask(
      contents,
      { instruction: "search then open the top result" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(result.success).toBe(true);
    expect(result.data).toBe("Done on page two.");
    expect(result.navigationCount).toBe(1);
    expect(mainTaskScriptCount(scripts)).toBe(2);
  });

  it("resumes when navigation leaves the old executeJavaScript promise pending", async () => {
    let attempt = 0;
    const fake = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      attempt += 1;
      if (attempt === 1) {
        setTimeout(fake.fireNavigate, 0);
        return new Promise(() => undefined);
      }
      return { ok: true, success: true, data: "Resumed without waiting for the old context.", stepCount: 1 };
    });

    const result = await runBrowserTask(
      fake.contents,
      { instruction: "clear the list filter and continue" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(result).toMatchObject({
      success: true,
      data: "Resumed without waiting for the old context.",
      navigationCount: 1
    });
    expect(mainTaskScriptCount(fake.scripts)).toBe(2);
    const resumedScript = fake.scripts.filter((script) => script.includes("new lib.PageAgentCore"))[1];
    expect(resumedScript).toContain("Navigation checkpoint 1");
    expect(resumedScript).toContain("Current page URL: https://example.test/");
    expect(resumedScript).toContain("READ-ONLY CHECKPOINT");
    expect(resumedScript).toContain("choose done in your next response");
    expect(resumedScript).toContain("use snapshotAfter to decide whether any follow-up browser_task is needed");
    expect(resumedScript).not.toContain("clear the list filter and continue");
  });

  it("uses a read-only checkpoint after navigation even when earlier steps were recorded", async () => {
    let attempt = 0;
    const fake = createFakeContents(
      (script) => {
        if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
          return true;
        }
        attempt += 1;
        if (attempt === 1) {
          // Let the supervisor's one-second progress poll capture the four completed steps
          // before the document is replaced.
          setTimeout(fake.fireNavigate, 1_100);
          return new Promise(() => undefined);
        }
        return { ok: true, success: true, data: "Read-only checkpoint complete.", stepCount: 1 };
      },
      () => ({ stepCount: 4, lastAction: "click_element_by_index", lastGoal: "submit the variable form" })
    );

    const result = await runBrowserTask(
      fake.contents,
      { instruction: "fill fields and submit the variable" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(result).toMatchObject({ success: true, navigationCount: 1, stepCount: 5 });
    const resumedScript = fake.scripts.filter((script) => script.includes("new lib.PageAgentCore"))[1];
    expect(resumedScript).toContain("Navigation checkpoint 1");
    expect(resumedScript).toContain("recorded 4 completed step(s)");
    expect(resumedScript).toContain("READ-ONLY CHECKPOINT");
    expect(resumedScript).toContain("Do not attempt or repeat any action from the previous document");
    expect(resumedScript).not.toContain("fill fields and submit the variable");
  });

  it("waits for the destination document to settle before re-injecting", async () => {
    let attempt = 0;
    let loading = true;
    const fake = createFakeContents(() => {
      attempt += 1;
      if (attempt === 1) {
        setTimeout(() => {
          fake.fireNavigate();
          setTimeout(() => {
            loading = false;
          }, 120);
        }, 0);
        return new Promise(() => undefined);
      }
      expect(loading).toBe(false);
      return { ok: true, success: true, data: "Injected after load settled.", stepCount: 1 };
    });
    Object.assign(fake.contents, { isLoading: () => loading });

    const result = await runBrowserTask(
      fake.contents,
      { instruction: "continue after the destination loads" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(result).toMatchObject({ success: true, navigationCount: 1, data: "Injected after load settled." });
  });

  it("gives up after exceeding the navigation-resume cap instead of looping forever", async () => {
    const { contents, fireNavigate } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      fireNavigate();
      throw new Error("Execution context was destroyed.");
    });

    const result = await runBrowserTask(
      contents,
      { instruction: "an instruction on a page that keeps redirecting" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(result.success).toBe(false);
    expect(String(result.data)).toMatch(/navigations without finishing/);
    expect(result.navigationCount).toBeGreaterThan(1);
  });

  it("flags zero-step network failures as infrastructure problems instead of task problems", async () => {
    const { contents } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return false;
      }
      return { ok: true, success: false, data: "InvokeError: Network request failed", stepCount: 0 };
    });

    const result = await runBrowserTask(
      contents,
      { instruction: "fill out the form" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(result.success).toBe(false);
    expect(String(result.data)).toMatch(/infrastructure\/connectivity failure/);
    expect(String(result.data)).toMatch(/retrying browser_task with reworded instructions will not help/);
  });

  it("does not add the connectivity hint when steps were taken before the failure", async () => {
    const { contents } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return false;
      }
      return { ok: true, success: false, data: "InvokeError: Network request failed", stepCount: 3 };
    });

    const result = await runBrowserTask(
      contents,
      { instruction: "fill out the form" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(result.success).toBe(false);
    expect(String(result.data)).not.toMatch(/infrastructure\/connectivity failure/);
  });

  it("derives a default domain allowlist from the current page and wires the safety hook in visible mode", async () => {
    const scripts: string[] = [];
    const contents = {
      getURL: () => "https://shop.example.com/checkout",
      executeJavaScript: async (script: string) => {
        scripts.push(script);
        if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
          return true;
        }
        if (script.includes("__arivuPageAgentTask.history")) {
          return null;
        }
        return { ok: true, success: true, data: "Done.", stepCount: 1 };
      },
      on: () => contents,
      off: () => contents
    } as unknown as WebContents;

    await runBrowserTask(
      contents,
      { instruction: "buy the item", visible: true },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    const mainScript = mainScriptFrom(scripts);
    expect(mainScript).toContain('["shop.example.com"]');
    expect(mainScript).toContain("arivuOnBeforeStep");
    expect(mainScript).toContain("enableMask: true");
    expect(mainScript).toContain("new lib.Panel(core, { promptForNextTask: false })");
    expect(mainScript).toContain('setAttribute("aria-label", "Browser agent activity")');
    expect(mainScript).toContain("activityPanel.expand()");
  });

  it("disables the action mask in background mode", async () => {
    const { contents, scripts } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return { ok: true, success: true, data: "Done.", stepCount: 1 };
    });

    await runBrowserTask(
      contents,
      { instruction: "fill out the form", visible: false },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    const mainScript = mainScriptFrom(scripts);
    expect(mainScript).toContain("enableMask: false");
    expect(mainScript).toContain("if (false)");
  });

  it("wires the in-page agent with instructions, content capping, reflection backfill and retry budget", async () => {
    const { contents, scripts } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return { ok: true, success: true, data: "Done.", stepCount: 1 };
    });

    await runBrowserTask(
      contents,
      { instruction: "fill out the form" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    const mainScript = mainScriptFrom(scripts);
    expect(mainScript).toContain("maxRetries: 4");
    expect(mainScript).toContain("transformPageContent: arivuCapPageContent");
    expect(mainScript).toContain("onAfterStep: arivuBackfillReflection");
    // The anti-toggle checkbox rule is the marker for the whole system-instruction block.
    expect(mainScript).toContain("Never click a checkbox");
  });

  it("returns the in-page agent's condensed trace and token usage when available", async () => {
    const trace = [
      'step 1: input_text {"index":1,"text":"Maintain Items"} -> ✅ Input text',
      "step 2: click_element_by_index -> ✅ Clicked"
    ];
    const { contents } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return false;
      }
      return { ok: true, success: true, data: "Done.", stepCount: 2, trace, tokensUsed: 12345 };
    });

    const result = await runBrowserTask(
      contents,
      { instruction: "fill out the form" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(result.trace).toEqual(trace);
    expect(result.tokensUsed).toBe(12345);
  });

  it("reports timeout stops with step progress and guidance instead of a bare abort message", async () => {
    const { contents } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return new Promise(() => undefined);
    });

    const result = await runBrowserTask(
      contents,
      { instruction: "an instruction that never finishes", timeoutMs: 1_000 },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(result.stopReason).toBe("timeout");
    expect(String(result.data)).toMatch(/exceeded its 1000ms budget after \d+ step\(s\)/);
    expect(String(result.data)).toMatch(/raise timeoutMs/);
  }, 10_000);

  it("respects an explicit allowedDomains override instead of the current page's host", async () => {
    const scripts: string[] = [];
    const contents = {
      getURL: () => "https://shop.example.com/checkout",
      executeJavaScript: async (script: string) => {
        scripts.push(script);
        if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
          return true;
        }
        if (script.includes("__arivuPageAgentTask.history")) {
          return null;
        }
        return { ok: true, success: true, data: "Done.", stepCount: 1 };
      },
      on: () => contents,
      off: () => contents
    } as unknown as WebContents;

    await runBrowserTask(
      contents,
      { instruction: "search across sites", allowedDomains: ["example.com", "example.org"] },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    const mainScript = mainScriptFrom(scripts);
    expect(mainScript).toContain('["example.com","example.org"]');
  });

  it("keeps the in-page JavaScript execution tool disabled unless allowJavaScript is set", async () => {
    const { contents, scripts } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return { ok: true, success: true, data: "Done.", stepCount: 1 };
    });

    await runBrowserTask(
      contents,
      { instruction: "fill out the form" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(mainScriptFrom(scripts)).toContain("experimentalScriptExecutionTool: false");
  });

  it("enables the in-page JavaScript execution tool when allowJavaScript is set", async () => {
    const { contents, scripts } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return { ok: true, success: true, data: "Done.", stepCount: 1 };
    });

    await runBrowserTask(
      contents,
      { instruction: "compute a value the DOM can't expose", allowJavaScript: true },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(mainScriptFrom(scripts)).toContain("experimentalScriptExecutionTool: true");
  });

  it("clears any stale in-page stop reason and keeps the sensitive-text check on by default", async () => {
    const { contents, scripts } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return { ok: true, success: true, data: "Done.", stepCount: 1 };
    });

    await runBrowserTask(
      contents,
      { instruction: "fill out the form" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    const mainScript = mainScriptFrom(scripts);
    expect(mainScript).toContain("window.__arivuPageAgentStopReason = undefined;");
    expect(mainScript).toContain("var checkSensitiveText = true;");
  });

  it("disables the sensitive-text pause when allowSensitiveActions is set", async () => {
    const { contents, scripts } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return { ok: true, success: true, data: "Done.", stepCount: 1 };
    });

    await runBrowserTask(
      contents,
      { instruction: "confirm the order the user already approved", allowSensitiveActions: true },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(mainScriptFrom(scripts)).toContain("var checkSensitiveText = false;");
  });

  it("normalizes allowedDomains entries so the in-page host check cannot reject every page", async () => {
    const { contents, scripts } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return { ok: true, success: true, data: "Done.", stepCount: 1 };
    });

    await runBrowserTask(
      contents,
      { instruction: "search across sites", allowedDomains: ["Example.COM", " .example.org "] },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(mainScriptFrom(scripts)).toContain('["example.com","example.org"]');
  });

  it("keeps the real answer when the task completes during the stop grace window", async () => {
    let resolveTask: ((value: unknown) => void) | undefined;
    const { contents } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        resolveTask?.({ ok: true, success: true, data: "The heading is Example Domain.", stepCount: 3 });
        return true;
      }
      return new Promise((resolve) => {
        resolveTask = resolve;
      });
    });

    const result = await runBrowserTask(
      contents,
      { instruction: "read the heading", timeoutMs: 1_000 },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(result.stopReason).toBe("timeout");
    expect(result.success).toBe(true);
    expect(result.data).toBe("The heading is Example Domain.");
  }, 10_000);

  it("does not inject the task at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { contents, scripts } = createFakeContents(() => ({ ok: true, success: true, data: "Done.", stepCount: 1 }));

    const result = await runBrowserTask(
      contents,
      { instruction: "fill out the form" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY },
      controller.signal
    );

    expect(result.stopReason).toBe("cancelled");
    expect(mainTaskScriptCount(scripts)).toBe(0);
  });

  it("refuses to resume onto an off-allowlist page instead of re-injecting the proxy token", async () => {
    let attempt = 0;
    const scripts: string[] = [];
    const navigateListeners = new Set<() => void>();
    const contents = {
      getURL: () => (attempt === 0 ? "https://shop.example.com/checkout" : "https://evil.example.net/landing"),
      executeJavaScript: async (script: string) => {
        scripts.push(script);
        if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
          return true;
        }
        if (script.includes("__arivuPageAgentTask.history")) {
          return null;
        }
        attempt += 1;
        for (const listener of navigateListeners) {
          listener();
        }
        throw new Error("Execution context was destroyed.");
      },
      on: (event: string, listener: () => void) => {
        if (event === "did-navigate") {
          navigateListeners.add(listener);
        }
        return contents;
      },
      off: (event: string, listener: () => void) => {
        if (event === "did-navigate") {
          navigateListeners.delete(listener);
        }
        return contents;
      }
    } as unknown as WebContents;

    const result = await runBrowserTask(
      contents,
      { instruction: "buy the item" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(result.success).toBe(false);
    expect(String(result.data)).toMatch(/outside the allowed domain list/);
    expect(scripts.filter((script) => script.includes("PageAgentCore")).length).toBe(1);
  });

  it("bounds page-controlled result fields before they reach the tool result", async () => {
    const { contents } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return false;
      }
      return {
        ok: true,
        success: true,
        data: "x".repeat(50_000),
        stepCount: -5.5,
        trace: [...Array.from({ length: 100 }, (_, i) => `entry ${i} ${"y".repeat(1_000)}`), 42, null],
        tokensUsed: "999"
      };
    });

    const result = await runBrowserTask(
      contents,
      { instruction: "fill out the form" },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(String(result.data).length).toBeLessThanOrEqual(16_020);
    expect(result.stepCount).toBe(0);
    expect(Array.isArray(result.trace)).toBe(true);
    expect((result.trace as string[]).length).toBeLessThanOrEqual(200);
    for (const entry of result.trace as string[]) {
      expect(typeof entry).toBe("string");
      expect(entry.length).toBeLessThanOrEqual(140);
    }
    expect(result.tokensUsed).toBeUndefined();
  });

  it("guards engine load and mask construction so page restrictions cannot kill the task opaquely", async () => {
    const { contents, scripts } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return { ok: true, success: true, data: "Done.", stepCount: 1 };
    });

    await runBrowserTask(
      contents,
      { instruction: "fill out the form", visible: true },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    const mainScript = mainScriptFrom(scripts);
    // Bundle eval is idempotent and reports the real error instead of Electron's opaque
    // "Script failed to execute".
    expect(mainScript).toContain("if (!window.__ArivuPageAgentLib) {");
    expect(mainScript).toContain("The browser task engine failed to load: ");
    // The cosmetic mask falls back to maskless instead of throwing (Trusted Types pages).
    expect(mainScript).toContain("enableMask: true");
    expect(mainScript).toContain("pageController = new lib.PageController({ enableMask: false });");
  });

  it("generates an injected script that parses as valid JavaScript", async () => {
    // The fake executeJavaScript never parses the script, so an escaping bug in the raw
    // snippet strings (regex literals, quotes, backslashes) would otherwise only surface
    // at runtime inside a real page. new Function parses without executing.
    const { contents, scripts } = createFakeContents((script) => {
      if (script.includes("typeof window.__arivuPageAgentTask.stop")) {
        return true;
      }
      return { ok: true, success: true, data: "Done.", stepCount: 1 };
    });

    await runBrowserTask(
      contents,
      { instruction: 'tricky "quotes" and \\backslashes\\ and\nnewlines', allowJavaScript: true, visible: true },
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(() => new Function(mainScriptFrom(scripts))).not.toThrow();
  });
});

function mainScriptFrom(scripts: string[]): string {
  const script = scripts.find(
    (candidate) => !candidate.includes("typeof window.__arivuPageAgentTask.stop") && !candidate.includes("__arivuPageAgentTask.history")
  );
  if (!script) {
    throw new Error("No main task script was recorded.");
  }
  return script;
}
