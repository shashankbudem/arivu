import type { AgentTaskRunCapability } from "../agent/types.js";
import type { ApprovalAction, TrustMode } from "./types.js";

export type CapabilityPolicyEffect = "allow" | "prompt" | "deny";
export type CapabilityPolicyOverrideEffect = Extract<CapabilityPolicyEffect, "prompt" | "deny">;
export type CapabilityPolicyOverrides = Partial<Record<AgentTaskRunCapability, CapabilityPolicyOverrideEffect>>;

export type CapabilityPolicyDecision = {
  capability: AgentTaskRunCapability;
  effect: CapabilityPolicyEffect;
  label: string;
  reason: string;
  override?: CapabilityPolicyOverrideEffect;
};

export type CapabilityPolicyModeSummary = {
  trustMode: TrustMode;
  effect: CapabilityPolicyEffect;
  label: string;
  reason: string;
  override?: CapabilityPolicyOverrideEffect;
  riskyEffect?: CapabilityPolicyEffect;
  riskyLabel?: string;
  riskyReason?: string;
  riskyOverride?: CapabilityPolicyOverrideEffect;
};

export type CapabilityPolicySummary = {
  capability: AgentTaskRunCapability;
  label: string;
  description: string;
  modes: CapabilityPolicyModeSummary[];
};

type CapabilityRule = {
  base: CapabilityPolicyEffect;
  risky?: CapabilityPolicyEffect;
  label: string;
  reason: string;
};

type CapabilityPolicyTable = Record<TrustMode, Record<AgentTaskRunCapability, CapabilityRule>>;

const TRUST_MODES: TrustMode[] = ["readonly", "ask", "trusted"];
const EFFECT_RANK: Record<CapabilityPolicyEffect, number> = {
  allow: 0,
  prompt: 1,
  deny: 2
};

const CAPABILITY_DETAILS: Record<AgentTaskRunCapability, { label: string; description: string }> = {
  read_repo: {
    label: "Repo reads",
    description: "Read and search workspace files."
  },
  write_workspace: {
    label: "Workspace writes",
    description: "Create, edit, or delete workspace files."
  },
  run_command: {
    label: "Shell commands",
    description: "Run commands, tests, installs, and builds."
  },
  network_fetch: {
    label: "Network fetches",
    description: "Send outbound requests from tools."
  },
  browser_control: {
    label: "Browser control",
    description: "Open, click, type, inspect, or screenshot pages."
  },
  mcp_call: {
    label: "MCP tools",
    description: "List or call configured MCP server tools."
  },
  skill_context: {
    label: "Skill context",
    description: "Read installed skill instructions."
  },
  local_context: {
    label: "Local context",
    description: "Read local app and session context."
  },
  unknown: {
    label: "Unknown",
    description: "Fallback for unclassified tool activity."
  }
};

const CAPABILITY_DISPLAY_ORDER: AgentTaskRunCapability[] = [
  "read_repo",
  "local_context",
  "skill_context",
  "write_workspace",
  "run_command",
  "network_fetch",
  "browser_control",
  "mcp_call",
  "unknown"
];

export const CAPABILITY_POLICY_TABLE: CapabilityPolicyTable = {
  readonly: {
    read_repo: { base: "allow", label: "Read-only", reason: "local workspace reads are allowed" },
    local_context: { base: "allow", label: "Local context", reason: "local context reads are allowed" },
    skill_context: { base: "allow", label: "Skill context", reason: "local skill reads are allowed" },
    network_fetch: { base: "prompt", label: "Network approval", reason: "network reads require approval" },
    write_workspace: { base: "deny", label: "Blocked in readonly", reason: "readonly trust mode is active" },
    run_command: { base: "deny", label: "Blocked in readonly", reason: "readonly trust mode is active" },
    browser_control: { base: "deny", label: "Blocked in readonly", reason: "readonly trust mode is active" },
    mcp_call: { base: "deny", label: "Blocked in readonly", reason: "readonly trust mode is active" },
    unknown: { base: "deny", label: "Blocked in readonly", reason: "readonly trust mode is active" }
  },
  ask: {
    read_repo: { base: "allow", label: "Read-only", reason: "local workspace reads are allowed" },
    local_context: { base: "allow", label: "Local context", reason: "local context reads are allowed" },
    skill_context: { base: "allow", label: "Skill context", reason: "local skill reads are allowed" },
    write_workspace: { base: "prompt", label: "Requires approval", reason: "workspace writes require approval" },
    run_command: { base: "prompt", label: "Requires approval", reason: "shell commands require approval" },
    network_fetch: { base: "prompt", label: "Network approval", reason: "network reads require approval" },
    browser_control: { base: "prompt", label: "Requires approval", reason: "browser actions require approval" },
    mcp_call: { base: "prompt", label: "Requires approval", reason: "MCP tools require approval" },
    unknown: { base: "prompt", label: "Requires approval", reason: "unknown capabilities require approval" }
  },
  trusted: {
    read_repo: { base: "allow", label: "Read-only", reason: "local workspace reads are allowed" },
    local_context: { base: "allow", label: "Local context", reason: "local context reads are allowed" },
    skill_context: { base: "allow", label: "Skill context", reason: "local skill reads are allowed" },
    write_workspace: { base: "allow", risky: "prompt", label: "Approval for risky", reason: "risky workspace writes require approval" },
    run_command: { base: "prompt", label: "Requires approval", reason: "shell commands require approval" },
    network_fetch: { base: "prompt", label: "Network approval", reason: "network reads require approval" },
    browser_control: { base: "allow", risky: "prompt", label: "Approval for external", reason: "external or submitting browser actions require approval" },
    mcp_call: { base: "prompt", label: "Requires approval", reason: "MCP tools require approval" },
    unknown: { base: "prompt", label: "Requires approval", reason: "unknown capabilities require approval" }
  }
};

export function capabilityForApprovalAction(action: ApprovalAction): AgentTaskRunCapability {
  switch (action.type) {
    case "read":
      return "read_repo";
    case "write":
      return "write_workspace";
    case "shell":
      return "run_command";
    case "network":
      return "network_fetch";
    case "browser":
      return "browser_control";
    case "mcp":
      return "mcp_call";
  }
}

export function evaluateCapabilityPolicy(
  trustMode: TrustMode,
  capability: AgentTaskRunCapability,
  options: { risky?: boolean; overrides?: CapabilityPolicyOverrides } = {}
): CapabilityPolicyDecision {
  const rule = CAPABILITY_POLICY_TABLE[trustMode][capability] ?? CAPABILITY_POLICY_TABLE[trustMode].unknown;
  const baseEffect = options.risky && rule.risky ? rule.risky : rule.base;
  const baseDecision: CapabilityPolicyDecision = {
    capability,
    effect: baseEffect,
    label: rule.label,
    reason: rule.reason
  };
  return applyPolicyOverride(baseDecision, options.overrides?.[capability]);
}

export function evaluateApprovalPolicy(
  trustMode: TrustMode,
  action: ApprovalAction,
  options: { risky?: boolean; overrides?: CapabilityPolicyOverrides } = {}
): CapabilityPolicyDecision {
  return evaluateCapabilityPolicy(trustMode, capabilityForApprovalAction(action), options);
}

export function describeCapabilityPolicies(overrides: CapabilityPolicyOverrides = {}): CapabilityPolicySummary[] {
  return CAPABILITY_DISPLAY_ORDER.map((capability) => {
    const details = CAPABILITY_DETAILS[capability];
    return {
      capability,
      label: details.label,
      description: details.description,
      modes: TRUST_MODES.map((trustMode) => describeCapabilityPolicyMode(trustMode, capability, overrides))
    };
  });
}

function describeCapabilityPolicyMode(
  trustMode: TrustMode,
  capability: AgentTaskRunCapability,
  overrides: CapabilityPolicyOverrides
): CapabilityPolicyModeSummary {
  const base = evaluateCapabilityPolicy(trustMode, capability, { overrides });
  const risky = evaluateCapabilityPolicy(trustMode, capability, { risky: true, overrides });
  const summary: CapabilityPolicyModeSummary = {
    trustMode,
    effect: base.effect,
    label: base.label,
    reason: base.reason,
    override: base.override
  };
  if (risky.effect !== base.effect) {
    summary.riskyEffect = risky.effect;
    summary.riskyLabel = risky.label;
    summary.riskyReason = risky.reason;
    summary.riskyOverride = risky.override;
  }
  return summary;
}

function applyPolicyOverride(decision: CapabilityPolicyDecision, override: CapabilityPolicyOverrideEffect | undefined): CapabilityPolicyDecision {
  if (!override || EFFECT_RANK[override] < EFFECT_RANK[decision.effect]) {
    return decision;
  }
  if (override === "deny") {
    return {
      ...decision,
      effect: "deny",
      label: "Blocked by workspace",
      reason: "workspace policy override is active",
      override
    };
  }
  return {
    ...decision,
    effect: "prompt",
    label: "Workspace approval",
    reason: "workspace policy override is active",
    override
  };
}
