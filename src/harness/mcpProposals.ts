import { randomUUID } from "node:crypto";
import { loadConfig, saveConfig, type AppConfig, type McpToolProposal } from "../config.js";
import type { RuntimeMcpServerProposalInput, RuntimeMcpServerProposalResult } from "../tools/runtimeControl.js";

export function normalizeDisabledTools(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

/** Reads settings on each agent step. A read failure retains the last policy, never fails open. */
export function createDisabledToolsReader(initial: string[]): () => Promise<string[]> {
  let lastKnown = normalizeDisabledTools(initial);
  return async () => {
    try {
      lastKnown = normalizeDisabledTools((await loadConfig({ includeEnv: false })).disabledTools ?? []);
    } catch {
      /* retain last known */
    }
    return lastKnown;
  };
}

export function normalizeMcpServerProposalInput(input: RuntimeMcpServerProposalInput): Omit<McpToolProposal, "id" | "kind" | "createdAt"> {
  const name = input.name.trim().replace(/\s+/g, " ");
  const command = input.command.trim();
  const description = input.description.trim();
  const reason = input.reason.trim();
  const args = input.args.slice(0, 40).map((arg) => arg.slice(0, 500));
  if (!name || name.length > 80) throw new Error("MCP proposal name must be between 1 and 80 characters.");
  if (!command || command.length > 500) throw new Error("MCP proposal command must be between 1 and 500 characters.");
  if (!reason || reason.length > 1_000) throw new Error("MCP proposal reason must be between 1 and 1000 characters.");
  const envKeys = [...new Set(input.envKeys.map((key) => key.trim()).filter(Boolean))];
  if (envKeys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))
    throw new Error("MCP proposal environment keys must be variable names, not secret values.");
  if ([name, command, description, reason, ...args].some(containsSecretValue))
    throw new Error("MCP proposals may request environment variable names, but must never include secret values.");
  return { name, description: description.slice(0, 500), command, args, envKeys: envKeys.slice(0, 40), reason };
}

export async function proposeMcpServer(input: RuntimeMcpServerProposalInput): Promise<RuntimeMcpServerProposalResult> {
  const saved = await loadConfig({ includeEnv: false });
  const normalized = normalizeMcpServerProposalInput(input);
  const existing = (saved.toolProposals ?? []).find(
    (proposal) =>
      proposal.name.toLowerCase() === normalized.name.toLowerCase() &&
      proposal.command === normalized.command &&
      JSON.stringify(proposal.args) === JSON.stringify(normalized.args)
  );
  if (existing) return proposalResult(existing);
  const proposal: McpToolProposal = { id: randomUUID(), kind: "mcp_server", ...normalized, createdAt: new Date().toISOString() };
  await saveConfig({ ...saved, toolProposals: [proposal, ...(saved.toolProposals ?? [])].slice(0, 20) });
  return proposalResult(proposal);
}

export type McpProposalReviewAction = "install" | "enable" | "disable" | "reject" | "remove";
export type McpProposalReviewResult = { action: McpProposalReviewAction; name: string; serverName?: string; enabled?: boolean };

/** Applies the same review rule as the desktop Settings view: newly installed proposals stay disabled. */
export async function reviewMcpProposal(id: string, action: McpProposalReviewAction): Promise<McpProposalReviewResult> {
  const saved = await loadConfig({ includeEnv: false });
  const proposal = (saved.toolProposals ?? []).find((item) => item.id === id);
  if (action === "enable" || action === "disable" || action === "remove") {
    const serverName = findServerName(id, saved);
    if (!serverName) throw new Error("MCP integration was not found.");
    if (action === "remove") {
      const { [serverName]: _removed, ...mcpServers } = saved.mcpServers;
      await saveConfig({ ...saved, mcpServers });
      return { action, name: serverName, serverName };
    }
    await saveConfig({
      ...saved,
      mcpServers: { ...saved.mcpServers, [serverName]: { ...saved.mcpServers[serverName]!, disabled: action === "disable" } }
    });
    return { action, name: serverName, serverName, enabled: action === "enable" };
  }
  if (!proposal) throw new Error("MCP proposal was not found.");
  if (action === "reject") {
    await saveConfig({ ...saved, toolProposals: saved.toolProposals.filter((item) => item.id !== proposal.id) });
    return { action, name: proposal.name };
  }
  const serverName = uniqueMcpServerName(proposal.name, saved.mcpServers);
  await saveConfig({
    ...saved,
    mcpServers: {
      ...saved.mcpServers,
      [serverName]: {
        command: proposal.command,
        args: proposal.args,
        env: Object.fromEntries(proposal.envKeys.map((key) => [key, ""])),
        disabled: true
      }
    },
    toolProposals: saved.toolProposals.filter((item) => item.id !== proposal.id)
  });
  return { action, name: proposal.name, serverName, enabled: false };
}

export function safeMcpProposalDisplay(proposal: McpToolProposal) {
  return {
    ...proposal,
    command: redactSecretValues(proposal.command),
    args: proposal.args.map(redactSecretValues),
    description: redactSecretValues(proposal.description),
    reason: redactSecretValues(proposal.reason),
    envKeys: proposal.envKeys.map(redactSecretValues)
  };
}

/** Never send persisted MCP command arguments verbatim to a presentation surface. */
export function redactMcpDisplayValue(value: string) {
  return redactSecretValues(value);
}

function proposalResult(proposal: McpToolProposal): RuntimeMcpServerProposalResult {
  return { id: proposal.id, name: proposal.name, status: "pending_review", reviewLocation: "Settings > Integrations" };
}
function findServerName(id: string, config: AppConfig) {
  return Object.keys(config.mcpServers).find((name) => name === id || name.startsWith(`${id}:`));
}
function uniqueMcpServerName(preferred: string, servers: AppConfig["mcpServers"]) {
  const base = preferred.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "mcp";
  let candidate = base;
  let suffix = 2;
  while (servers[candidate]) candidate = `${base}-${suffix++}`;
  return candidate;
}
function containsSecretValue(value: string) {
  const candidates = [value];
  for (let index = 0; index < 3; index += 1) candidates.push(safelyDecode(candidates.at(-1)!));
  return candidates.some((candidate) =>
    /https?:\/\/[^\s/@]+@|\bauthorization\s*:\s*(?:bearer|basic)\s+\S+|\b(?:bearer|basic)\s+\S+|[?&](?:access[_-]?token|refresh[_-]?token|client[_-]?secret|id[_-]?token|oauth[_-]?token|api[_-]?key|token|secret|password)=[^&\s]+|\b(?:sk|rk|pk|ghp|github_pat)_[A-Za-z0-9_-]+\b|["']?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|id[_-]?token|oauth[_-]?token|api[_-]?key|token|secret|password)["']?\s*[=:]\s*["']?\S+|--?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|id[_-]?token|oauth[_-]?token|api[_-]?key|token|secret|password)\s+\S+/i.test(
      candidate
    )
  );
}
function safelyDecode(value: string) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}
function redactSecretValues(value: string) {
  // Legacy config can predate strict proposal validation. Presentation must be
  // safe independently of that validation, so redact the entire field rather
  // than attempting to preserve a potentially secret-bearing fragment.
  return containsSecretValue(value) ? "[redacted]" : value;
}
