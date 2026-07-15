import path from "node:path";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { resolveSafeWorkspacePath, resolveWorkspacePath } from "../src/tools/pathSafety.js";

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

  it("rejects paths that escape through workspace symlinks", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-path-"));
    try {
      const workspace = path.join(tempDir, "workspace");
      const outside = path.join(tempDir, "outside");
      await mkdir(workspace);
      await mkdir(outside);
      await symlink(outside, path.join(workspace, "link"));

      await expect(resolveSafeWorkspacePath(workspace, "link/secret.txt")).rejects.toThrow(/symlink/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
