import type { ApprovalAction, BrowserTargetClass } from "./types.js";

export type WorkspaceScopePolicyRules = {
  blockedPathPrefixes?: string[];
  allowedNetworkDomains?: string[];
  allowedMcpServers?: string[];
  allowedBrowserTargetClasses?: BrowserTargetClass[];
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

  if (action.type === "mcp" && normalized.allowedMcpServers?.length) {
    const blockedServer = blockedMcpServerMatch(action, normalized.allowedMcpServers);
    if (blockedServer) {
      return {
        effect: "deny",
        label: "Blocked by workspace scope",
        reason: `workspace MCP server allowlist blocks ${blockedServer}`
      };
    }
  }

  if (action.type === "browser" && normalized.allowedBrowserTargetClasses?.length) {
    const classes = browserTargetClasses(action);
    if (classes.length === 0) {
      return {
        effect: "deny",
        label: "Blocked by workspace scope",
        reason: "workspace browser target-class allowlist requires browser target evidence"
      };
    }
    const blockedClass = classes.find((targetClass) => !normalized.allowedBrowserTargetClasses?.includes(targetClass));
    if (blockedClass) {
      return {
        effect: "deny",
        label: "Blocked by workspace scope",
        reason: `workspace browser target-class allowlist blocks ${blockedClass}`
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
  const allowedMcpServers = uniqueSorted(
    (rules?.allowedMcpServers ?? [])
      .map(normalizeMcpServerName)
      .filter((value): value is string => Boolean(value))
  );
  const allowedBrowserTargetClasses = uniqueSortedBrowserTargetClasses(
    (rules?.allowedBrowserTargetClasses ?? [])
      .map(normalizeBrowserTargetClass)
      .filter((value): value is BrowserTargetClass => Boolean(value))
  );
  const normalized: WorkspaceScopePolicyRules = {};
  if (blockedPathPrefixes.length > 0) {
    normalized.blockedPathPrefixes = blockedPathPrefixes;
  }
  if (allowedNetworkDomains.length > 0) {
    normalized.allowedNetworkDomains = allowedNetworkDomains;
  }
  if (allowedMcpServers.length > 0) {
    normalized.allowedMcpServers = allowedMcpServers;
  }
  if (allowedBrowserTargetClasses.length > 0) {
    normalized.allowedBrowserTargetClasses = allowedBrowserTargetClasses;
  }
  return normalized;
}

export function scopePolicyHasRules(rules: WorkspaceScopePolicyRules | undefined) {
  const normalized = normalizeWorkspaceScopePolicyRules(rules);
  return Boolean(
    normalized.blockedPathPrefixes?.length ||
      normalized.allowedNetworkDomains?.length ||
      normalized.allowedMcpServers?.length ||
      normalized.allowedBrowserTargetClasses?.length
  );
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

function blockedMcpServerMatch(action: Extract<ApprovalAction, { type: "mcp" }>, allowedServers: string[]) {
  const servers = (action.servers?.length ? action.servers : [action.server])
    .map(normalizeMcpServerName)
    .filter((value): value is string => Boolean(value));
  if (servers.length === 0) {
    return "unknown";
  }
  if (allowedServers.includes("*")) {
    return undefined;
  }
  return servers.find((server) => !allowedServers.includes(server));
}

function browserTargetClasses(action: Extract<ApprovalAction, { type: "browser" }>) {
  const classes = new Set<BrowserTargetClass>();
  const mode = normalizeBrowserTargetClass(action.mode);
  if (mode) {
    classes.add(mode);
  }
  for (const targetClass of action.targetClasses ?? []) {
    const normalized = normalizeBrowserTargetClass(targetClass);
    if (normalized) {
      classes.add(normalized);
    }
  }
  const urlClass = browserTargetClassFromText(action.url ?? action.target);
  if (urlClass) {
    classes.add(urlClass);
  }
  return Array.from(classes);
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

function normalizeMcpServerName(value: string) {
  return value.trim() || undefined;
}

function normalizeBrowserTargetClass(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "background" ||
    normalized === "visible" ||
    normalized === "local" ||
    normalized === "file" ||
    normalized === "public"
  ) {
    return normalized;
  }
  return undefined;
}

function browserTargetClassFromText(value: string) {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol === "file:") {
      return "file";
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return isLocalBrowserHost(parsed.hostname) ? "local" : "public";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isLocalBrowserHost(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
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

function uniqueSortedBrowserTargetClasses(values: BrowserTargetClass[]) {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right)) as BrowserTargetClass[];
}
