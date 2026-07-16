import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";
import { evaluateScopePolicy } from "../src/permissions/scopePolicy.js";
import type { ApprovalAction } from "../src/permissions/types.js";

const rules = { blockedPathPrefixes: ["secrets"] };
const root = path.resolve("/workspace/project");

function readAction(target: string): ApprovalAction {
  return { type: "read", summary: "read file", path: target };
}

describe("scope policy blocked-path matching", () => {
  it("blocks a direct workspace-relative path under the prefix", () => {
    expect(evaluateScopePolicy(readAction("secrets/key.txt"), rules, root)?.effect).toBe("deny");
  });

  it("blocks the prefix path itself", () => {
    expect(evaluateScopePolicy(readAction("secrets"), rules, root)?.effect).toBe("deny");
  });

  it("blocks a `..` traversal that resolves back into the blocked directory", () => {
    expect(evaluateScopePolicy(readAction("sub/../secrets/key.txt"), rules, root)?.effect).toBe("deny");
  });

  it("blocks an absolute path that lands inside the blocked directory", () => {
    const absolute = path.join(root, "secrets", "key.txt");
    expect(evaluateScopePolicy(readAction(absolute), rules, root)?.effect).toBe("deny");
  });

  it("still blocks a `..` traversal without a workspace root (lexical fallback)", () => {
    expect(evaluateScopePolicy(readAction("sub/../secrets/key.txt"), rules)?.effect).toBe("deny");
  });

  it("does not over-block a sibling that only shares a textual prefix", () => {
    expect(evaluateScopePolicy(readAction("secrets-public/readme.md"), rules, root)).toBeUndefined();
  });

  it("allows an unrelated path", () => {
    expect(evaluateScopePolicy(readAction("src/index.ts"), rules, root)).toBeUndefined();
  });
});

describe("ApprovalManager enforces blocked paths with the threaded workspace root", () => {
  const manager = () => new ApprovalManager("trusted", async () => true, {}, undefined, rules, root);

  it("denies an absolute path into a blocked directory", async () => {
    await expect(manager().require(readAction(path.join(root, "secrets", "key.txt")))).rejects.toThrow(/workspace scope rule blocks path/);
  });

  it("denies a `..` traversal into a blocked directory", async () => {
    await expect(manager().require(readAction("nested/../secrets/key.txt"))).rejects.toThrow(/workspace scope rule blocks path/);
  });

  it("allows a sibling directory that shares a textual prefix", async () => {
    await expect(manager().require(readAction("secrets-public/readme.md"))).resolves.toBeUndefined();
  });
});
