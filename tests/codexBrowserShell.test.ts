import { describe, expect, it } from "vitest";
import { codexBrowserShellHtml } from "../desktop/main/codexBrowserShell.js";

describe("Codex-style browser shell", () => {
  const html = codexBrowserShellHtml({ defaultChromeHeight: 80 });

  it("includes the core Codex browser controls and collaboration surfaces", () => {
    for (const label of [
      "Browser tabs",
      "Show all tabs",
      "New tab",
      "Back",
      "Forward",
      "Reload",
      "Address and search bar",
      "View site information",
      "Open in external browser",
      "Take a screenshot",
      "Downloads",
      "Browser options",
      "Find in page",
      "Device preset",
      "Rotate viewport",
      "Review and comment",
      "Send to Arivu",
      "Design adjustments"
    ]) {
      expect(html).toContain(label);
    }
  });

  it("declares keyboard shortcuts, tab reordering, and dynamic chrome layout reporting", () => {
    expect(html).toContain('key.toLowerCase()==="l"');
    expect(html).toContain('key.toLowerCase()==="t"');
    expect(html).toContain('send("reorder-tab"');
    expect(html).toContain('send("cycle-tab"');
    expect(html).toContain('send("layout",{height})');
    expect(html).toContain('send("annotation-mode"');
    expect(html).toContain('send("annotation-send"');
    expect(html).toContain('"adopt-agent-tab":"send-tab-to-agent"');
    expect(html).toContain("prefers-reduced-motion:reduce");
    expect(html).toContain("forced-colors:active");
    expect(html).toContain("prefers-color-scheme:light");
  });

  it("emits syntactically valid inline JavaScript", () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0])).not.toThrow();
  });
});
