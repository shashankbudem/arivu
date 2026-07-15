import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebContents } from "electron";

/**
 * Lazily injects the standalone page-controller bundle (DOM indexing + element actions,
 * without the LLM loop) into a tab for the manual browser_* tools, backporting page-agent's
 * indexed element targeting and W3C pointer-sequence clicks. Re-injected once per page load
 * (checked via a page-side global) since navigation destroys the JS context.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PAGE_CONTROLLER_BUNDLE_PATH = path.resolve(currentDir, "../pageControllerBundle/page-controller.iife.js");
const MAX_INDEXED_CONTENT_LENGTH = 4_000;

let cachedBundleText: string | undefined;

async function loadPageControllerBundle(): Promise<string> {
  if (cachedBundleText === undefined) {
    cachedBundleText = await readFile(PAGE_CONTROLLER_BUNDLE_PATH, "utf8");
  }
  return cachedBundleText;
}

/** Test-only seam, mirrors browserTaskSupervisor's __setPageAgentBundleTextForTests. */
export function __setPageControllerBundleTextForTests(text: string | undefined): void {
  cachedBundleText = text;
}

export async function ensurePageControllerInjected(contents: WebContents): Promise<boolean> {
  try {
    const alreadyPresent = await contents.executeJavaScript("!!window.__arivuPageController", true);
    if (alreadyPresent) {
      return true;
    }
    const bundleText = await loadPageControllerBundle();
    await contents.executeJavaScript(
      `(function() {
${bundleText}
window.__arivuPageController = new window.__ArivuPageControllerLib.PageController({ enableMask: false });
})()`,
      true
    );
    return true;
  } catch {
    return false;
  }
}

export async function clickElementByIndex(contents: WebContents, index: number): Promise<{ ok: boolean; message: string } | undefined> {
  if (!(await ensurePageControllerInjected(contents))) {
    return undefined;
  }
  return runIndexedAction(contents, `window.__arivuPageController.clickElement(${JSON.stringify(index)})`);
}

export async function inputTextByIndex(
  contents: WebContents,
  index: number,
  text: string
): Promise<{ ok: boolean; message: string } | undefined> {
  if (!(await ensurePageControllerInjected(contents))) {
    return undefined;
  }
  return runIndexedAction(contents, `window.__arivuPageController.inputText(${JSON.stringify(index)}, ${JSON.stringify(text)})`);
}

export async function selectOptionByIndex(
  contents: WebContents,
  index: number,
  optionText: string
): Promise<{ ok: boolean; message: string } | undefined> {
  if (!(await ensurePageControllerInjected(contents))) {
    return undefined;
  }
  return runIndexedAction(contents, `window.__arivuPageController.selectOption(${JSON.stringify(index)}, ${JSON.stringify(optionText)})`);
}

export async function scrollPage(
  contents: WebContents,
  options: { down?: boolean; right?: boolean; horizontal: boolean; numPages?: number; pixels?: number; index?: number }
): Promise<{ ok: boolean; message: string } | undefined> {
  if (!(await ensurePageControllerInjected(contents))) {
    return undefined;
  }
  const call = options.horizontal
    ? `window.__arivuPageController.scrollHorizontally(${JSON.stringify({ right: options.right ?? true, pixels: options.pixels ?? 400, index: options.index })})`
    : `window.__arivuPageController.scroll(${JSON.stringify({ down: options.down ?? true, numPages: options.numPages, pixels: options.pixels, index: options.index })})`;
  return runIndexedAction(contents, call);
}

async function runIndexedAction(contents: WebContents, expression: string): Promise<{ ok: boolean; message: string }> {
  try {
    const result = (await contents.executeJavaScript(
      `(function() {
        return (${expression}).then(function(r) { return { ok: !!(r && r.success), message: (r && r.message) || "" }; });
      })()`,
      true
    )) as { ok: boolean; message: string } | undefined;
    return result ?? { ok: false, message: "No result returned." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function indexedPageState(contents: WebContents): Promise<{ content: string; url: string; title: string } | undefined> {
  if (!(await ensurePageControllerInjected(contents))) {
    return undefined;
  }
  try {
    const result = (await contents.executeJavaScript(
      `(function() {
        return window.__arivuPageController.getBrowserState().then(function(s) {
          return { content: (s.header || "") + "\\n" + (s.content || "") + "\\n" + (s.footer || ""), url: s.url, title: s.title };
        });
      })()`,
      true
    )) as { content: string; url: string; title: string } | undefined;
    return result;
  } catch {
    return undefined;
  }
}

export function boundIndexedContent(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_INDEXED_CONTENT_LENGTH) {
    return { text: content, truncated: false };
  }
  return { text: `${content.slice(0, MAX_INDEXED_CONTENT_LENGTH)}\n...truncated...`, truncated: true };
}

/**
 * Computes the bounded post-action page snapshot that browser action tools attach to their
 * results as `snapshotAfter`, so the main agent can verify an action's effect from text
 * without spending another turn on a heavier browser_screenshot. Returns undefined when the
 * page-controller can't read the page (e.g. right after a cross-document navigation destroys
 * the JS context), so callers leave their result untouched rather than fabricating state.
 */
export async function freshPageSnapshot(
  contents: WebContents
): Promise<{ snapshotAfter: string; snapshotAfterTruncated?: true } | undefined> {
  const indexed = await indexedPageState(contents).catch(() => undefined);
  if (!indexed) {
    return undefined;
  }
  const bounded = boundIndexedContent(indexed.content);
  return bounded.truncated ? { snapshotAfter: bounded.text, snapshotAfterTruncated: true } : { snapshotAfter: bounded.text };
}
