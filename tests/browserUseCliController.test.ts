import { describe, expect, it } from "vitest";
import {
  BrowserUseCliController,
  browserUseSessionName,
  parseBrowserUseOutput,
  type BrowserUseCliRunRequest,
  type BrowserUseCliRunResult
} from "../src/browser/browserUseCliController.js";

const sentinel = "__ARIVU_BROWSER_USE_JSON__";

function response(payload: Record<string, unknown>, extra = ""): BrowserUseCliRunResult {
  return { stdout: `${extra}${sentinel}${JSON.stringify(payload)}\n`, stderr: "", exitCode: 0 };
}

function fakeRunner(...results: BrowserUseCliRunResult[]) {
  const calls: BrowserUseCliRunRequest[] = [];
  return {
    calls,
    runner: async (request: BrowserUseCliRunRequest) => {
      calls.push(request);
      const result = results.shift();
      if (!result) throw new Error("Unexpected browser-use invocation");
      return result;
    }
  };
}

const state = {
  page: { url: "https://example.test/", title: "Example", w: 300, h: 150 },
  currentTab: { targetId: "current", url: "https://example.test/", title: "Example" },
  tabs: [{ targetId: "current", url: "https://example.test/", title: "Example" }]
};

describe("BrowserUseCliController", () => {
  it("uses a stable, collision-resistant BU_NAME for each Arivu session", async () => {
    const first = fakeRunner(response(state));
    const second = fakeRunner(response(state));
    const a = new BrowserUseCliController({ sessionId: "Chat / 1", runner: first.runner });
    const b = new BrowserUseCliController({ sessionId: "chat-1", runner: second.runner });

    await a.open({ url: "example.test" });
    await b.open({ url: "example.test" });

    expect(a.sessionName).toMatch(/^arivu-[a-f0-9]{12}$/);
    expect(a.sessionName).not.toBe(b.sessionName);
    expect(first.calls[0]?.env.BU_NAME).toBe(a.sessionName);
    expect(second.calls[0]?.env.BU_NAME).toBe(b.sessionName);
    expect(browserUseSessionName("Chat / 1")).toBe(a.sessionName);
  });

  it("parses the explicit final sentinel and rejects malformed CLI output", () => {
    expect(parseBrowserUseOutput(`debug line\n${sentinel}{"ok":true}\n`)).toEqual({ ok: true });
    expect(parseBrowserUseOutput(`${sentinel}not-json\n`)).toBeUndefined();
    expect(parseBrowserUseOutput("ordinary output\n")).toBeUndefined();
  });

  it("normalizes search input and opens it in a new harness tab", async () => {
    const fake = fakeRunner(response(state));
    const controller = new BrowserUseCliController({ sessionId: "open", runner: fake.runner });

    await controller.open({ url: "latest browser harness", newTab: true });

    expect(fake.calls[0]?.script).toContain('new_tab("https://www.google.com/search?q=latest+browser+harness")');
    expect(fake.calls[0]?.script).toContain("wait_for_load()");
  });

  it("opens a new tab for agent navigation when no tab was selected", async () => {
    const fake = fakeRunner(response(state));
    const controller = new BrowserUseCliController({ sessionId: "protect-user-tab", runner: fake.runner });

    const result = await controller.open({ url: "example.test", source: "agent" });

    expect(fake.calls[0]?.script).toContain('new_tab("https://example.test/")');
    expect(result).toMatchObject({ newTab: true, mode: "visible" });
  });

  it("maps image coordinates through the prior screenshot dimensions before clicking", async () => {
    const fake = fakeRunner(response({ ...state, screenshotPath: "/tmp/shot.png", size: { width: 600, height: 300 } }), response(state));
    const controller = new BrowserUseCliController({ sessionId: "coordinates", runner: fake.runner, tempDirectory: "/tmp" });

    await controller.screenshot({});
    const result = await controller.clickAt({ x: 200, y: 100, coordinateSpace: "image" });

    expect(fake.calls[1]?.script).toContain("click_at_xy(100, 50)");
    expect(result).toMatchObject({ x: 100, y: 50, coordinateSpace: "css" });
  });

  it("keeps browser-state element indexes and uses them for direct clicks", async () => {
    const fake = fakeRunner(
      response({ ...state, text: "Approve this change", elements: [{ index: 7, role: "button", name: "Approve", x: 240, y: 64 }] }),
      response(state)
    );
    const controller = new BrowserUseCliController({ sessionId: "elements", runner: fake.runner });

    const snapshot = await controller.snapshot({});
    await controller.click({ index: 7 });

    expect((snapshot.snapshot as { elements: Array<{ index: number }> }).elements).toEqual([
      { index: 7, role: "button", name: "Approve", x: 240, y: 64 }
    ]);
    expect(fake.calls[1]?.script).toContain("click_at_xy(240, 64)");
  });

  it("emits Python boolean literals in direct action snippets", async () => {
    const fake = fakeRunner(
      response({ ...state, elements: [{ index: 7, role: "textbox", name: "Name", x: 120, y: 64 }] }),
      response(state),
      response(state),
      response(state),
      response({ ...state, result: "done" })
    );
    const controller = new BrowserUseCliController({ sessionId: "python-literals", runner: fake.runner });

    await controller.snapshot({});
    await controller.click({ index: 7 });
    await controller.type({ index: 7, text: "Arivu" });
    await controller.scroll({ direction: "down" });
    await controller.executeJavaScript({ script: "return 'done';" });

    for (const call of fake.calls.slice(1)) {
      expect(call.script).toContain('"ok": True');
      expect(call.script).not.toContain('"ok": true');
    }
  });

  it("clears old element indexes when the next snapshot has no interactive elements", async () => {
    const fake = fakeRunner(
      response({ ...state, text: "Approve this change", elements: [{ index: 7, role: "button", name: "Approve", x: 240, y: 64 }] }),
      response({ ...state, text: "No actions", elements: [] })
    );
    const controller = new BrowserUseCliController({ sessionId: "stale-elements", runner: fake.runner });

    await controller.snapshot({});
    await controller.snapshot({});

    await expect(controller.click({ index: 7 })).rejects.toThrow(/Unknown browser element index 7/);
  });

  it("turns an unavailable executable into an actionable error", async () => {
    const unavailable = Object.assign(new Error("spawn browser-use ENOENT"), { code: "ENOENT" });
    const controller = new BrowserUseCliController({ sessionId: "missing", runner: async () => Promise.reject(unavailable) });

    await expect(controller.open({ url: "example.test" })).rejects.toThrow(/Browser Use CLI is unavailable/);
  });

  it("does not start a nested Browser Use agent for browser tasks", async () => {
    const controller = new BrowserUseCliController({ sessionId: "direct-only", runner: async () => response(state) });

    await expect(
      controller.task({ instruction: "Complete checkout", modelConfig: { baseUrl: "https://example.test/v1", model: "test-model" } })
    ).rejects.toThrow(/browser_task is unavailable in TUI\/CLI Browser Use sessions/);
  });
});
