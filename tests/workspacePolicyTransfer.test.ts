import { describe, expect, it } from "vitest";
import {
  parseWorkspacePolicyBundle,
  WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH
} from "../src/permissions/workspacePolicyBundles.js";
import {
  parseWorkspacePolicyTransfer,
  serializeWorkspacePolicyTransfer,
  workspacePolicyTransferPayload
} from "../src/permissions/workspacePolicyTransfer.js";

describe("workspace policy transfer", () => {
  it("exports normalized workspace policy JSON", () => {
    const exported = JSON.parse(
      serializeWorkspacePolicyTransfer(
        {
          run_command: "prompt",
          network_fetch: "deny"
        },
        {
          blockedPathPrefixes: ["secrets", ".env", ".env"],
          allowedBrowserTargetClasses: ["local", "background", "local"]
        }
      )
    );

    expect(exported).toEqual({
      kind: "arivu.workspacePolicy",
      version: 1,
      overrides: {
        run_command: "prompt",
        network_fetch: "deny"
      },
      scopeRules: {
        blockedPathPrefixes: [".env", "secrets"],
        allowedBrowserTargetClasses: ["background", "local"]
      }
    });
  });

  it("imports wrapped workspace policy JSON", () => {
    expect(
      parseWorkspacePolicyTransfer(
        JSON.stringify({
          kind: "arivu.workspacePolicy",
          version: 1,
          overrides: {
            browser_control: "prompt",
            unknown: "deny"
          },
          scopeRules: {
            allowedNetworkDomains: ["api.example.com", "API.EXAMPLE.COM"],
            allowedMcpServers: ["github", "github"]
          }
        })
      )
    ).toEqual(
      workspacePolicyTransferPayload(
        {
          browser_control: "prompt",
          unknown: "deny"
        },
        {
          allowedNetworkDomains: ["api.example.com"],
          allowedMcpServers: ["github"]
        }
      )
    );
  });

  it("imports plain override and scope objects", () => {
    expect(
      parseWorkspacePolicyTransfer(
        JSON.stringify({
          overrides: {
            read_repo: "prompt"
          },
          scopeRules: {
            blockedPathPrefixes: ["private"]
          }
        })
      )
    ).toMatchObject({
      overrides: {
        read_repo: "prompt"
      },
      scopeRules: {
        blockedPathPrefixes: ["private"]
      }
    });
  });

  it("rejects unsupported import fields", () => {
    expect(() => parseWorkspacePolicyTransfer("{")).toThrow(/valid JSON/);
    expect(() =>
      parseWorkspacePolicyTransfer(
        JSON.stringify({
          kind: "arivu.workspacePolicy",
          version: 2,
          overrides: {}
        })
      )
    ).toThrow(/unsupported version/);
    expect(() =>
      parseWorkspacePolicyTransfer(
        JSON.stringify({
          overrides: {
            shell: "prompt"
          }
        })
      )
    ).toThrow(/unsupported capability/);
    expect(() =>
      parseWorkspacePolicyTransfer(
        JSON.stringify({
          scopeRules: {
            allowedBrowserTargetClasses: ["remote"]
          }
        })
      )
    ).toThrow(/unsupported browser target class/);
  });

  it("imports team-shared workspace policy bundles with metadata", () => {
    expect(
      parseWorkspacePolicyBundle(
        JSON.stringify({
          kind: "arivu.workspacePolicy",
          version: 1,
          name: "  Team   review  ",
          description: " Ask before commands and keep browser local. ",
          overrides: {
            run_command: "prompt",
            network_fetch: "deny"
          },
          scopeRules: {
            allowedBrowserTargetClasses: ["local", "background", "local"]
          }
        }),
        ".arivu/workspace-policy.json"
      )
    ).toEqual({
      kind: "arivu.workspacePolicy",
      version: 1,
      name: "Team review",
      description: "Ask before commands and keep browser local.",
      sourcePath: ".arivu/workspace-policy.json",
      overrides: {
        run_command: "prompt",
        network_fetch: "deny"
      },
      scopeRules: {
        allowedBrowserTargetClasses: ["background", "local"]
      }
    });
  });

  it("uses stable defaults for minimal team bundles", () => {
    expect(
      parseWorkspacePolicyBundle(
        JSON.stringify({
          overrides: {
            read_repo: "prompt"
          }
        })
      )
    ).toMatchObject({
      name: "Workspace policy bundle",
      sourcePath: WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH,
      overrides: {
        read_repo: "prompt"
      },
      scopeRules: {}
    });
    expect(() => parseWorkspacePolicyBundle("[1,2,3]")).toThrow(/JSON object/);
  });
});
