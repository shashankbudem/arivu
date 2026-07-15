import { describe, expect, it } from "vitest";
import { capabilityForApprovalAction, describeCapabilityPolicies, evaluateCapabilityPolicy } from "../src/permissions/capabilityPolicy.js";

describe("capability policy", () => {
  it("allows local read-style capabilities in every trust mode", () => {
    for (const trustMode of ["readonly", "ask", "trusted"] as const) {
      expect(evaluateCapabilityPolicy(trustMode, "read_repo").effect).toBe("allow");
      expect(evaluateCapabilityPolicy(trustMode, "local_context").effect).toBe("allow");
      expect(evaluateCapabilityPolicy(trustMode, "skill_context").effect).toBe("allow");
    }
  });

  it("blocks host-changing capabilities in readonly mode but allows isolated browser control", () => {
    expect(evaluateCapabilityPolicy("readonly", "write_workspace").effect).toBe("deny");
    expect(evaluateCapabilityPolicy("readonly", "run_command").effect).toBe("deny");
    expect(evaluateCapabilityPolicy("readonly", "mcp_call").effect).toBe("deny");
    expect(evaluateCapabilityPolicy("readonly", "browser_control").effect).toBe("allow");
    expect(evaluateCapabilityPolicy("readonly", "network_fetch").effect).toBe("prompt");
  });

  it("keeps trusted mode permissive for browser actions but not risky workspace writes", () => {
    expect(evaluateCapabilityPolicy("trusted", "write_workspace").effect).toBe("allow");
    expect(evaluateCapabilityPolicy("trusted", "write_workspace", { risky: true }).effect).toBe("prompt");
    expect(evaluateCapabilityPolicy("trusted", "browser_control").effect).toBe("allow");
    expect(evaluateCapabilityPolicy("trusted", "browser_control", { risky: true }).effect).toBe("allow");
    expect(evaluateCapabilityPolicy("trusted", "run_command").effect).toBe("prompt");
    expect(evaluateCapabilityPolicy("trusted", "mcp_call").effect).toBe("prompt");
  });

  it("applies workspace overrides only when they tighten the built-in policy", () => {
    expect(evaluateCapabilityPolicy("trusted", "write_workspace", { overrides: { write_workspace: "prompt" } })).toMatchObject({
      effect: "prompt",
      label: "Workspace approval",
      override: "prompt"
    });
    expect(evaluateCapabilityPolicy("trusted", "browser_control", { overrides: { browser_control: "deny" } })).toMatchObject({
      effect: "deny",
      label: "Blocked by workspace",
      override: "deny"
    });
    const readonlyWrite = evaluateCapabilityPolicy("readonly", "write_workspace", { overrides: { write_workspace: "prompt" } });
    expect(readonlyWrite.effect).toBe("deny");
    expect(readonlyWrite).not.toHaveProperty("override");
  });

  it("maps approval action types onto harness capabilities", () => {
    expect(capabilityForApprovalAction({ type: "read", summary: "read", path: "README.md" })).toBe("read_repo");
    expect(capabilityForApprovalAction({ type: "write", summary: "edit" })).toBe("write_workspace");
    expect(capabilityForApprovalAction({ type: "shell", command: "npm test" })).toBe("run_command");
    expect(capabilityForApprovalAction({ type: "network", summary: "search" })).toBe("network_fetch");
    expect(capabilityForApprovalAction({ type: "browser", action: "open", target: "https://example.com" })).toBe("browser_control");
    expect(capabilityForApprovalAction({ type: "mcp", server: "server", tool: "tool" })).toBe("mcp_call");
  });

  it("describes the policy matrix from the same decisions used by approvals", () => {
    const matrix = describeCapabilityPolicies();
    const writePolicy = matrix.find((policy) => policy.capability === "write_workspace");
    expect(matrix.map((policy) => policy.capability)).toContain("unknown");
    expect(writePolicy?.label).toBe("Workspace writes");
    expect(writePolicy?.examples).toContain("apply_patch");
    expect(writePolicy?.risk).toContain("mutate project files");
    expect(writePolicy?.defaultPosture).toContain("Blocked in readonly");
    expect(writePolicy?.modes.map((mode) => mode.trustMode)).toEqual(["readonly", "ask", "trusted"]);
    expect(writePolicy?.modes.find((mode) => mode.trustMode === "readonly")?.effect).toBe("deny");
    expect(writePolicy?.modes.find((mode) => mode.trustMode === "trusted")?.effect).toBe("allow");
    expect(writePolicy?.modes.find((mode) => mode.trustMode === "trusted")?.riskyEffect).toBe("prompt");
  });

  it("describes workspace overrides in the policy matrix", () => {
    const matrix = describeCapabilityPolicies({ write_workspace: "deny" });
    const writePolicy = matrix.find((policy) => policy.capability === "write_workspace");
    expect(writePolicy?.modes.find((mode) => mode.trustMode === "trusted")).toMatchObject({
      effect: "deny",
      label: "Blocked by workspace",
      override: "deny"
    });
    expect(writePolicy?.modes.find((mode) => mode.trustMode === "readonly")).toMatchObject({
      effect: "deny",
      override: "deny"
    });
  });
});
