import { capabilityForToolName } from "../../src/agent/taskRuns.js";
import type { ToolSchema } from "../../src/agent/types.js";
import { resolveWebSearchProvider, type AppConfig } from "../../src/config.js";
import { evaluateCapabilityPolicy, type CapabilityPolicyOverrides } from "../../src/permissions/capabilityPolicy.js";
import { scopePolicySummariesForTool } from "../../src/permissions/scopePolicy.js";

export type ToolStatus = "enabled" | "approval" | "blocked" | "network" | "privacy";

export type ToolSummary = {
  name: string;
  description: string;
  parameters: string[];
  status: ToolStatus;
  statusLabel: string;
  scopeLabels: string[];
  /** User-toggled off in the tools panel; the tool is withheld from the model until re-enabled. */
  disabled: boolean;
};

export function toolParameterNames(schema: ToolSchema) {
  const properties = schema.parameters.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return [];
  }
  return Object.keys(properties).sort((left, right) => left.localeCompare(right));
}

export function toolStatus(
  name: string,
  config: AppConfig,
  policyOverrides: CapabilityPolicyOverrides = {},
  scopePolicyRules: AppConfig["workspacePolicies"][string]["scopeRules"] = {}
): Pick<ToolSummary, "status" | "statusLabel" | "scopeLabels"> {
  const scopeLabels = scopePolicySummariesForTool(name, scopePolicyRules);
  if (name === "current_location") {
    return {
      status: "privacy",
      statusLabel: "Timezone only",
      scopeLabels
    };
  }
  if (name.startsWith("mcp_") && name === "mcp_list_tools" && Object.keys(config.mcpServers).length === 0) {
    return {
      status: "network",
      statusLabel: "No servers",
      scopeLabels
    };
  }
  if (name.startsWith("browser_") && !["browser_open", "browser_click", "browser_click_at", "browser_type"].includes(name)) {
    return {
      status: "privacy",
      statusLabel: "Hidden browser",
      scopeLabels
    };
  }

  const decision = evaluateCapabilityPolicy(config.trustMode, capabilityForToolName(name), {
    risky: toolMayRequireApproval(name),
    overrides: policyOverrides
  });
  if (name === "web_search") {
    const provider = resolveWebSearchProvider(config);
    return {
      status: decision.effect === "deny" ? "blocked" : "approval",
      statusLabel: `${provider.name} approval`,
      scopeLabels
    };
  }
  return {
    status: decision.effect === "deny" ? "blocked" : decision.effect === "prompt" ? "approval" : "enabled",
    statusLabel: decision.label,
    scopeLabels
  };
}

function toolMayRequireApproval(name: string) {
  return ["apply_patch", "write_file", "browser_open", "browser_click", "browser_click_at", "browser_type"].includes(name);
}
