import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isExternalHttpUrl, isTrustedAppNavigationUrl } from "../desktop/main/navigationSafety.js";

describe("desktop navigation safety", () => {
  it("trusts only the configured dev origin in development", () => {
    const options = {
      devUrl: "http://127.0.0.1:5173",
      rendererIndex: "/app/index.html"
    };

    expect(isTrustedAppNavigationUrl("http://127.0.0.1:5173/settings", options)).toBe(true);
    expect(isTrustedAppNavigationUrl("https://example.com", options)).toBe(false);
  });

  it("trusts only the packaged renderer file in production", () => {
    const rendererIndex = path.resolve("/app/renderer/index.html");
    const options = { rendererIndex };

    expect(isTrustedAppNavigationUrl(pathToFileURL(rendererIndex).toString(), options)).toBe(true);
    expect(isTrustedAppNavigationUrl(pathToFileURL(path.resolve("/app/renderer/other.html")).toString(), options)).toBe(false);
    expect(isExternalHttpUrl("https://example.com")).toBe(true);
    expect(isExternalHttpUrl("file:///tmp/example.html")).toBe(false);
  });
});
