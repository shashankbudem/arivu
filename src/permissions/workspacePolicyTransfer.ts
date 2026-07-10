import type { WorkspaceCapabilityPolicyOverrides, WorkspacePolicyCapability } from "../config.js";
import { normalizeWorkspacePolicyPresetOverrides } from "./workspacePolicyPresets.js";
import { normalizeWorkspaceScopePolicyRules, type WorkspaceScopePolicyRules } from "./scopePolicy.js";

export type WorkspacePolicyTransferPayload = {
  kind: "arivu.workspacePolicy";
  version: 1;
  overrides: WorkspaceCapabilityPolicyOverrides;
  scopeRules: WorkspaceScopePolicyRules;
};

const TRANSFER_KIND: WorkspacePolicyTransferPayload["kind"] = "arivu.workspacePolicy";
const TRANSFER_VERSION: WorkspacePolicyTransferPayload["version"] = 1;
const WORKSPACE_POLICY_CAPABILITIES: WorkspacePolicyCapability[] = [
  "read_repo",
  "write_workspace",
  "run_command",
  "network_fetch",
  "browser_control",
  "mcp_call",
  "unknown"
];
const WORKSPACE_POLICY_CAPABILITY_SET = new Set<string>(WORKSPACE_POLICY_CAPABILITIES);
const WORKSPACE_SCOPE_RULE_KEYS = new Set([
  "blockedPathPrefixes",
  "allowedNetworkDomains",
  "allowedMcpServers",
  "allowedBrowserTargetClasses"
]);
const BROWSER_TARGET_CLASSES = new Set(["background", "visible", "local", "file", "public"]);

export function workspacePolicyTransferPayload(
  overrides: WorkspaceCapabilityPolicyOverrides,
  scopeRules: WorkspaceScopePolicyRules
): WorkspacePolicyTransferPayload {
  return {
    kind: TRANSFER_KIND,
    version: TRANSFER_VERSION,
    overrides: normalizeWorkspacePolicyPresetOverrides(overrides),
    scopeRules: normalizeWorkspaceScopePolicyRules(scopeRules)
  };
}

export function serializeWorkspacePolicyTransfer(overrides: WorkspaceCapabilityPolicyOverrides, scopeRules: WorkspaceScopePolicyRules) {
  return JSON.stringify(workspacePolicyTransferPayload(overrides, scopeRules), null, 2);
}

export function parseWorkspacePolicyTransfer(text: string): WorkspacePolicyTransferPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Workspace policy import must be valid JSON.");
  }

  const container = objectRecord(parsed, "Workspace policy import");
  if ("kind" in container || "version" in container) {
    if (container.kind !== TRANSFER_KIND) {
      throw new Error("Workspace policy import has an unsupported kind.");
    }
    if (container.version !== TRANSFER_VERSION) {
      throw new Error("Workspace policy import has an unsupported version.");
    }
  }

  return workspacePolicyTransferPayload(parseOverrides(container.overrides), parseScopeRules(container.scopeRules));
}

function parseOverrides(value: unknown): WorkspaceCapabilityPolicyOverrides {
  if (value === undefined) {
    return {};
  }
  const overrides = objectRecord(value, "Workspace policy overrides");
  const parsed: WorkspaceCapabilityPolicyOverrides = {};
  for (const [capability, effect] of Object.entries(overrides)) {
    if (!WORKSPACE_POLICY_CAPABILITY_SET.has(capability)) {
      throw new Error(`Workspace policy import contains unsupported capability "${capability}".`);
    }
    if (effect !== "prompt" && effect !== "deny") {
      throw new Error(`Workspace policy import contains unsupported effect for "${capability}".`);
    }
    parsed[capability as WorkspacePolicyCapability] = effect;
  }
  return normalizeWorkspacePolicyPresetOverrides(parsed);
}

function parseScopeRules(value: unknown): WorkspaceScopePolicyRules {
  if (value === undefined) {
    return {};
  }
  const scopeRules = objectRecord(value, "Workspace policy scope rules");
  const parsed: Record<string, string[]> = {};
  for (const [key, entries] of Object.entries(scopeRules)) {
    if (!WORKSPACE_SCOPE_RULE_KEYS.has(key)) {
      throw new Error(`Workspace policy import contains unsupported scope rule "${key}".`);
    }
    if (!Array.isArray(entries)) {
      throw new Error(`Workspace policy scope rule "${key}" must be an array.`);
    }
    parsed[key] = entries.map((entry) => {
      if (typeof entry !== "string") {
        throw new Error(`Workspace policy scope rule "${key}" must only contain strings.`);
      }
      const normalized = entry.trim();
      if (key === "allowedBrowserTargetClasses" && normalized && !BROWSER_TARGET_CLASSES.has(normalized)) {
        throw new Error(`Workspace policy import contains unsupported browser target class "${normalized}".`);
      }
      return normalized;
    });
  }
  return normalizeWorkspaceScopePolicyRules(parsed);
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}
