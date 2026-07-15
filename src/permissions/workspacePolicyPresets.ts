import type { WorkspaceCapabilityPolicyOverrides, WorkspacePolicyCapability } from "../config.js";
import { normalizeWorkspaceScopePolicyRules, type WorkspaceScopePolicyRules } from "./scopePolicy.js";

export type WorkspacePolicyPresetId = "inherit" | "review_first" | "local_only" | "locked_down";

export type WorkspacePolicyPreset = {
  id: WorkspacePolicyPresetId;
  label: string;
  description: string;
  overrides: WorkspaceCapabilityPolicyOverrides;
  scopeRules: WorkspaceScopePolicyRules;
};

const WORKSPACE_POLICY_PRESET_CAPABILITIES: WorkspacePolicyCapability[] = [
  "read_repo",
  "write_workspace",
  "run_command",
  "network_fetch",
  "browser_control",
  "mcp_call",
  "unknown"
];

const RAW_WORKSPACE_POLICY_PRESETS: WorkspacePolicyPreset[] = [
  {
    id: "inherit",
    label: "Default",
    description: "Use the selected trust mode without workspace-specific tightening.",
    overrides: {},
    scopeRules: {}
  },
  {
    id: "review_first",
    label: "Review first",
    description: "Ask before reads, writes, commands, network, browser, and MCP activity.",
    overrides: {
      read_repo: "prompt",
      write_workspace: "prompt",
      run_command: "prompt",
      network_fetch: "prompt",
      browser_control: "prompt",
      mcp_call: "prompt",
      unknown: "deny"
    },
    scopeRules: {}
  },
  {
    id: "local_only",
    label: "Local only",
    description: "Keep work inside the machine and block public browser targets.",
    overrides: {
      network_fetch: "deny",
      browser_control: "prompt",
      mcp_call: "deny",
      unknown: "deny"
    },
    scopeRules: {
      allowedBrowserTargetClasses: ["background", "file", "local"]
    }
  },
  {
    id: "locked_down",
    label: "Locked down",
    description: "Prompt for reads and block writes, commands, network, browser, and MCP.",
    overrides: {
      read_repo: "prompt",
      write_workspace: "deny",
      run_command: "deny",
      network_fetch: "deny",
      browser_control: "deny",
      mcp_call: "deny",
      unknown: "deny"
    },
    scopeRules: {
      blockedPathPrefixes: [".env", ".env.local", "private", "secrets"]
    }
  }
];

export const WORKSPACE_POLICY_PRESETS: WorkspacePolicyPreset[] = RAW_WORKSPACE_POLICY_PRESETS.map((preset) =>
  normalizedWorkspacePolicyPreset(preset)
);

export function normalizedWorkspacePolicyPreset(preset: WorkspacePolicyPreset): WorkspacePolicyPreset {
  return {
    ...preset,
    overrides: normalizeWorkspacePolicyPresetOverrides(preset.overrides),
    scopeRules: normalizeWorkspaceScopePolicyRules(preset.scopeRules)
  };
}

export function workspacePolicyPresetMatches(
  preset: WorkspacePolicyPreset,
  overrides: WorkspaceCapabilityPolicyOverrides,
  scopeRules: WorkspaceScopePolicyRules
) {
  const normalizedPreset = normalizedWorkspacePolicyPreset(preset);
  return (
    workspacePolicyOverridesEqual(normalizedPreset.overrides, normalizeWorkspacePolicyPresetOverrides(overrides)) &&
    workspaceScopeRulesEqual(normalizedPreset.scopeRules, normalizeWorkspaceScopePolicyRules(scopeRules))
  );
}

export function normalizeWorkspacePolicyPresetOverrides(
  overrides: WorkspaceCapabilityPolicyOverrides | undefined
): WorkspaceCapabilityPolicyOverrides {
  const normalized: WorkspaceCapabilityPolicyOverrides = {};
  for (const capability of WORKSPACE_POLICY_PRESET_CAPABILITIES) {
    const effect = overrides?.[capability];
    if (effect === "prompt" || effect === "deny") {
      normalized[capability] = effect;
    }
  }
  return normalized;
}

function workspacePolicyOverridesEqual(left: WorkspaceCapabilityPolicyOverrides, right: WorkspaceCapabilityPolicyOverrides) {
  return (
    WORKSPACE_POLICY_PRESET_CAPABILITIES.every((capability) => left[capability] === right[capability]) &&
    WORKSPACE_POLICY_PRESET_CAPABILITIES.every((capability) => right[capability] === left[capability])
  );
}

function workspaceScopeRulesEqual(left: WorkspaceScopePolicyRules, right: WorkspaceScopePolicyRules) {
  return (
    stringListsEqual(left.blockedPathPrefixes, right.blockedPathPrefixes) &&
    stringListsEqual(left.allowedNetworkDomains, right.allowedNetworkDomains) &&
    stringListsEqual(left.allowedMcpServers, right.allowedMcpServers) &&
    stringListsEqual(left.allowedBrowserTargetClasses, right.allowedBrowserTargetClasses)
  );
}

function stringListsEqual(left: string[] | undefined, right: string[] | undefined) {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
