import type { ApprovalAction } from "./types.js";

export type WorkspaceScopePolicyRules = {
  blockedPathPrefixes?: string[];
  allowedNetworkDomains?: string[];
};

export type ScopePolicyDecision = {
  effect: "deny";
  label: string;
  reason: string;
};

export function evaluateScopePolicy(action: ApprovalAction, rules: WorkspaceScopePolicyRules = {}): ScopePolicyDecision | undefined {
  const normalized = normalizeWorkspaceScopePolicyRules(rules);
  const blockedPath = blockedPathMatch(action, normalized.blockedPathPrefixes ?? []);
  if (blockedPath) {
    return {
      effect: "deny",
      label: "Blocked by workspace scope",
      reason: `workspace scope rule blocks path ${blockedPath}`
    };
  }

  if (action.type === "network" && normalized.allowedNetworkDomains?.length) {
    const host = hostnameFromText(action.destination ?? action.summary);
    if (!host) {
      return {
        effect: "deny",
        label: "Blocked by workspace scope",
        reason: "workspace network allowlist requires a URL host"
      };
    }
    if (!domainAllowed(host, normalized.allowedNetworkDomains)) {
      return {
        effect: "deny",
        label: "Blocked by workspace scope",
        reason: `workspace network allowlist blocks ${host}`
      };
    }
  }

  return undefined;
}

export function normalizeWorkspaceScopePolicyRules(rules: WorkspaceScopePolicyRules | undefined): WorkspaceScopePolicyRules {
  const blockedPathPrefixes = uniqueSorted(
    (rules?.blockedPathPrefixes ?? [])
      .map(normalizeWorkspacePathPrefix)
      .filter((value): value is string => Boolean(value))
  );
  const allowedNetworkDomains = uniqueSorted(
    (rules?.allowedNetworkDomains ?? [])
      .map(normalizeDomain)
      .filter((value): value is string => Boolean(value))
  );
  const normalized: WorkspaceScopePolicyRules = {};
  if (blockedPathPrefixes.length > 0) {
    normalized.blockedPathPrefixes = blockedPathPrefixes;
  }
  if (allowedNetworkDomains.length > 0) {
    normalized.allowedNetworkDomains = allowedNetworkDomains;
  }
  return normalized;
}

export function scopePolicyHasRules(rules: WorkspaceScopePolicyRules | undefined) {
  const normalized = normalizeWorkspaceScopePolicyRules(rules);
  return Boolean(normalized.blockedPathPrefixes?.length || normalized.allowedNetworkDomains?.length);
}

function blockedPathMatch(action: ApprovalAction, blockedPrefixes: string[]) {
  if (blockedPrefixes.length === 0) {
    return undefined;
  }
  const paths = approvalActionPaths(action);
  return paths.find((candidate) => blockedPrefixes.some((prefix) => pathMatchesPrefix(candidate, prefix)));
}

function approvalActionPaths(action: ApprovalAction) {
  if (action.type !== "read" && action.type !== "write") {
    return [];
  }
  return [action.path, ...(action.type === "write" ? (action.paths ?? []) : [])]
    .filter((value): value is string => Boolean(value))
    .map(normalizeWorkspacePathPrefix)
    .filter((value): value is string => Boolean(value));
}

function pathMatchesPrefix(candidate: string, prefix: string) {
  if (prefix === ".") {
    return true;
  }
  return candidate.startsWith(prefix);
}

function normalizeWorkspacePathPrefix(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/g, "");
  if (!normalized || normalized === ".") {
    return normalized || undefined;
  }
  return normalized.replace(/^\.\//, "");
}

function normalizeDomain(value: string) {
  const host = hostnameFromText(value) ?? value;
  return host.trim().replace(/^\.+/, "").toLowerCase() || undefined;
}

function domainAllowed(host: string, allowedDomains: string[]) {
  const normalizedHost = normalizeDomain(host);
  if (!normalizedHost) {
    return false;
  }
  return allowedDomains.some((domain) => normalizedHost === domain || normalizedHost.endsWith(`.${domain}`));
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

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}
