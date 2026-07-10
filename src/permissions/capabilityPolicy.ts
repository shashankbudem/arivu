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
  examples: string[];
  risk: string;
  defaultPosture: string;
  modes: CapabilityPolicyModeSummary[];
};

type CapabilityDetails = {
  label: string;
  description: string;
  examples: string[];
  risk: string;
  defaultPosture: string;
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

const CAPABILITY_DETAILS: Record<AgentTaskRunCapability, CapabilityDetails> = {
  read_repo: {
    label: "Repo reads",
    description: "Read and search workspace files.",
    examples: ["list", "read", "search", "git_status"],
    risk: "Local source, filenames, and git state can be sent to the configured model.",
    defaultPosture: "Allowed in every trust mode unless this workspace tightens repo reads."
  },
  write_workspace: {
    label: "Workspace writes",
    description: "Create, edit, or delete workspace files.",
    examples: ["apply_patch", "write_file", "task worktree edits"],
    risk: "Can mutate project files, generated assets, or managed task worktrees.",
    defaultPosture: "Blocked in readonly, approval in ask, allowed in trusted except risky writes."
  },
  run_command: {
    label: "Commands",
    description: "Run commands, tests, installs, and builds.",
    examples: ["npm test", "npm install", "git commands"],
    risk: "Runs host processes that can change files, use secrets, or call external services.",
    defaultPosture: "Blocked in readonly and approval-gated in ask/trusted."
  },
  network_fetch: {
    label: "Network fetches",
    description: "Send outbound requests from tools.",
    examples: ["web_search", "external fetch tools", "news lookups"],
    risk: "Queries and requested URLs leave the machine.",
    defaultPosture: "Approval-gated in every trust mode."
  },
  browser_control: {
    label: "Browser control",
    description: "Open, click, type, inspect, or screenshot pages.",
    examples: ["browser_open", "browser_click", "browser_type"],
    risk: "Web pages are untrusted and can observe navigation, clicks, and typed data.",
    defaultPosture: "Allowed by default for the isolated Arivu browser; workspace policy can prompt or block."
  },
  mcp_call: {
    label: "MCP tools",
    description: "List or call configured MCP server tools.",
    examples: ["mcp_list_tools", "mcp_call_tool", "server startup"],
    risk: "Configured MCP servers are local processes whose side effects depend on the server.",
    defaultPosture: "Blocked in readonly and approval-gated in ask/trusted."
  },
  skill_context: {
    label: "Skill context",
    description: "Read installed skill instructions.",
    examples: ["list_skills", "read_skill", "SKILL.md context"],
    risk: "Skill instructions can steer model behavior and may include local workflow details.",
    defaultPosture: "Allowed in every trust mode."
  },
  local_context: {
    label: "Local context",
    description: "Read local app and session context.",
    examples: ["current_datetime", "current_location", "session metadata"],
    risk: "Exposes limited local metadata such as time, timezone, and app state.",
    defaultPosture: "Allowed in every trust mode."
  },
  unknown: {
    label: "Unknown",
    description: "Fallback for unclassified tool activity.",
    examples: ["unmapped tool call", "future harness action"],
    risk: "The action has not been mapped to a precise capability yet.",
    defaultPosture: "Blocked in readonly and approval-gated in ask/trusted."
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
    browser_control: { base: "allow", label: "Browser allowed", reason: "isolated browser actions are allowed without approval" },
    write_workspace: { base: "deny", label: "Blocked in readonly", reason: "readonly trust mode is active" },
    run_command: { base: "deny", label: "Blocked in readonly", reason: "readonly trust mode is active" },
    mcp_call: { base: "deny", label: "Blocked in readonly", reason: "readonly trust mode is active" },
    unknown: { base: "deny", label: "Blocked in readonly", reason: "readonly trust mode is active" }
  },
  ask: {
    read_repo: { base: "allow", label: "Read-only", reason: "local workspace reads are allowed" },
    local_context: { base: "allow", label: "Local context", reason: "local context reads are allowed" },
    skill_context: { base: "allow", label: "Skill context", reason: "local skill reads are allowed" },
    write_workspace: { base: "prompt", label: "Requires approval", reason: "workspace writes require approval" },
    run_command: { base: "prompt", label: "Requires approval", reason: "commands require approval" },
    network_fetch: { base: "prompt", label: "Network approval", reason: "network reads require approval" },
    browser_control: { base: "allow", label: "Browser allowed", reason: "isolated browser actions are allowed without approval" },
    mcp_call: { base: "prompt", label: "Requires approval", reason: "MCP tools require approval" },
    unknown: { base: "prompt", label: "Requires approval", reason: "unknown capabilities require approval" }
  },
  trusted: {
    read_repo: { base: "allow", label: "Read-only", reason: "local workspace reads are allowed" },
    local_context: { base: "allow", label: "Local context", reason: "local context reads are allowed" },
    skill_context: { base: "allow", label: "Skill context", reason: "local skill reads are allowed" },
    write_workspace: { base: "allow", risky: "prompt", label: "Approval for risky", reason: "risky workspace writes require approval" },
    run_command: { base: "prompt", label: "Requires approval", reason: "commands require approval" },
    network_fetch: { base: "prompt", label: "Network approval", reason: "network reads require approval" },
    browser_control: { base: "allow", label: "Browser allowed", reason: "isolated browser actions are allowed without approval" },
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
      examples: details.examples,
      risk: details.risk,
      defaultPosture: details.defaultPosture,
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

function applyPolicyOverride(
  decision: CapabilityPolicyDecision,
  override: CapabilityPolicyOverrideEffect | undefined
): CapabilityPolicyDecision {
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
