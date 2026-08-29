import type { BrowserVisualGroundingConfig } from "../tools/browserControl.js";

export const LOCATE_ANYTHING_DEFAULT_MODEL = "nvidia/LocateAnything-3B";
export const LOCATE_ANYTHING_MAX_TARGET_CHARS = 500;
const DEFAULT_GROUNDING_TIMEOUT_MS = 60_000;
const MAX_ERROR_BODY_CHARS = 2_000;

export type VisualViewportScreenshot = {
  imageDataUrl: string;
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type LocateAnythingPoint = {
  normalizedX: number;
  normalizedY: number;
  imageX: number;
  imageY: number;
  viewportX: number;
  viewportY: number;
  source: "point" | "box-center";
  rawAnswer: string;
};

export type LocateAnythingRequestOptions = {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
};

/**
 * Calls a LocateAnything model through an OpenAI-compatible vision endpoint and converts
 * NVIDIA's normalized 0..1000 point/box output into the exact screenshot and CSS viewport
 * coordinate spaces used by browser mouse input.
 */
export async function locateAnythingInViewport(
  config: BrowserVisualGroundingConfig,
  screenshot: VisualViewportScreenshot,
  target: string,
  options: LocateAnythingRequestOptions = {}
): Promise<LocateAnythingPoint> {
  const description = normalizeGroundingTarget(target);
  assertScreenshotGeometry(screenshot);
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const removeAbortLink = linkAbortSignal(options.signal, controller);
  const timeoutMs = config.timeoutMs ?? DEFAULT_GROUNDING_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(new Error(`LocateAnything timed out after ${timeoutMs}ms.`)), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetcher(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: config.model || LOCATE_ANYTHING_DEFAULT_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: screenshot.imageDataUrl, detail: "high" } },
              // This is LocateAnything's documented GUI point-grounding prompt template.
              { type: "text", text: `Point to: ${description}.` }
            ]
          }
        ],
        temperature: 0,
        max_tokens: 1_024,
        stream: false
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, MAX_ERROR_BODY_CHARS);
      throw new Error(`LocateAnything request failed (${response.status}): ${body || response.statusText || "unknown error"}`);
    }
    const payload = (await response.json()) as unknown;
    const answer = extractLocateAnythingAnswer(payload);
    const parsed = parseLocateAnythingAnswer(answer);
    const imageX = (parsed.normalizedX / 1_000) * screenshot.imageWidth;
    const imageY = (parsed.normalizedY / 1_000) * screenshot.imageHeight;
    return {
      ...parsed,
      imageX,
      imageY,
      viewportX: clampCoordinate((imageX / screenshot.imageWidth) * screenshot.viewportWidth, screenshot.viewportWidth),
      viewportY: clampCoordinate((imageY / screenshot.imageHeight) * screenshot.viewportHeight, screenshot.viewportHeight),
      rawAnswer: answer
    };
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof Error ? reason : new Error("LocateAnything request was cancelled.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    removeAbortLink();
  }
}

/**
 * Parses the official structured formats:
 *   <box><x><y></box>
 *   <box><x1><y1><x2><y2></box>
 *
 * A single box is converted to its center. Multiple results are deliberately rejected: an
 * autonomous click must not guess which matching control the model intended.
 */
export function parseLocateAnythingAnswer(answer: string): Pick<LocateAnythingPoint, "normalizedX" | "normalizedY" | "source"> {
  const text = answer.trim();
  if (!text || /<box>\s*(?:none|null)\s*<\/box>/i.test(text)) {
    throw new Error("LocateAnything did not find the requested target.");
  }

  const candidates: Array<{ normalizedX: number; normalizedY: number; source: "point" | "box-center" }> = [];
  const structuredPattern =
    /<(?:box|point)>\s*<(-?\d+(?:\.\d+)?)>\s*<(-?\d+(?:\.\d+)?)>(?:\s*<(-?\d+(?:\.\d+)?)>\s*<(-?\d+(?:\.\d+)?)>)?\s*<\/(?:box|point)>/gi;
  for (const match of text.matchAll(structuredPattern)) {
    const firstX = Number(match[1]);
    const firstY = Number(match[2]);
    if (match[3] !== undefined && match[4] !== undefined) {
      const secondX = Number(match[3]);
      const secondY = Number(match[4]);
      assertNormalizedBox(firstX, firstY, secondX, secondY);
      candidates.push({
        normalizedX: (firstX + secondX) / 2,
        normalizedY: (firstY + secondY) / 2,
        source: "box-center"
      });
    } else {
      assertNormalizedPoint(firstX, firstY);
      candidates.push({ normalizedX: firstX, normalizedY: firstY, source: "point" });
    }
  }

  // Some serving stacks render the same documented structure with comma-separated numbers.
  if (candidates.length === 0) {
    const commaPattern =
      /<(?:box|point)>\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?))?\s*<\/(?:box|point)>/gi;
    for (const match of text.matchAll(commaPattern)) {
      const firstX = Number(match[1]);
      const firstY = Number(match[2]);
      if (match[3] !== undefined && match[4] !== undefined) {
        const secondX = Number(match[3]);
        const secondY = Number(match[4]);
        assertNormalizedBox(firstX, firstY, secondX, secondY);
        candidates.push({
          normalizedX: (firstX + secondX) / 2,
          normalizedY: (firstY + secondY) / 2,
          source: "box-center"
        });
      } else {
        assertNormalizedPoint(firstX, firstY);
        candidates.push({ normalizedX: firstX, normalizedY: firstY, source: "point" });
      }
    }
  }

  const unique = candidates.filter(
    (candidate, index) =>
      candidates.findIndex((other) => other.normalizedX === candidate.normalizedX && other.normalizedY === candidate.normalizedY) === index
  );
  if (unique.length === 0) {
    throw new Error(`LocateAnything returned no parseable point: ${text.slice(0, 300)}`);
  }
  if (unique.length > 1) {
    throw new Error(`LocateAnything returned ${unique.length} possible targets; refusing an ambiguous click.`);
  }
  return unique[0];
}

export function extractLocateAnythingAnswer(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("LocateAnything returned an invalid response.");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.answer === "string" && record.answer.trim()) {
    return record.answer;
  }
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    throw new Error("LocateAnything response did not include an answer.");
  }
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("LocateAnything response did not include a message.");
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .flatMap((part) =>
        part && typeof part === "object" && !Array.isArray(part) && typeof (part as Record<string, unknown>).text === "string"
          ? [String((part as Record<string, unknown>).text)]
          : []
      )
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  throw new Error("LocateAnything message did not include text.");
}

type PlaywrightViewportState = {
  url: string;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
};

/**
 * The narrow structural subset of Playwright Page used by the harness. Keeping this interface
 * local lets Arivu ship the adapter without making Playwright a desktop runtime dependency.
 */
export type PlaywrightVisualPage = {
  url(): string;
  viewportSize(): { width: number; height: number } | null;
  screenshot(options: { type: "png"; fullPage: false; animations: "disabled"; caret: "hide"; scale: "css" }): Promise<Uint8Array>;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  mouse: {
    click(x: number, y: number): Promise<void>;
  };
};

export type PlaywrightVisualClickOptions = LocateAnythingRequestOptions & {
  locate?: typeof locateAnythingInViewport;
};

/**
 * Exact requested Playwright harness:
 * viewport screenshot -> LocateAnything -> CSS viewport point -> page.mouse.click(x, y).
 * It rechecks URL, viewport, and scroll position after inference so old pixels can never click
 * a page that moved while the grounding model was running.
 */
export async function locateAndClickWithPlaywright(
  page: PlaywrightVisualPage,
  config: BrowserVisualGroundingConfig,
  target: string,
  options: PlaywrightVisualClickOptions = {}
): Promise<LocateAnythingPoint> {
  const viewport = page.viewportSize();
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
    throw new Error("Playwright visual clicks require a page with a fixed viewport.");
  }
  const before = await readPlaywrightViewportState(page);
  const png = await page.screenshot({
    type: "png",
    fullPage: false,
    animations: "disabled",
    caret: "hide",
    scale: "css"
  });
  const locate = options.locate ?? locateAnythingInViewport;
  const point = await locate(
    config,
    {
      imageDataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
      imageWidth: viewport.width,
      imageHeight: viewport.height,
      viewportWidth: before.width,
      viewportHeight: before.height
    },
    target,
    { signal: options.signal, fetcher: options.fetcher }
  );
  const after = await readPlaywrightViewportState(page);
  assertViewportUnchanged(before, after);
  await page.mouse.click(point.viewportX, point.viewportY);
  return point;
}

function normalizeGroundingTarget(target: string): string {
  const normalized = target.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error("Visual grounding target is required.");
  }
  if (normalized.length > LOCATE_ANYTHING_MAX_TARGET_CHARS) {
    throw new Error(`Visual grounding target must be ${LOCATE_ANYTHING_MAX_TARGET_CHARS} characters or fewer.`);
  }
  return normalized.replace(/[.]+$/, "");
}

function assertScreenshotGeometry(screenshot: VisualViewportScreenshot) {
  if (!/^data:image\/(?:png|jpeg);base64,/.test(screenshot.imageDataUrl)) {
    throw new Error("Visual grounding requires a PNG or JPEG data URL.");
  }
  for (const [name, value] of Object.entries({
    imageWidth: screenshot.imageWidth,
    imageHeight: screenshot.imageHeight,
    viewportWidth: screenshot.viewportWidth,
    viewportHeight: screenshot.viewportHeight
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Visual grounding ${name} must be a positive number.`);
    }
  }
}

function assertNormalizedPoint(x: number, y: number) {
  if (![x, y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1_000)) {
    throw new Error(`LocateAnything returned coordinates outside its 0..1000 range: ${x}, ${y}.`);
  }
}

function assertNormalizedBox(x1: number, y1: number, x2: number, y2: number) {
  assertNormalizedPoint(x1, y1);
  assertNormalizedPoint(x2, y2);
  if (x2 < x1 || y2 < y1) {
    throw new Error(`LocateAnything returned an inverted box: ${x1}, ${y1}, ${x2}, ${y2}.`);
  }
}

function clampCoordinate(value: number, extent: number): number {
  return Math.max(0, Math.min(Math.max(0, extent - 1), value));
}

async function readPlaywrightViewportState(page: PlaywrightVisualPage): Promise<PlaywrightViewportState> {
  const state = await page.evaluate(() => ({
    url: window.location.href,
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY
  }));
  return { ...state, url: page.url() || state.url };
}

function assertViewportUnchanged(before: PlaywrightViewportState, after: PlaywrightViewportState) {
  const moved =
    before.url !== after.url ||
    before.width !== after.width ||
    before.height !== after.height ||
    Math.abs(before.scrollX - after.scrollX) > 1 ||
    Math.abs(before.scrollY - after.scrollY) > 1;
  if (moved) {
    throw new Error("The page URL, viewport, or scroll position changed during visual grounding; the stale coordinate was not clicked.");
  }
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) {
    return () => undefined;
  }
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}
