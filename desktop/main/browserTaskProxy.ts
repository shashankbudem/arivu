import { randomBytes } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";

/**
 * Loopback-only reverse proxy that lets an injected page-agent instance call the real LLM
 * provider without ever holding the real API key in the page's untrusted main-world JS
 * context. The page is given a random per-task bearer token instead of the real key; this
 * proxy swaps it for the real `Authorization` header before forwarding upstream.
 */

type ProxyRegistration = {
  realBaseUrl: string;
  realApiKey?: string;
  expiresAt: number;
};

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
  ttlMs: number;
}): Promise<{ token: string; proxyBaseUrl: string }> {
  const { port } = await ensureBrowserTaskProxy();
  const token = randomBytes(24).toString("hex");
  registrations.set(token, {
    realBaseUrl: options.realBaseUrl.replace(/\/+$/, ""),
    realApiKey: options.realApiKey,
    expiresAt: Date.now() + options.ttlMs
  });
  return { token, proxyBaseUrl: `http://127.0.0.1:${port}` };
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
  try {
    if (req.method === "OPTIONS") {
      handlePreflight(req, res);
      return;
    }

    const authHeader = req.headers.authorization;
    const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    const registration = token ? registrations.get(token) : undefined;
    if (!registration || registration.expiresAt <= Date.now()) {
      res
        .writeHead(401, { "content-type": "application/json", ...corsHeaders(req) })
        .end(JSON.stringify({ error: "Invalid or expired browser task session." }));
      return;
    }

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
    const upstreamResponse = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
      duplex: hasBody ? "half" : undefined
    } as NodeFetchInit);

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
    if (!upstreamResponse.body) {
      res.end();
      return;
    }
    const nodeStream = Readable.fromWeb(upstreamResponse.body as import("node:stream/web").ReadableStream<Uint8Array>);
    nodeStream.pipe(res);
    nodeStream.on("error", () => res.end());
  } catch (error) {
    res
      .writeHead(502, { "content-type": "application/json", ...corsHeaders(req) })
      .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}
