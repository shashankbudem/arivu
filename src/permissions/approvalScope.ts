import type { AgentTaskRunApprovalScope } from "../agent/types.js";
import type { ApprovalAction } from "./types.js";

const MAX_SCOPE_VALUE = 180;
const MAX_SCOPE_DETAIL = 360;

export function scopeForApprovalAction(action: ApprovalAction): AgentTaskRunApprovalScope {
  switch (action.type) {
    case "read":
      return {
        kind: action.path ? "path" : action.query ? "query" : "unknown",
        label: action.path ? "Read path" : action.query ? "Read query" : "Read target",
        value: truncateScopeText(action.path ?? action.query ?? action.summary),
        detail: action.path && action.query ? truncateScopeText(`query: ${action.query}`, MAX_SCOPE_DETAIL) : undefined
      };
    case "write": {
      const writePaths = action.paths?.length ? action.paths : action.path ? [action.path] : [];
      return {
        kind: writePaths.length > 0 ? "path" : "unknown",
        label: writePaths.length > 1 ? "Write paths" : writePaths.length === 1 ? "Write path" : "Write target",
        value: truncateScopeText(writePaths.length > 0 ? summarizeScopeValues(writePaths) : action.summary),
        detail: action.mode ? truncateScopeText(`mode: ${action.mode}`, MAX_SCOPE_DETAIL) : undefined
      };
    }
    case "shell":
      return {
        kind: "command",
        label: "Command",
        value: truncateScopeText(action.command),
        detail: action.cwd ? truncateScopeText(`cwd: ${action.cwd}`, MAX_SCOPE_DETAIL) : undefined
      };
    case "mcp":
      return {
        kind: "mcp",
        label: action.servers?.length ? "MCP servers" : "MCP tool",
        value: truncateScopeText(
          action.servers?.length ? `${summarizeScopeValues(action.servers)}/${action.tool}` : `${action.server}/${action.tool}`
        )
      };
    case "network":
      return {
        kind: "network",
        label: "Network target",
        value: truncateScopeText(networkScopeValue(action)),
        detail: action.query ? truncateScopeText(`query: ${action.query}`, MAX_SCOPE_DETAIL) : undefined
      };
    case "browser":
      return {
        kind: "browser",
        label: "Browser target",
        value: truncateScopeText(browserScopeValue(action)),
        detail: truncateScopeText([action.action, action.mode].filter(Boolean).join(" - "), MAX_SCOPE_DETAIL)
      };
  }
}

function networkScopeValue(action: Extract<ApprovalAction, { type: "network" }>) {
  const candidate = action.destination ?? action.summary;
  const host = hostnameFromText(candidate);
  return host ?? candidate;
}

function browserScopeValue(action: Extract<ApprovalAction, { type: "browser" }>) {
  const host = hostnameFromText(action.url ?? action.target);
  return host ?? action.url ?? action.target;
}

function hostnameFromText(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed).hostname;
  } catch {
    const match = trimmed.match(/https?:\/\/[^\s"'<>]+/u);
    if (!match) {
      return undefined;
    }
    try {
      return new URL(match[0]).hostname;
    } catch {
      return undefined;
    }
  }
}

function truncateScopeText(value: string, maxLength = MAX_SCOPE_VALUE) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function summarizeScopeValues(values: string[]) {
  const firstValues = values.slice(0, 3);
  const suffix = values.length > firstValues.length ? ` +${values.length - firstValues.length} more` : "";
  return `${firstValues.join(", ")}${suffix}`;
}
