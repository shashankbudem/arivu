import { randomUUID } from "node:crypto";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { scopeForApprovalAction } from "./approvalScope.js";
import { evaluateApprovalPolicy, type CapabilityPolicyOverrides } from "./capabilityPolicy.js";
import { isDestructiveCommand } from "./destructive.js";
import { evaluateScopePolicy, type WorkspaceScopePolicyRules } from "./scopePolicy.js";
import type { ApprovalAction, TrustMode } from "./types.js";
import type { AgentTaskRunApprovalChangePreview, AgentTaskRunApprovalEvent } from "../agent/types.js";
import { unifiedDiffStats } from "../tools/patch.js";

export type ApprovalAuditSink = (event: AgentTaskRunApprovalEvent) => void | Promise<void>;

const MAX_APPROVAL_AUDIT_MESSAGE = 2_000;
const MAX_APPROVAL_BODY_SECTION = 12_000;
const MAX_APPROVAL_CHANGE_PREVIEW_TEXT = 40_000;

export class ApprovalManager {
  constructor(
    readonly mode: TrustMode,
    private readonly prompt: (message: string) => Promise<boolean> = defaultPrompt,
    private readonly policyOverrides: CapabilityPolicyOverrides = {},
    private readonly audit?: ApprovalAuditSink,
    private readonly scopePolicyRules: WorkspaceScopePolicyRules = {}
  ) {}

  async require(action: ApprovalAction): Promise<void> {
    const destructive = action.destructive ?? (action.type === "shell" ? isDestructiveCommand(action.command) : action.type === "network");
    const baseDecision = evaluateApprovalPolicy(this.mode, action, { risky: destructive, overrides: this.policyOverrides });
    const scopeDecision = baseDecision.effect === "deny" ? undefined : evaluateScopePolicy(action, this.scopePolicyRules);
    const decision = scopeDecision
      ? {
          ...baseDecision,
          effect: scopeDecision.effect,
          label: scopeDecision.label,
          reason: scopeDecision.reason,
          override: "deny" as const
        }
      : baseDecision;
    const approvalId = randomUUID();
    const baseAuditEvent = {
      id: approvalId,
      actionType: action.type,
      capability: decision.capability,
      trustMode: this.mode,
      effect: decision.effect,
      label: decision.label,
      reason: decision.reason,
      risky: destructive,
      override: decision.override,
      scope: scopeForApprovalAction(action),
      changePreview: changePreviewForApprovalAction(action),
      summary: summarizeApprovalAction(action)
    };
    if (decision.effect === "deny") {
      await this.emitAudit({
        ...baseAuditEvent,
        status: "blocked",
      });
      throw new Error(`Refused ${action.type}: ${decision.reason}.`);
    }
    if (decision.effect === "allow") {
      await this.emitAudit({
        ...baseAuditEvent,
        status: "allowed",
      });
      return;
    }

    const label =
      action.type === "shell"
        ? formatShellApproval(action.command, destructive, action.cwd)
        : action.type === "mcp"
          ? formatMcpApproval(action, destructive)
          : action.type === "network"
            ? formatNetworkApproval(action, destructive)
            : action.type === "browser"
              ? formatBrowserApproval(action, destructive)
              : action.type === "read"
                ? formatReadApproval(action)
                : formatWriteApproval(action, destructive);

    await this.emitAudit({
      ...baseAuditEvent,
      status: "requested",
      message: truncateApprovalAuditText(label)
    });
    const approved = await this.prompt(label);
    if (!approved) {
      await this.emitAudit({
        ...baseAuditEvent,
        status: "denied",
        message: truncateApprovalAuditText(label)
      });
      throw new Error(`User denied ${action.type}.`);
    }
    await this.emitAudit({
      ...baseAuditEvent,
      status: "approved",
      message: truncateApprovalAuditText(label)
    });
  }

  private async emitAudit(event: AgentTaskRunApprovalEvent) {
    await this.audit?.(event);
  }
}

function formatShellApproval(command: string, destructive: boolean, cwd?: string) {
  return [`${destructive ? "Destructive shell command" : "Shell command"}: ${command}`, cwd ? `Working directory: ${cwd}` : ""]
    .filter(Boolean)
    .join("\n");
}

function formatWriteApproval(action: Extract<ApprovalAction, { type: "write" }>, destructive: boolean) {
  const heading = action.reviewReason ? "Write review" : destructive ? "Destructive write" : "Write";
  const lines = [`${heading}: ${action.summary}`];
  if (action.reviewReason) {
    lines.push(`Review boundary: ${action.reviewReason}`);
  }
  if (action.changeSummary) {
    lines.push(`Change summary: ${action.changeSummary}`);
  }
  if (action.path) {
    lines.push(`Path: ${action.path}`);
  }
  if (action.paths?.length) {
    lines.push(`Paths: ${action.paths.join(", ")}`);
  }
  if (action.mode) {
    lines.push(`Mode: ${action.mode}`);
  }
  if (action.diff) {
    lines.push("", "Diff:", truncateApprovalBodySection(action.diff));
  } else if (action.original !== undefined || action.content !== undefined) {
    lines.push(
      "",
      "Original:",
      truncateApprovalBodySection(action.original ?? ""),
      "Proposed:",
      truncateApprovalBodySection(action.content ?? "")
    );
  }
  return lines.join("\n");
}

function formatReadApproval(action: Extract<ApprovalAction, { type: "read" }>) {
  return [
    `Repo read: ${action.summary}`,
    action.path ? `Path: ${action.path}` : "",
    action.query ? `Query: ${action.query}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function formatMcpApproval(action: Extract<ApprovalAction, { type: "mcp" }>, destructive: boolean) {
  return [
    `${destructive ? "MCP tool call" : "MCP tool"}: ${action.servers?.length ? action.servers.join(", ") : action.server}/${action.tool}`,
    action.arguments === undefined ? "" : `Arguments: ${formatJson(action.arguments)}`
  ]
    .filter(Boolean)
    .join("\n");
}

function formatNetworkApproval(action: Extract<ApprovalAction, { type: "network" }>, destructive: boolean) {
  return [
    `${destructive ? "Network request" : "Network read"}: ${action.summary}`,
    action.destination ? `Destination: ${action.destination}` : "",
    action.query ? `Query: ${action.query}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function formatBrowserApproval(action: Extract<ApprovalAction, { type: "browser" }>, destructive: boolean) {
  return [
    `${destructive ? "Browser action" : "Browser read"}: ${action.action}`,
    `Target: ${action.target}`,
    action.url && action.url !== action.target ? `URL: ${action.url}` : "",
    action.mode ? `Mode: ${action.mode}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function summarizeApprovalAction(action: ApprovalAction) {
  switch (action.type) {
    case "read":
      return [action.summary, action.path, action.query].filter(Boolean).join(" - ");
    case "write":
      return action.path ? `${action.summary} (${action.path})` : action.summary;
    case "shell":
      return action.command;
    case "mcp":
      return `${action.server}/${action.tool}`;
    case "network":
      return [action.summary, action.destination, action.query].filter(Boolean).join(" - ");
    case "browser":
      return `${action.action}: ${action.target}`;
  }
}

function changePreviewForApprovalAction(action: ApprovalAction): AgentTaskRunApprovalChangePreview | undefined {
  if (action.type !== "write") {
    return undefined;
  }
  if (action.diff !== undefined) {
    return patchChangePreview(action);
  }
  if (action.content !== undefined || action.original !== undefined) {
    return fileChangePreview(action);
  }
  return undefined;
}

function patchChangePreview(action: Extract<ApprovalAction, { type: "write" }>): AgentTaskRunApprovalChangePreview {
  const boundedDiff = boundApprovalPreviewText(action.diff ?? "");
  const stats = safeUnifiedDiffStats(action.diff ?? "");
  const lineCount = countPreviewLines(action.diff ?? "");
  const bytes = Buffer.byteLength(action.diff ?? "", "utf8");
  const changedPaths = stats?.changedPaths.length ? stats.changedPaths : action.paths;
  const summaryParts = [
    changedPaths?.length ? `${changedPaths.length} file${changedPaths.length === 1 ? "" : "s"}` : undefined,
    stats ? `+${stats.additions}/-${stats.deletions}` : undefined,
    `${lineCount} diff line${lineCount === 1 ? "" : "s"}`,
    formatPreviewBytes(bytes)
  ].filter((part): part is string => Boolean(part));
  return {
    kind: "patch",
    title: action.reviewReason ? "Patch review preview" : "Patch preview",
    summary: summaryParts.join(", "),
    diff: boundedDiff.text,
    diffTruncated: boundedDiff.truncated || undefined,
    changedPaths,
    additions: stats?.additions,
    deletions: stats?.deletions,
    lineCount,
    bytes
  };
}

function fileChangePreview(action: Extract<ApprovalAction, { type: "write" }>): AgentTaskRunApprovalChangePreview {
  const boundedContent = action.content === undefined ? undefined : boundApprovalPreviewText(action.content);
  const boundedOriginal = action.original === undefined ? undefined : boundApprovalPreviewText(action.original);
  const lineCount = action.content === undefined ? undefined : countPreviewLines(action.content);
  const bytes = action.content === undefined ? undefined : Buffer.byteLength(action.content, "utf8");
  const summaryParts = [
    action.mode ? action.mode : undefined,
    lineCount !== undefined ? `${lineCount} line${lineCount === 1 ? "" : "s"}` : undefined,
    bytes !== undefined ? formatPreviewBytes(bytes) : undefined
  ].filter((part): part is string => Boolean(part));
  return {
    kind: "file_change",
    title: action.mode === "replace" ? "File replacement preview" : action.mode === "create" ? "File creation preview" : "File write preview",
    summary: summaryParts.join(", "),
    path: action.path,
    writeMode: action.mode,
    content: boundedContent?.text,
    contentTruncated: boundedContent?.truncated || undefined,
    original: boundedOriginal?.text,
    originalTruncated: boundedOriginal?.truncated || undefined,
    lineCount,
    bytes
  };
}

function safeUnifiedDiffStats(diff: string) {
  try {
    return unifiedDiffStats(diff);
  } catch {
    return undefined;
  }
}

function truncateApprovalAuditText(value: string) {
  if (value.length <= MAX_APPROVAL_AUDIT_MESSAGE) {
    return value;
  }
  return `${value.slice(0, MAX_APPROVAL_AUDIT_MESSAGE - 3).trimEnd()}...`;
}

function truncateApprovalBodySection(value: string) {
  if (value.length <= MAX_APPROVAL_BODY_SECTION) {
    return value;
  }
  return `${value.slice(0, MAX_APPROVAL_BODY_SECTION).trimEnd()}\n... truncated ${value.length - MAX_APPROVAL_BODY_SECTION} chars ...`;
}

function boundApprovalPreviewText(value: string) {
  if (value.length <= MAX_APPROVAL_CHANGE_PREVIEW_TEXT) {
    return { text: value, truncated: false };
  }
  return {
    text: Buffer.from(value, "utf8").subarray(0, MAX_APPROVAL_CHANGE_PREVIEW_TEXT).toString("utf8"),
    truncated: true
  };
}

function countPreviewLines(value: string) {
  if (value.length === 0) {
    return 0;
  }
  return value.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

function formatPreviewBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function defaultPrompt(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  return confirm({
    message: chalk.yellow(message),
    default: false
  });
}
