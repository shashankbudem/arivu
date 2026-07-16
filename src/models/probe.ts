import { parseContextLimit } from "./contextLimitParser.js";
import type { ModelStatus } from "./modelCatalogSchema.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ProbeTarget = { baseUrl: string; apiKey?: string; model: string };

export type StatusProbeResult = { status: ModelStatus; detail?: string };
export type ContextProbeResult = { tokens?: number; source?: "probe_max_tokens" | "probe_oversized"; error?: string };

const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * The status ping runs real inference, so it must tolerate slow/reasoning models that take far
 * longer than a validation-only call. Distinct from DEFAULT_TIMEOUT_MS, which covers probes the
 * provider rejects before generating anything.
 */
const STATUS_TIMEOUT_MS = 60_000;

function classifyErrorBody(status: number, body: string): StatusProbeResult {
  if (status === 404 || /not found for account/i.test(body)) {
    return { status: "not_entitled", detail: compact(body) };
  }
  if (status === 429 || /too many requests|rate limit/i.test(body)) {
    return { status: "rate_limited", detail: compact(body) };
  }
  if (status === 503 || /resourceexhausted|workers are busy/i.test(body)) {
    return { status: "busy", detail: compact(body) };
  }
  return { status: "error", detail: `HTTP ${status}: ${compact(body)}` };
}

/**
 * Cheap daily status check: a 1-token completion. Deliberately NOT the oversized-max_tokens trick —
 * several models (llama-3.1-8b, gpt-oss-120b, glm-5.2, minimax-m3) silently accept that and run full
 * inference, which is the cost this probe exists to avoid.
 */
export async function probeStatus(target: ProbeTarget, fetcher: FetchLike, timeoutMs = STATUS_TIMEOUT_MS): Promise<StatusProbeResult> {
  try {
    const response = await postChat(target, { messages: [{ role: "user", content: "hi" }], max_tokens: 1 }, fetcher, timeoutMs);
    if (response.ok) {
      await response.text().catch(() => "");
      return { status: "available" };
    }
    return classifyErrorBody(response.status, await response.text().catch(() => ""));
  } catch (error) {
    return { status: "unknown", detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolves a model's context window from the provider's own validation error, with no inference.
 * An absurd `max_tokens` makes most backends reject the request while naming their limit.
 *
 * Not universal: some models accept it (returning 200) and reveal nothing — those stay unresolved
 * and fall back to the conservative default rather than being guessed at.
 */
export async function probeContextViaMaxTokens(
  target: ProbeTarget,
  fetcher: FetchLike,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ContextProbeResult> {
  try {
    const response = await postChat(target, { messages: [{ role: "user", content: "hi" }], max_tokens: 99_999_999 }, fetcher, timeoutMs);
    const body = await response.text().catch(() => "");
    if (response.ok) {
      return { error: "model accepted an oversized max_tokens without reporting a limit" };
    }
    const tokens = parseContextLimit(body);
    return tokens ? { tokens, source: "probe_max_tokens" } : { error: `unrecognized limit contract: ${compact(body).slice(0, 160)}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Reliable-but-expensive fallback: an oversized INPUT. Exceeding the window is a hard error on every
 * backend, so this always names the limit — at the cost of a multi-MB upload. Opt-in only
 * (`arivu models probe-context <model> --deep`); never run on the daily schedule.
 */
export async function probeContextViaOversizedInput(
  target: ProbeTarget,
  fetcher: FetchLike,
  approxTokens = 550_000,
  timeoutMs = 120_000
): Promise<ContextProbeResult> {
  // "word " tokenizes to ~1.0 token on every backend measured (usage.prompt_tokens ≈ repetitions on
  // minimax, nemotron, deepseek), so repeat exactly approxTokens times — an undershoot silently turns
  // "window larger than N" into a false acceptance for windows just under N.
  const blob = "word ".repeat(Math.ceil(approxTokens));
  try {
    const response = await postChat(target, { messages: [{ role: "user", content: blob }], max_tokens: 16 }, fetcher, timeoutMs);
    const body = await response.text().catch(() => "");
    if (response.ok) {
      return { error: `model accepted ~${approxTokens} tokens; window is larger than that` };
    }
    const tokens = parseContextLimit(body);
    return tokens ? { tokens, source: "probe_oversized" } : { error: `unrecognized limit contract: ${compact(body).slice(0, 160)}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function postChat(target: ProbeTarget, body: Record<string, unknown>, fetcher: FetchLike, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Probe timed out after ${timeoutMs}ms.`)), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (target.apiKey) {
      headers.Authorization = `Bearer ${target.apiKey}`;
    }
    return await fetcher(`${target.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: target.model, ...body }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Lists the provider's advertised model ids. Note: a catalog, not an entitlement list. */
export async function listProviderModels(
  endpoint: { baseUrl: string; apiKey?: string },
  fetcher: FetchLike,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Model list timed out after ${timeoutMs}ms.`)), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (endpoint.apiKey) {
      headers.Authorization = `Bearer ${endpoint.apiKey}`;
    }
    const response = await fetcher(`${endpoint.baseUrl.replace(/\/+$/, "")}/models`, { headers, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Model list request failed (${response.status}): ${compact(body).slice(0, 200)}`);
    }
    const json = JSON.parse(body) as { data?: Array<{ id?: string }> };
    return (json.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => Boolean(id))
      .sort((left, right) => left.localeCompare(right));
  } finally {
    clearTimeout(timer);
  }
}

function compact(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 400);
}
