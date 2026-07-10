import { describe, expect, it } from "vitest";
import { basename, capitalize, clamp, formatBytes, formatDurationMs, formatError } from "../desktop/renderer/src/format.js";

describe("renderer format helpers", () => {
  it("formats errors from Error and non-Error values", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
    expect(formatError("plain")).toBe("plain");
    expect(formatError(42)).toBe("42");
  });

  it("extracts the basename across path separators", () => {
    expect(basename("/a/b/c.ts")).toBe("c.ts");
    expect(basename("a\\b\\c.ts")).toBe("c.ts");
    expect(basename("solo")).toBe("solo");
  });

  it("formats durations by magnitude", () => {
    expect(formatDurationMs(500)).toBe("500 ms");
    expect(formatDurationMs(2_500)).toBe("2.5s");
    expect(formatDurationMs(65_000)).toBe("1m 5s");
  });

  it("formats byte sizes in MB", () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe("2 MB");
  });

  it("clamps and capitalizes", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
    expect(capitalize("hello")).toBe("Hello");
  });
});
