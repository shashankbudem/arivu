import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePath } from "../src/tools/pathSafety.js";

describe("path safety", () => {
  it("allows relative paths inside the workspace", () => {
    const root = path.resolve("/tmp/workspace");
    expect(resolveWorkspacePath(root, "src/index.ts")).toBe(path.join(root, "src/index.ts"));
  });

  it("rejects traversal outside the workspace", () => {
    expect(() => resolveWorkspacePath("/tmp/workspace", "../secret")).toThrow(/escapes workspace/);
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(() => resolveWorkspacePath("/tmp/workspace", "/etc/passwd")).toThrow(/escapes workspace/);
  });
});

