import { describe, expect, it } from "vitest";
import { isDestructiveCommand } from "../src/permissions/destructive.js";

describe("destructive command detection", () => {
  it("detects high-risk commands", () => {
    expect(isDestructiveCommand("rm -rf dist")).toBe(true);
    expect(isDestructiveCommand("rm -R dist")).toBe(true);
    expect(isDestructiveCommand("rm -fR dist")).toBe(true);
    expect(isDestructiveCommand("git reset --hard")).toBe(true);
    expect(isDestructiveCommand("git clean -fd")).toBe(true);
    expect(isDestructiveCommand("chmod -R 777 .")).toBe(true);
  });

  it("allows ordinary commands", () => {
    expect(isDestructiveCommand("npm test")).toBe(false);
    expect(isDestructiveCommand("git status --short")).toBe(false);
  });
});
