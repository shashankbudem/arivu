import { describe, expect, it, vi } from "vitest";
import {
  extractLocateAnythingAnswer,
  locateAndClickWithPlaywright,
  locateAnythingInViewport,
  parseLocateAnythingAnswer,
  type LocateAnythingPoint,
  type PlaywrightVisualPage
} from "../src/browser/locateAnythingHarness.js";
import type { BrowserVisualGroundingConfig } from "../src/tools/browserControl.js";

const CONFIG: BrowserVisualGroundingConfig = {
  baseUrl: "http://127.0.0.1:8000/v1",
  model: "nvidia/LocateAnything-3B",
  apiKey: "test-key",
  timeoutMs: 5_000
};

describe("LocateAnything grounding harness", () => {
  it("parses the official point and box formats", () => {
    expect(parseLocateAnythingAnswer("<ref>Search</ref><box><250><750></box>")).toEqual({
      normalizedX: 250,
      normalizedY: 750,
      source: "point"
    });
    expect(parseLocateAnythingAnswer("<ref>Search</ref><box><100><200><500><600></box>")).toEqual({
      normalizedX: 300,
      normalizedY: 400,
      source: "box-center"
    });
  });

  it("accepts comma-formatted serving output", () => {
    expect(parseLocateAnythingAnswer("<box> 100, 200, 300, 400 </box>")).toEqual({
      normalizedX: 200,
      normalizedY: 300,
      source: "box-center"
    });
  });

  it("refuses misses, invalid ranges, and ambiguous points", () => {
    expect(() => parseLocateAnythingAnswer("<box>none</box>")).toThrow(/did not find/i);
    expect(() => parseLocateAnythingAnswer("<box><1001><20></box>")).toThrow(/outside/i);
    expect(() => parseLocateAnythingAnswer("<box><100><200></box><box><800><900></box>")).toThrow(/ambiguous/i);
  });

  it("extracts both worker and OpenAI-compatible responses", () => {
    expect(extractLocateAnythingAnswer({ answer: "<box><10><20></box>" })).toBe("<box><10><20></box>");
    expect(
      extractLocateAnythingAnswer({
        choices: [{ message: { content: [{ type: "text", text: "<box><30><40></box>" }] } }]
      })
    ).toBe("<box><30><40></box>");
  });

  it("sends the official GUI prompt and maps normalized image pixels into viewport coordinates", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ content: Array<{ type: string; text?: string }> }>;
      };
      expect(body.model).toBe("nvidia/LocateAnything-3B");
      expect(body.messages[0].content.at(-1)).toEqual({ type: "text", text: "Point to: the blue Search button." });
      return new Response(JSON.stringify({ choices: [{ message: { content: "<box><250><500></box>" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const point = await locateAnythingInViewport(
      CONFIG,
      {
        imageDataUrl: "data:image/png;base64,AA==",
        imageWidth: 800,
        imageHeight: 600,
        viewportWidth: 400,
        viewportHeight: 300
      },
      "the blue Search button",
      { fetcher: fetcher as typeof fetch }
    );

    expect(point).toMatchObject({
      normalizedX: 250,
      normalizedY: 500,
      imageX: 200,
      imageY: 300,
      viewportX: 100,
      viewportY: 150
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer test-key" })
      })
    );
  });

  it("runs the exact Playwright viewport screenshot -> grounding -> mouse.click flow", async () => {
    const state = { url: "https://example.test/form", width: 900, height: 700, scrollX: 0, scrollY: 40 };
    const mouseClick = vi.fn(async () => undefined);
    const page = {
      url: () => state.url,
      viewportSize: () => ({ width: 900, height: 700 }),
      screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
      evaluate: vi.fn(async () => ({ ...state })),
      mouse: { click: mouseClick }
    } as unknown as PlaywrightVisualPage;
    const grounded: LocateAnythingPoint = {
      normalizedX: 400,
      normalizedY: 300,
      imageX: 360,
      imageY: 210,
      viewportX: 360,
      viewportY: 210,
      source: "point",
      rawAnswer: "<box><400><300></box>"
    };
    const locate = vi.fn(async () => grounded);

    const result = await locateAndClickWithPlaywright(page, CONFIG, "Save", { locate });

    expect(page.screenshot).toHaveBeenCalledWith({
      type: "png",
      fullPage: false,
      animations: "disabled",
      caret: "hide",
      scale: "css"
    });
    expect(locate).toHaveBeenCalledWith(
      CONFIG,
      expect.objectContaining({
        imageDataUrl: "data:image/png;base64,AQID",
        imageWidth: 900,
        imageHeight: 700,
        viewportWidth: 900,
        viewportHeight: 700
      }),
      "Save",
      expect.any(Object)
    );
    expect(mouseClick).toHaveBeenCalledWith(360, 210);
    expect(result).toBe(grounded);
  });

  it("does not click when the Playwright page moves during inference", async () => {
    const mouseClick = vi.fn(async () => undefined);
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ url: "https://example.test", width: 900, height: 700, scrollX: 0, scrollY: 0 })
      .mockResolvedValueOnce({ url: "https://example.test", width: 900, height: 700, scrollX: 0, scrollY: 200 });
    const page = {
      url: () => "https://example.test",
      viewportSize: () => ({ width: 900, height: 700 }),
      screenshot: vi.fn(async () => new Uint8Array([1])),
      evaluate,
      mouse: { click: mouseClick }
    } as unknown as PlaywrightVisualPage;
    const locate = vi.fn(async () => ({
      normalizedX: 500,
      normalizedY: 500,
      imageX: 450,
      imageY: 350,
      viewportX: 450,
      viewportY: 350,
      source: "point" as const,
      rawAnswer: "<box><500><500></box>"
    }));

    await expect(locateAndClickWithPlaywright(page, CONFIG, "Save", { locate })).rejects.toThrow(/stale coordinate/i);
    expect(mouseClick).not.toHaveBeenCalled();
  });
});
