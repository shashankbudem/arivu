import { randomBytes } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { searchWeb } from "../../src/tools/webSearch.js";
import type { WebSearchProviderProfile } from "../../src/tools/webSearchProvider.js";

/**
 * Loopback-only reverse proxy that lets an injected page-agent instance call the real LLM
 * provider without ever holding the real API key in the page's untrusted main-world JS
 * context. The page is given a random per-task bearer token instead of the real key; this
 * proxy swaps it for the real `Authorization` header before forwarding upstream.
 */

type ProxyRegistration = {
  realBaseUrl: string;
  realApiKey?: string;
  /** Forwarded to searchWeb() for the in-page search_web tool; undefined falls back to Bing. */
  webSearchProvider?: WebSearchProviderProfile;
  /** Captures the current browser-task viewport without exposing Electron to page JavaScript. */
  captureScreenshot?: () => Promise<BrowserTaskScreenshot>;
  /** Grounds one uniquely described GUI control and clicks it in the captured viewport. */
  visualClick?: (target: string, signal: AbortSignal) => Promise<BrowserTaskVisualClickResult>;
  pendingScreenshot?: BrowserTaskScreenshot;
  expiresAt: number;
  requestTimeoutMs: number;
  requestCount: number;
  diagnostics: BrowserTaskProxyDiagnostic[];
  unsupportedParams: Set<string>;
  imageInputsUnsupported: boolean;
};

export type BrowserTaskScreenshot = {
  image: string;
  width: number;
  height: number;
};

export type BrowserTaskVisualClickResult = {
  target: string;
  x: number;
  y: number;
  model: string;
  matched?: unknown;
};

export type BrowserTaskProxyDiagnostic = {
  attempt: number;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  outcome: "success" | "upstream_error" | "network_error";
  message?: string;
  /**
   * True when the proxy itself is about to retry this failed upstream attempt (429/503
   * backoff). Consumers judging endpoint health (the supervisor's model circuit) must skip
   * these: they are in-flight recoveries, not terminal failures.
   */
  willRetry?: boolean;
};

const MAX_DIAGNOSTICS_PER_TASK = 50;

// The in-page page-agent client retries rate limits with a flat 100ms delay, which just re-hits
// the limit and burns its whole retry budget (seen killing a real run: "InvokeError: Rate limit
// exceeded"). The proxy retries transient upstream failures here instead, honoring Retry-After, so the page
// only ever sees a rate-limit error after proper backoff has already been exhausted. The
// browser_task wall-clock budget still bounds the total wait.
const RETRYABLE_UPSTREAM_STATUSES = new Set([429, 500, 502, 503, 504]);
const UPSTREAM_RETRY_LIMIT = 3;
const UPSTREAM_RETRY_BASE_DELAY_MS = 1_000;
const UPSTREAM_RETRY_MAX_DELAY_MS = 30_000;
// A provider connection that accepts the request but never returns headers otherwise pins one
// browser-agent step until the entire browser_task wall-clock budget expires. NIM completions
// observed in production can legitimately take over a minute, so keep this generous while
// still giving the proxy a finite recovery boundary.
const DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS = 360_000;
const UPSTREAM_NETWORK_RETRY_LIMIT = 1;
// The in-page client patches requests with vendor-specific parameters (e.g. `thinking` to
// disable reasoning for deepseek/glm/kimi). OpenAI-compatible gateways vary: the vendor's own
// API accepts them, but e.g. NVIDIA NIM's deepseek endpoint rejects the request outright with
// HTTP 400 "Unsupported parameter(s): `thinking`" — killing every step. When a 400 names the
// offending parameters, strip exactly those and retry: self-healing for any provider/model
// combination without maintaining a compatibility table here.
const MAX_PARAM_STRIP_RETRIES = 2;
// Buffering the request body is what makes retries possible (a consumed stream cannot be
// replayed); chat-completion payloads are far below this cap.
const MAX_BUFFERED_BODY_BYTES = 20 * 1024 * 1024;

// Reserved path for the in-page search_web tool (browserTaskSupervisor.ts's injectedTaskScript).
// Handled entirely separately from the LLM-forwarding path below, before any upstream request is
// built, so it can never interact with that path's retry/backoff/param-stripping state.
const SEARCH_PATH = "/__arivu_search";
const MAX_SEARCH_QUERY_LENGTH = 300;
const SCREENSHOT_PATH = "/__arivu_screenshot";
const VISUAL_CLICK_PATH = "/__arivu_visual_click";
const PENDING_SCREENSHOT_URL = "arivu-recovery-screenshot://pending";
const MAX_VISUAL_CLICK_BODY_BYTES = 8 * 1024;
const MAX_VISUAL_CLICK_TARGET_CHARS = 500;

const TOKEN_SWEEP_INTERVAL_MS = 30_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length"
]);
// Browser-context headers from the injected page. The upstream call is server-to-server;
// forwarding these can trip provider-side CORS handling or WAF browser heuristics.
const BROWSER_CONTEXT_HEADERS = new Set(["origin", "referer", "cookie"]);

function isForwardableHeader(key: string): boolean {
  const lower = key.toLowerCase();
  return !HOP_BY_HOP_HEADERS.has(lower) && !BROWSER_CONTEXT_HEADERS.has(lower) && !lower.startsWith("sec-");
}

// The resolved global `RequestInit` type comes from lib.dom.d.ts, which predates the
// `duplex` streaming-body option that Node's actual undici-backed fetch implementation
// supports and requires when a request body is a stream.
type NodeFetchInit = RequestInit & { duplex?: "half" };

let server: http.Server | undefined;
let serverPort: number | undefined;
let sweepTimer: NodeJS.Timeout | undefined;
const registrations = new Map<string, ProxyRegistration>();

export async function ensureBrowserTaskProxy(): Promise<{ port: number }> {
  if (server && serverPort) {
    return { port: serverPort };
  }
  const instance = http.createServer((req, res) => {
    void handleProxyRequest(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve());
  });
  const address = instance.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine the browser task proxy port.");
  }
  server = instance;
  serverPort = address.port;
  if (!sweepTimer) {
    sweepTimer = setInterval(sweepExpiredRegistrations, TOKEN_SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }
  return { port: serverPort };
}

export async function registerBrowserTaskProxyEntry(options: {
  realBaseUrl: string;
  realApiKey?: string;
  webSearchProvider?: WebSearchProviderProfile;
  captureScreenshot?: () => Promise<BrowserTaskScreenshot>;
  visualClick?: (target: string, signal: AbortSignal) => Promise<BrowserTaskVisualClickResult>;
  ttlMs: number;
  /** Test/diagnostic override; production callers use the bounded default above. */
  requestTimeoutMs?: number;
}): Promise<{ token: string; proxyBaseUrl: string }> {
  const { port } = await ensureBrowserTaskProxy();
  const token = randomBytes(24).toString("hex");
  registrations.set(token, {
    realBaseUrl: options.realBaseUrl.replace(/\/+$/, ""),
    realApiKey: options.realApiKey,
    webSearchProvider: options.webSearchProvider,
    captureScreenshot: options.captureScreenshot,
    visualClick: options.visualClick,
    expiresAt: Date.now() + options.ttlMs,
    requestTimeoutMs: Math.max(1, options.requestTimeoutMs ?? DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS),
    requestCount: 0,
    diagnostics: [],
    unsupportedParams: new Set(),
    imageInputsUnsupported: false
  });
  return { token, proxyBaseUrl: `http://127.0.0.1:${port}` };
}

export function getBrowserTaskProxyDiagnostics(token: string): BrowserTaskProxyDiagnostic[] {
  return registrations.get(token)?.diagnostics.map((diagnostic) => ({ ...diagnostic })) ?? [];
}

export function unregisterBrowserTaskProxyEntry(token: string) {
  registrations.delete(token);
}

function sweepExpiredRegistrations() {
  const now = Date.now();
  for (const [token, entry] of registrations) {
    if (entry.expiresAt <= now) {
      registrations.delete(token);
    }
  }
}

/**
 * CORS/preflight support: the injected page-agent calls this proxy from an arbitrary web
 * origin (often HTTPS), so the browser sends an OPTIONS preflight and requires CORS headers
 * on every response — without them the page blocks the request before it ever reaches us
 * (seen as "InvokeError: Network request failed" at step 0). CORS is not the security
 * boundary here; the per-task bearer token is. Preflights intentionally skip the token
 * check because browsers never attach Authorization headers to preflight requests.
 */
function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = typeof req.headers.origin === "string" && req.headers.origin ? req.headers.origin : "*";
  return {
    "access-control-allow-origin": origin,
    vary: "Origin"
  };
}

async function handleSearchRequest(req: http.IncomingMessage, res: http.ServerResponse, registration: ProxyRegistration) {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
    if (!query) {
      res
        .writeHead(400, { "content-type": "application/json", ...corsHeaders(req) })
        .end(JSON.stringify({ error: "Missing search query." }));
      return;
    }
    const requestedResults = Number(url.searchParams.get("n"));
    const maxResults = Number.isFinite(requestedResults) ? Math.min(10, Math.max(1, Math.round(requestedResults))) : 5;
    const results = await searchWeb(query, maxResults, { provider: registration.webSearchProvider });
    const body = JSON.stringify({
      query,
      results: results.map((result) => ({ title: result.title, url: result.url, snippet: result.snippet }))
    });
    res.writeHead(200, { "content-type": "application/json", ...corsHeaders(req) }).end(body);
  } catch (error) {
    res
      .writeHead(502, { "content-type": "application/json", ...corsHeaders(req) })
      .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

async function handleScreenshotRequest(req: http.IncomingMessage, res: http.ServerResponse, registration: ProxyRegistration) {
  if (!registration.captureScreenshot) {
    res
      .writeHead(503, { "content-type": "application/json", ...corsHeaders(req) })
      .end(JSON.stringify({ error: "Screenshot capture is unavailable for this browser task." }));
    return;
  }
  try {
    const screenshot = await registration.captureScreenshot();
    if (
      typeof screenshot.image !== "string" ||
      !/^data:image\/(?:png|jpeg);base64,/.test(screenshot.image) ||
      screenshot.width <= 0 ||
      screenshot.height <= 0
    ) {
      throw new Error("Screenshot capture returned invalid image data.");
    }
    // Keep pixels in the trusted main process. The page receives only dimensions and inserts
    // an opaque placeholder into its next model request; the proxy replaces that placeholder
    // after the request has left the page.
    registration.pendingScreenshot = screenshot;
    res
      .writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...corsHeaders(req)
      })
      .end(JSON.stringify({ queued: true, width: screenshot.width, height: screenshot.height }));
  } catch (error) {
    res
      .writeHead(502, { "content-type": "application/json", ...corsHeaders(req) })
      .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

async function handleVisualClickRequest(req: http.IncomingMessage, res: http.ServerResponse, registration: ProxyRegistration) {
  if (!registration.visualClick) {
    res
      .writeHead(503, { "content-type": "application/json", ...corsHeaders(req) })
      .end(JSON.stringify({ error: "LocateAnything visual grounding is not configured for this browser task." }));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse((await readRequestBody(req, MAX_VISUAL_CLICK_BODY_BYTES)).toString("utf8"));
  } catch {
    res
      .writeHead(400, { "content-type": "application/json", ...corsHeaders(req) })
      .end(JSON.stringify({ error: "Visual click request must contain a small JSON body." }));
    return;
  }
  const target =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).target === "string"
      ? String((parsed as Record<string, unknown>).target)
          .replace(/\s+/g, " ")
          .trim()
      : "";
  if (!target || target.length > MAX_VISUAL_CLICK_TARGET_CHARS) {
    res
      .writeHead(400, { "content-type": "application/json", ...corsHeaders(req) })
      .end(JSON.stringify({ error: `target must contain 1..${MAX_VISUAL_CLICK_TARGET_CHARS} characters.` }));
    return;
  }

  const controller = new AbortController();
  const abortForClosedDownstream = () => controller.abort(new Error("Visual click caller disconnected."));
  res.once("close", abortForClosedDownstream);
  try {
    const result = await registration.visualClick(target, controller.signal);
    if (res.destroyed || res.writableEnded || res.socket?.destroyed) {
      return;
    }
    res
      .writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...corsHeaders(req)
      })
      .end(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    if (res.destroyed || res.writableEnded || res.socket?.destroyed) {
      return;
    }
    res
      .writeHead(502, { "content-type": "application/json", ...corsHeaders(req) })
      .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  } finally {
    res.off("close", abortForClosedDownstream);
  }
}

function handlePreflight(req: http.IncomingMessage, res: http.ServerResponse) {
  const requestedHeaders = req.headers["access-control-request-headers"];
  const headers: Record<string, string> = {
    ...corsHeaders(req),
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers":
      typeof requestedHeaders === "string" && requestedHeaders ? requestedHeaders : "authorization, content-type",
    "access-control-max-age": "600"
  };
  // Chromium Private Network Access: a public (https) page fetching a loopback address must
  // receive explicit permission in the preflight response or the request is blocked.
  if (req.headers["access-control-request-private-network"] === "true") {
    headers["access-control-allow-private-network"] = "true";
  }
  res.writeHead(204, headers).end();
}

async function handleProxyRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  let registration: ProxyRegistration | undefined;
  let startedAt = Date.now();
  let attempt = 0;
  try {
    if (req.method === "OPTIONS") {
      handlePreflight(req, res);
      return;
    }

    const authHeader = req.headers.authorization;
    const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    registration = token ? registrations.get(token) : undefined;
    if (!registration || registration.expiresAt <= Date.now()) {
      res
        .writeHead(401, { "content-type": "application/json", ...corsHeaders(req) })
        .end(JSON.stringify({ error: "Invalid or expired browser task session." }));
      return;
    }

    if (req.method === "GET" && safeRequestPath(req.url) === SEARCH_PATH) {
      await handleSearchRequest(req, res, registration);
      return;
    }
    if (req.method === "POST" && safeRequestPath(req.url) === SCREENSHOT_PATH) {
      await handleScreenshotRequest(req, res, registration);
      return;
    }
    if (req.method === "POST" && safeRequestPath(req.url) === VISUAL_CLICK_PATH) {
      await handleVisualClickRequest(req, res, registration);
      return;
    }

    startedAt = Date.now();
    attempt = ++registration.requestCount;

    const targetUrl = `${registration.realBaseUrl}${req.url ?? ""}`;
    const forwardHeaders = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || !isForwardableHeader(key)) {
        continue;
      }
      forwardHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    if (registration.realApiKey) {
      forwardHeaders.set("authorization", `Bearer ${registration.realApiKey}`);
    } else {
      forwardHeaders.delete("authorization");
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    let requestBody: Buffer | undefined;
    if (hasBody) {
      try {
        requestBody = await readRequestBody(req, MAX_BUFFERED_BODY_BYTES);
      } catch {
        res
          .writeHead(413, { "content-type": "application/json", ...corsHeaders(req) })
          .end(JSON.stringify({ error: "Request body too large for the browser task proxy." }));
        return;
      }
    }
    if (requestBody && registration.unsupportedParams.size > 0) {
      requestBody = stripNamedParams(requestBody, registration.unsupportedParams).body ?? requestBody;
    }
    if (requestBody && registration.pendingScreenshot) {
      const injected = injectPendingScreenshot(requestBody, registration.pendingScreenshot);
      if (injected.body) {
        requestBody = injected.body;
        registration.pendingScreenshot = undefined;
      }
    }
    if (requestBody && registration.imageInputsUnsupported) {
      requestBody = stripImageInputs(requestBody).body ?? requestBody;
    }

    let upstreamResponse: Response;
    let consumedErrorBody: string | undefined;
    let paramStripRetries = 0;
    let imageCompatibilityRetries = 0;
    for (let upstreamRetry = 0; ; upstreamRetry++) {
      consumedErrorBody = undefined;
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, registration.requestTimeoutMs);
      timeout.unref();
      const abortForClosedDownstream = () => controller.abort();
      res.once("close", abortForClosedDownstream);
      try {
        upstreamResponse = await fetch(targetUrl, {
          method: req.method,
          headers: forwardHeaders,
          body: requestBody,
          signal: controller.signal
        } as NodeFetchInit);
      } catch (error) {
        if (res.destroyed || res.writableEnded || res.socket?.destroyed) {
          return;
        }
        const willRetry = upstreamRetry < UPSTREAM_NETWORK_RETRY_LIMIT;
        const status = timedOut ? 504 : 502;
        const message = timedOut
          ? `Upstream request timed out after ${registration.requestTimeoutMs}ms.`
          : error instanceof Error
            ? error.message
            : String(error);
        recordDiagnostic(registration, {
          attempt,
          timestamp: new Date().toISOString(),
          method: req.method ?? "GET",
          path: safeRequestPath(req.url),
          status,
          latencyMs: Date.now() - startedAt,
          outcome: "network_error",
          message: boundDiagnosticMessage(message),
          willRetry: willRetry || undefined
        });
        if (!willRetry) {
          res.writeHead(status, { "content-type": "application/json", ...corsHeaders(req) }).end(JSON.stringify({ error: message }));
          return;
        }
        await sleep(Math.min(UPSTREAM_RETRY_BASE_DELAY_MS * 2 ** upstreamRetry, UPSTREAM_RETRY_MAX_DELAY_MS));
        if (res.destroyed || res.writableEnded || res.socket?.destroyed) {
          return;
        }
        continue;
      } finally {
        clearTimeout(timeout);
        res.off("close", abortForClosedDownstream);
      }

      // Self-healing for gateway parameter validation: strip the named parameters and retry.
      let strippedParams: string[] = [];
      if (upstreamResponse.status === 400 && requestBody && paramStripRetries < MAX_PARAM_STRIP_RETRIES) {
        consumedErrorBody = await upstreamResponse.text().catch(() => "");
        const stripped = stripUnsupportedParams(consumedErrorBody, requestBody);
        if (stripped.body) {
          strippedParams = stripped.params;
          for (const param of strippedParams) {
            registration.unsupportedParams.add(param);
          }
          requestBody = stripped.body;
          paramStripRetries += 1;
        }
      }
      let strippedImages = 0;
      const imageRejection =
        upstreamResponse.status === 400 && requestBody && imageCompatibilityRetries < 1 && consumedErrorBody !== undefined
          ? classifyImageRejection(consumedErrorBody)
          : undefined;
      if (imageRejection && requestBody) {
        const stripped = stripImageInputs(requestBody);
        if (stripped.body) {
          strippedImages = stripped.count;
          requestBody = stripped.body;
          // Only a genuine capability gap is permanent; a per-image (size/decode) rejection must
          // not disable vision for the rest of the task, so leave the flag untouched there.
          if (imageRejection === "capability") {
            registration.imageInputsUnsupported = true;
          }
          imageCompatibilityRetries += 1;
        }
      }
      const willStripRetry = strippedParams.length > 0;
      const willImageCompatibilityRetry = strippedImages > 0;
      const willBackoffRetry = RETRYABLE_UPSTREAM_STATUSES.has(upstreamResponse.status) && upstreamRetry < UPSTREAM_RETRY_LIMIT;
      const willRetry = willStripRetry || willImageCompatibilityRetry || willBackoffRetry;
      recordDiagnostic(registration, {
        attempt,
        timestamp: new Date().toISOString(),
        method: req.method ?? "GET",
        path: safeRequestPath(req.url),
        status: upstreamResponse.status,
        latencyMs: Date.now() - startedAt,
        outcome: upstreamResponse.ok ? "success" : "upstream_error",
        message: upstreamResponse.ok
          ? undefined
          : willStripRetry
            ? `provider rejected parameter(s) ${strippedParams.join(", ")}; retrying without them`
            : willImageCompatibilityRetry
              ? "provider rejected screenshot image input; retrying with a text-only recovery notice"
              : `${upstreamResponse.statusText || "upstream error"}${upstreamRetry > 0 ? ` (retry ${upstreamRetry} of ${UPSTREAM_RETRY_LIMIT})` : ""}`,
        willRetry: willRetry || undefined
      });
      if (!willRetry) {
        break;
      }
      if (!willStripRetry && !willImageCompatibilityRetry) {
        // Discard the error body before retrying so the connection can be reused.
        await upstreamResponse.body?.cancel().catch(() => undefined);
        const delayMs = Math.min(
          retryAfterFromHeaders(upstreamResponse.headers) ?? UPSTREAM_RETRY_BASE_DELAY_MS * 2 ** upstreamRetry,
          UPSTREAM_RETRY_MAX_DELAY_MS
        );
        await sleep(delayMs);
      }
      // The page may have navigated away or the task been stopped while we waited. Only the
      // response side signals that: req is auto-destroyed as soon as its body is fully read,
      // so checking req.destroyed here would abort every retry.
      if (res.destroyed || res.writableEnded || res.socket?.destroyed) {
        return;
      }
    }

    const responseHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });
    // Our CORS headers must win over whatever the upstream provider returned (upstream ACAO
    // values are scoped to the provider's own origin expectations, not the injected page's).
    Object.assign(responseHeaders, corsHeaders(req));
    res.writeHead(upstreamResponse.status, responseHeaders);
    // The param-strip check consumes 400 bodies; replay the captured text instead of the
    // (already-drained) stream.
    if (consumedErrorBody !== undefined) {
      res.end(consumedErrorBody);
      return;
    }
    if (!upstreamResponse.body) {
      res.end();
      return;
    }
    const nodeStream = Readable.fromWeb(upstreamResponse.body as import("node:stream/web").ReadableStream<Uint8Array>);
    nodeStream.pipe(res);
    nodeStream.on("error", () => res.end());
  } catch (error) {
    if (registration) {
      recordDiagnostic(registration, {
        attempt: attempt || ++registration.requestCount,
        timestamp: new Date().toISOString(),
        method: req.method ?? "GET",
        path: safeRequestPath(req.url),
        status: 502,
        latencyMs: Date.now() - startedAt,
        outcome: "network_error",
        message: boundDiagnosticMessage(error instanceof Error ? error.message : String(error))
      });
    }
    res
      .writeHead(502, { "content-type": "application/json", ...corsHeaders(req) })
      .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

function recordDiagnostic(registration: ProxyRegistration, diagnostic: BrowserTaskProxyDiagnostic) {
  registration.diagnostics.push(diagnostic);
  if (registration.diagnostics.length > MAX_DIAGNOSTICS_PER_TASK) {
    registration.diagnostics.splice(0, registration.diagnostics.length - MAX_DIAGNOSTICS_PER_TASK);
  }
}

async function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error("Request body exceeds proxy buffer limit.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Extracts parameter names from a gateway 400 like "Unsupported parameter(s): `thinking`" and,
 * when any of them are top-level keys in the JSON request body, returns the body without them.
 * Returns `{ params: [] }` (no retry) for unrelated 400s or non-JSON bodies.
 */
function stripUnsupportedParams(errorBody: string, requestBody: Buffer): { params: string[]; body?: Buffer } {
  const match = /unsupported parameter\(?s?\)?\s*:?\s*([\w`'",.\s$-]+)/i.exec(errorBody);
  if (!match) {
    return { params: [] };
  }
  const named = match[1].split(/[^\w.$-]+/).filter(Boolean);
  if (named.length === 0) {
    return { params: [] };
  }
  return stripNamedParams(requestBody, named);
}

function stripNamedParams(requestBody: Buffer, names: Iterable<string>): { params: string[]; body?: Buffer } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody.toString("utf8"));
  } catch {
    return { params: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { params: [] };
  }
  const record = parsed as Record<string, unknown>;
  const present = Array.from(names).filter((name) => name in record);
  if (present.length === 0) {
    return { params: [] };
  }
  for (const name of present) {
    delete record[name];
  }
  return { params: present, body: Buffer.from(JSON.stringify(record)) };
}

type ImageRejectionKind = "capability" | "per-image";

/**
 * Classifies a 400 that mentions image input:
 *  - "capability": the provider/model does not accept image input at all. This is deterministic,
 *    so the caller latches imageInputsUnsupported and strips images for the rest of the task.
 *  - "per-image": THIS image was rejected for a transient reason (too large, bad dimensions,
 *    decode/download failure). A smaller/valid screenshot would still be accepted, so the caller
 *    strips only this request and must NOT latch — otherwise one oversized capture permanently
 *    blinds recovery on a fully vision-capable provider.
 *  - undefined: not an image-related rejection.
 */
function classifyImageRejection(errorBody: string): ImageRejectionKind | undefined {
  const mentionsImage = /\b(image_url|image input|input image|vision|multimodal|data url|base64 image)\b/i.test(errorBody);
  if (!mentionsImage) {
    return undefined;
  }
  // Per-image problems (size, resolution, decode/download) are not a capability gap — treat these
  // first so a message that says both "invalid" and "too large" is classified as per-image.
  const perImageIssue =
    /\b(too large|exceeds|maximum|max(?:imum)? size|payload|too big|dimension|width|height|resolution|pixels?|aspect|decode|download|fetch|corrupt|malformed|truncated|timed out)\b/i.test(
      errorBody
    );
  if (perImageIssue) {
    return "per-image";
  }
  const rejectsCapability =
    /\b(unsupported|not supported|does not support|invalid|not allowed|text[- ]only|unknown content type|no (?:vision|image))\b/i.test(
      errorBody
    );
  return rejectsCapability ? "capability" : undefined;
}

/**
 * Removes image_url parts after an upstream model explicitly rejects vision input. The
 * replacement notice is placed in the same user message, so PageAgent can recover without
 * believing it saw pixels that the selected provider actually discarded.
 */
function stripImageInputs(requestBody: Buffer): { count: number; body?: Buffer } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody.toString("utf8"));
  } catch {
    return { count: 0 };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { count: 0 };
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.messages)) {
    return { count: 0 };
  }
  let count = 0;
  for (const message of record.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const messageRecord = message as Record<string, unknown>;
    if (!Array.isArray(messageRecord.content)) {
      continue;
    }
    const retained = messageRecord.content.filter((part) => {
      const isImage =
        Boolean(part) && typeof part === "object" && !Array.isArray(part) && (part as Record<string, unknown>).type === "image_url";
      if (isImage) {
        count += 1;
      }
      return !isImage;
    });
    if (retained.length !== messageRecord.content.length) {
      retained.push({
        type: "text",
        text: "[System observation: Arivu captured a recovery screenshot, but the selected browser model/provider rejected image input. Continue from browser_state and other tools; do not claim to have seen the image.]"
      });
      messageRecord.content = retained;
    }
  }
  return count > 0 ? { count, body: Buffer.from(JSON.stringify(record)) } : { count: 0 };
}

function injectPendingScreenshot(requestBody: Buffer, screenshot: BrowserTaskScreenshot): { count: number; body?: Buffer } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody.toString("utf8"));
  } catch {
    return { count: 0 };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { count: 0 };
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.messages)) {
    return { count: 0 };
  }
  let count = 0;
  for (const message of record.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        continue;
      }
      const partRecord = part as Record<string, unknown>;
      const imageUrl = partRecord.image_url;
      if (partRecord.type !== "image_url" || !imageUrl || typeof imageUrl !== "object" || Array.isArray(imageUrl)) {
        continue;
      }
      const imageUrlRecord = imageUrl as Record<string, unknown>;
      if (imageUrlRecord.url === PENDING_SCREENSHOT_URL) {
        imageUrlRecord.url = screenshot.image;
        count += 1;
      }
    }
  }
  return count > 0 ? { count, body: Buffer.from(JSON.stringify(record)) } : { count: 0 };
}

/** Parses Retry-After as delta-seconds or an HTTP date; undefined when absent or invalid. */
function retryAfterFromHeaders(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeRequestPath(rawUrl: string | undefined): string {
  try {
    const parsed = new URL(rawUrl ?? "/", "http://127.0.0.1");
    return parsed.pathname.slice(0, 200);
  } catch {
    return "/";
  }
}

function boundDiagnosticMessage(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 300);
}
