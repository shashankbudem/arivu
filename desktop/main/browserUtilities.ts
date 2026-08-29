import { existsSync } from "node:fs";
import path from "node:path";
import type { WebContents, WebFrameMain, WebPreferences } from "electron";
import {
  normalizeBrowserUrl,
  type BrowserConsoleEntry,
  type BrowserMode,
  type BrowserTabState,
  type BrowserTargetState,
  type BrowserToolResult
} from "../../src/tools/browserControl.js";
import type { BrowserFrameInspection, BrowserFrameMeta, BrowserTargetRecord, BrowserVisualViewportState } from "./browserTypes.js";

const BROWSER_PARTITION = "persist:arivu-browser";

/**
 * Keeps elements (in document order, so earlier/on-screen elements win) until their combined
 * serialized size reaches the budget. Element index positions stay stable for the kept prefix.
 */
export function capElementsBySerializedSize<T>(elements: T[], budgetChars: number): T[] {
  let used = 0;
  let kept = 0;
  for (const element of elements) {
    used += JSON.stringify(element).length + 1;
    if (used > budgetChars) {
      break;
    }
    kept += 1;
  }
  return kept === elements.length ? elements : elements.slice(0, kept);
}

export function initialTarget(mode: BrowserMode, id: string = mode): BrowserTargetRecord {
  return {
    id,
    mode,
    url: "",
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    owner: mode === "background" ? "agent" : "user",
    logs: []
  };
}

export function publicTab(target: BrowserTargetRecord): BrowserTabState {
  return {
    id: target.id,
    url: target.url,
    title: target.title,
    ...(target.faviconUrl ? { faviconUrl: target.faviconUrl } : {}),
    loading: target.loading,
    canGoBack: target.canGoBack,
    canGoForward: target.canGoForward,
    owner: target.owner,
    ...(target.lastError ? { lastError: target.lastError } : {}),
    ...(target.lastSnapshotAt ? { lastSnapshotAt: target.lastSnapshotAt } : {}),
    ...(target.lastScreenshotAt ? { lastScreenshotAt: target.lastScreenshotAt } : {}),
    ...(target.lastScreenshotPath ? { lastScreenshotPath: target.lastScreenshotPath } : {})
  };
}

export function publicTarget(target: BrowserTargetRecord): BrowserTargetState {
  return { ...publicTab(target), mode: target.mode };
}

export function humanizePermission(permission: string): string {
  return permission
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .toLowerCase();
}

export function browserPermissionKey(origin: string, permission: string) {
  let normalizedOrigin = origin;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    // Preserve Chromium's requesting-origin value if it is not a standard URL.
  }
  return `${normalizedOrigin}|${permission}`;
}

export function browserWebPreferences(mode: BrowserMode): WebPreferences {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    offscreen: mode === "background",
    partition: BROWSER_PARTITION
  };
}

export function assertAllowedPopupUrl(url: string) {
  if (url === "about:blank" || url.startsWith("about:blank#") || url.startsWith("about:blank?")) {
    return;
  }
  normalizeBrowserUrl(url);
}

export function browserShellWebPreferences(): WebPreferences {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true
  };
}

export function normalizeConsoleLevel(level: unknown): BrowserConsoleEntry["level"] {
  if (level === "error" || level === 3) {
    return "error";
  }
  if (level === "warning" || level === "warn" || level === 2) {
    return "warning";
  }
  if (level === "debug" || level === "verbose" || level === 0) {
    return "debug";
  }
  return "info";
}

export function assertPageLoaded(contents: WebContents, mode: BrowserMode) {
  if (!contents.getURL()) {
    throw new Error(`The ${mode} browser has not opened a page yet.`);
  }
}

export function isNavigationAbortError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ERR_ABORTED") || message.includes("(-3)");
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function isRestorableBrowserUrl(value: string) {
  if (value === "") {
    return true;
  }
  try {
    return ["http:", "https:", "file:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function availableDownloadPath(directory: string, filename: string) {
  const safeFilename = path.basename(filename) || "download";
  const extension = path.extname(safeFilename);
  const stem = path.basename(safeFilename, extension);
  let candidate = path.join(directory, safeFilename);
  for (let suffix = 1; suffix < 10_000 && existsSync(candidate); suffix += 1) {
    candidate = path.join(directory, `${stem} (${suffix})${extension}`);
  }
  return candidate;
}

export function frameList(contents: WebContents) {
  const frames = contents.mainFrame.framesInSubtree;
  return frames.length > 0 ? frames : [contents.mainFrame];
}

export function frameInfo(frame: WebFrameMain, mainFrame: WebFrameMain, index: number) {
  return {
    index,
    url: frame.url,
    name: frame.name || undefined,
    origin: frame.origin,
    mainFrame: frame === mainFrame
  };
}

export function mergeSnapshotText(parts: string[], maxLength: number) {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of parts) {
    const normalized = part.replace(/\n{3,}/g, "\n\n").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged.join("\n\n").slice(0, maxLength);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isSuccessfulFrameInspection(
  frame: BrowserFrameInspection
): frame is BrowserFrameMeta & { ok: true; snapshot: BrowserToolResult } {
  return frame.ok && isRecord(frame.snapshot);
}

export function axPropertyValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (isRecord(value)) {
    const nestedValue = value.value;
    if (typeof nestedValue === "string" || typeof nestedValue === "number" || typeof nestedValue === "boolean") {
      return String(nestedValue);
    }
  }
  return "";
}

export function assertBrowserVisualViewportUnchanged(before: BrowserVisualViewportState, after: BrowserVisualViewportState) {
  const changed =
    before.url !== after.url ||
    before.width !== after.width ||
    before.height !== after.height ||
    Math.abs(before.scrollX - after.scrollX) > 1 ||
    Math.abs(before.scrollY - after.scrollY) > 1 ||
    before.frameSignature !== after.frameSignature;
  if (changed) {
    throw new Error(
      "The page URL, frame tree, viewport, or scroll position changed during visual grounding; the stale coordinate was not clicked."
    );
  }
}
