import { describe, expect, it } from "vitest";
import {
  normalizedWorkspacePolicyPreset,
  WORKSPACE_POLICY_PRESETS,
  workspacePolicyPresetMatches
} from "../src/permissions/workspacePolicyPresets.js";

describe("workspace policy presets", () => {
  it("offers conservative workspace policy presets", () => {
    expect(WORKSPACE_POLICY_PRESETS.map((preset) => preset.id)).toEqual(["inherit", "review_first", "local_only", "locked_down"]);
    expect(WORKSPACE_POLICY_PRESETS.find((preset) => preset.id === "inherit")).toMatchObject({
      overrides: {},
      scopeRules: {}
    });
  });

  it("normalizes preset overrides and scope rules", () => {
    const normalized = normalizedWorkspacePolicyPreset({
      id: "locked_down",
      label: "Locked down",
      description: "Test preset",
      overrides: {
        read_repo: "prompt",
        write_workspace: "deny",
        unknown: "deny"
      },
      scopeRules: {
        blockedPathPrefixes: ["secrets", ".env", ".env"],
        allowedBrowserTargetClasses: ["public", "local", "local"]
      }
    });

    expect(normalized.overrides).toEqual({
      read_repo: "prompt",
      write_workspace: "deny",
      unknown: "deny"
    });
    expect(normalized.scopeRules).toEqual({
      blockedPathPrefixes: [".env", "secrets"],
      allowedBrowserTargetClasses: ["local", "public"]
    });
  });

  it("matches equivalent workspace policy state", () => {
    const localOnly = WORKSPACE_POLICY_PRESETS.find((preset) => preset.id === "local_only");
    expect(localOnly).toBeDefined();
    expect(
      workspacePolicyPresetMatches(
        localOnly!,
        {
          mcp_call: "deny",
          browser_control: "prompt",
          network_fetch: "deny",
          unknown: "deny"
        },
        {
          allowedBrowserTargetClasses: ["local", "background", "file"]
        }
      )
    ).toBe(true);
    expect(workspacePolicyPresetMatches(localOnly!, { network_fetch: "deny" }, {})).toBe(false);
  });
});
