import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import type { WebContents } from "electron";
import {
  ensureBrowserTaskProxy,
  registerBrowserTaskProxyEntry,
  unregisterBrowserTaskProxyEntry
} from "../desktop/main/browserTaskProxy.js";
import { __setPageAgentBundleTextForTests, runBrowserTask } from "../desktop/main/browserTaskSupervisor.js";

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

describe("runBrowserTask", () => {
  function createFakeContents(onScript: (script: string) => unknown) {
    const scripts: string[] = [];
    const navigateListeners = new Set<() => void>();
    const contents = {
      executeJavaScript: async (script: string) => {
        scripts.push(script);
        if (script.includes("window.__arivuPageAgentTask.history")) {
          return null;
        }
        return onScript(script);
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
    const fireNavigate = () => {
      for (const listener of navigateListeners) {
        listener();
      }
    };
    return { contents, scripts, fireNavigate };
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
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: REAL_API_KEY }
    );

    expect(result.success).toBe(true);
    expect(result.data).toBe("Done.");
    expect(result.stepCount).toBe(2);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script.includes(REAL_API_KEY)).toBe(false);
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

    expect(mainScriptFrom(scripts)).toContain("enableMask: false");
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
    expect((result.trace as string[]).length).toBeLessThanOrEqual(30);
    for (const entry of result.trace as string[]) {
      expect(typeof entry).toBe("string");
      expect(entry.length).toBeLessThanOrEqual(320);
    }
    expect(result.tokensUsed).toBeUndefined();
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
