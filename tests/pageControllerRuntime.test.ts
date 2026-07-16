import { describe, expect, it } from "vitest";
import type { WebContents } from "electron";
import {
  __setPageControllerBundleTextForTests,
  clickElementByIndex,
  ensurePageControllerInjected,
  freshPageSnapshot,
  indexedPageState,
  inputTextByIndex,
  scrollPage,
  selectOptionByIndex
} from "../desktop/main/pageControllerRuntime.js";

// pageControllerRuntime resolves the real bundle relative to the built main.js output, which
// only exists after `desktop:main:build`. These tests run against unbundled TS source, so we
// preload a stand-in bundle instead of depending on that build step.
__setPageControllerBundleTextForTests("window.__ArivuPageControllerLib = { PageController: function () {} };");

function createFakeContents(behavior: (script: string) => unknown) {
  const scripts: string[] = [];
  let injected = false;
  const contents = {
    executeJavaScript: async (script: string) => {
      scripts.push(script);
      if (script.includes("!!window.__arivuPageController")) {
        return injected;
      }
      if (script.includes("window.__arivuPageController = new")) {
        injected = true;
        return undefined;
      }
      return behavior(script);
    }
  } as unknown as WebContents;
  return { contents, scripts };
}

describe("pageControllerRuntime", () => {
  it("injects the bundle once and reuses it on subsequent calls", async () => {
    const { contents, scripts } = createFakeContents(() => ({ ok: true, message: "clicked" }));

    expect(await ensurePageControllerInjected(contents)).toBe(true);
    expect(await ensurePageControllerInjected(contents)).toBe(true);

    const injectionCalls = scripts.filter((script) => script.includes("window.__arivuPageController = new"));
    expect(injectionCalls.length).toBe(1);
  });

  it("returns undefined from action helpers when injection fails", async () => {
    const contents = {
      executeJavaScript: async () => {
        throw new Error("context destroyed");
      }
    } as unknown as WebContents;

    expect(await clickElementByIndex(contents, 3)).toBeUndefined();
    expect(await inputTextByIndex(contents, 3, "hi")).toBeUndefined();
    expect(await selectOptionByIndex(contents, 3, "Option A")).toBeUndefined();
    expect(await scrollPage(contents, { horizontal: false })).toBeUndefined();
    expect(await indexedPageState(contents)).toBeUndefined();
  });

  it("clicks an element by index through the page controller", async () => {
    const { contents } = createFakeContents((script) => {
      expect(script).toContain("clickElement(3)");
      return { ok: true, message: "clicked index 3" };
    });

    const result = await clickElementByIndex(contents, 3);
    expect(result).toEqual({ ok: true, message: "clicked index 3" });
  });

  it("types text into an element by index through the page controller", async () => {
    const { contents } = createFakeContents((script) => {
      expect(script).toContain('inputText(2, "hello")');
      return { ok: true, message: "typed" };
    });

    const result = await inputTextByIndex(contents, 2, "hello");
    expect(result).toEqual({ ok: true, message: "typed" });
  });

  it("selects a dropdown option by index through the page controller", async () => {
    const { contents } = createFakeContents((script) => {
      expect(script).toContain('selectOption(1, "Option B")');
      return { ok: true, message: "selected" };
    });

    const result = await selectOptionByIndex(contents, 1, "Option B");
    expect(result).toEqual({ ok: true, message: "selected" });
  });

  it("scrolls vertically and horizontally through the page controller", async () => {
    const { contents: verticalContents } = createFakeContents((script) => {
      expect(script).toContain("scroll(");
      return { ok: true, message: "scrolled down" };
    });
    expect(await scrollPage(verticalContents, { horizontal: false, down: true, numPages: 1 })).toEqual({
      ok: true,
      message: "scrolled down"
    });

    const { contents: horizontalContents } = createFakeContents((script) => {
      expect(script).toContain("scrollHorizontally(");
      return { ok: true, message: "scrolled right" };
    });
    expect(await scrollPage(horizontalContents, { horizontal: true, right: true, pixels: 200 })).toEqual({
      ok: true,
      message: "scrolled right"
    });
  });

  it("reports failed indexed actions without throwing", async () => {
    const { contents } = createFakeContents(() => {
      throw new Error("No interactive element found at index 9");
    });

    const result = await clickElementByIndex(contents, 9);
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain("No interactive element found at index 9");
  });

  it("builds a bounded post-action snapshot from the page state", async () => {
    const { contents } = createFakeContents((script) => {
      expect(script).toContain("getBrowserState");
      return { content: "[1]<button>Save</button>", url: "http://example.test/", title: "Example" };
    });

    const result = await freshPageSnapshot(contents);
    expect(result).toEqual({ snapshotAfter: "[1]<button>Save</button>" });
    expect(result?.snapshotAfterTruncated).toBeUndefined();
  });

  it("flags the post-action snapshot as truncated when the page state is oversized", async () => {
    const huge = `HEAD-CONTROLS\n${"x".repeat(30_000)}\nTAIL-FORM-CONTROLS`;
    const { contents } = createFakeContents((script) => {
      if (script.includes("getBrowserState")) {
        return { content: huge, url: "http://example.test/", title: "Example" };
      }
      return undefined;
    });

    const result = await freshPageSnapshot(contents);
    expect(result?.snapshotAfterTruncated).toBe(true);
    expect(result?.snapshotAfter).toContain("...middle truncated; final page controls preserved...");
    expect(result?.snapshotAfter).toContain("HEAD-CONTROLS");
    expect(result?.snapshotAfter).toContain("TAIL-FORM-CONTROLS");
    expect(result?.snapshotAfter.length ?? 0).toBeLessThan(huge.length);
  });

  it("returns undefined for the post-action snapshot when the page can't be read", async () => {
    const contents = {
      executeJavaScript: async () => {
        throw new Error("context destroyed");
      }
    } as unknown as WebContents;

    expect(await freshPageSnapshot(contents)).toBeUndefined();
  });
});
