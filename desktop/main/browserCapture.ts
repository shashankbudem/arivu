import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { nativeImage, type WebContents } from "electron";
import type { BrowserToolResult } from "../../src/tools/browserControl.js";

const NATIVE_CAPTURE_TIMEOUT_MS = 2_500;

// Both manual (browser_screenshot) and automatic failure-recovery captures land in the same
// directory with no other lifecycle management, so they accumulate indefinitely. Age-based
// (not count-based): these are point-in-time debugging/recovery artifacts whose usefulness
// fades with how old they are, not with how many have piled up since. Scoped by the shared
// "arivu-browser-" prefix (covers both "arivu-browser-<mode>-..." and its
// "arivu-browser-task-failure-<mode>-..." variant) so it only ever touches files this app wrote.
const SCREENSHOT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // ~3 months
const BROWSER_SCREENSHOT_PREFIX = "arivu-browser-";

export async function pruneOldBrowserScreenshots(dir: string, maxAgeMs = SCREENSHOT_MAX_AGE_MS): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const cutoffMs = Date.now() - maxAgeMs;
  const candidates = entries.filter((name) => name.startsWith(BROWSER_SCREENSHOT_PREFIX) && name.endsWith(".png"));
  await Promise.all(
    candidates.map(async (name) => {
      const full = path.join(dir, name);
      try {
        const info = await stat(full);
        if (info.mtimeMs < cutoffMs) {
          await unlink(full);
        }
      } catch {
        // Already gone, or racing a concurrent write/prune for the same file — either way, nothing to do.
      }
    })
  );
}

export async function waitForFreshPaint(contents: WebContents) {
  await waitForLoadToStop(contents);
  try {
    return (await contents.executeJavaScript(freshPaintScript(), true)) as BrowserToolResult;
  } catch (error) {
    await delay(180);
    return {
      ok: false,
      reason: "paint-wait-failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function waitForLoadToStop(contents: WebContents) {
  if (!contents.isLoading()) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, 2_000);
    const onStopLoading = () => done();
    const onFailLoad = () => done();
    function done() {
      clearTimeout(timeout);
      contents.off("did-stop-loading", onStopLoading);
      contents.off("did-fail-load", onFailLoad);
      resolve();
    }
    contents.once("did-stop-loading", onStopLoading);
    contents.once("did-fail-load", onFailLoad);
  });
}

export async function capturePageWithDebugger(contents: WebContents, captureBeyondViewport = false) {
  const debuggerApi = contents.debugger;
  const wasAttached = debuggerApi.isAttached();
  try {
    if (!wasAttached) {
      debuggerApi.attach("1.3");
    }
    const result = (await Promise.race([
      debuggerApi.sendCommand("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport
      }),
      delay(3_000).then(() => {
        throw new Error("CDP screenshot capture timed out.");
      })
    ])) as BrowserToolResult;
    const data = typeof result.data === "string" ? result.data : "";
    if (!data) {
      return undefined;
    }
    return nativeImage.createFromBuffer(Buffer.from(data, "base64"));
  } catch {
    return undefined;
  } finally {
    if (!wasAttached && debuggerApi.isAttached()) {
      debuggerApi.detach();
    }
  }
}

export async function capturePageWithTimeout(contents: WebContents) {
  return Promise.race([
    contents.capturePage(),
    delay(NATIVE_CAPTURE_TIMEOUT_MS).then(() => {
      throw new Error(`Native screenshot capture timed out after ${NATIVE_CAPTURE_TIMEOUT_MS}ms.`);
    })
  ]);
}

function freshPaintScript() {
  return `(() => new Promise((resolve) => {
    const startedAt = performance.now();
    const minWaitMs = 500;
    const quietMs = 120;
    const timeoutMs = 1500;
    let lastMutationAt = startedAt;
    let frameCount = 0;
    let completed = false;
    const observer = new MutationObserver(() => {
      lastMutationAt = performance.now();
      frameCount = 0;
    });
    const complete = (reason) => {
      if (completed) {
        return;
      }
      completed = true;
      observer.disconnect();
      clearTimeout(timeout);
      resolve({
        ok: reason === "stable",
        reason,
        elapsedMs: Math.round(performance.now() - startedAt),
        frameCount
      });
    };
    const timeout = setTimeout(() => complete("timeout"), timeoutMs);
    try {
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      });
    } catch {}
    const scheduleFrame = (callback) => {
      let called = false;
      const finish = () => {
        if (called) {
          return;
        }
        called = true;
        clearTimeout(fallback);
        callback();
      };
      const fallback = setTimeout(finish, 80);
      requestAnimationFrame(finish);
    };
    const tick = () => {
      scheduleFrame(() => {
        frameCount += 1;
        const now = performance.now();
        if (now - startedAt >= minWaitMs && now - lastMutationAt >= quietMs && frameCount >= 3) {
          complete("stable");
          return;
        }
        tick();
      });
    };
    const fonts = document.fonts?.ready && typeof document.fonts.ready.then === "function" ? document.fonts.ready : Promise.resolve();
    fonts.catch(() => undefined).finally(tick);
  }))()`;
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
