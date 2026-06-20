import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { isDestructiveCommand } from "./destructive.js";
import type { ApprovalAction, TrustMode } from "./types.js";

export class ApprovalManager {
  constructor(
    readonly mode: TrustMode,
    private readonly prompt: (message: string) => Promise<boolean> = defaultPrompt
  ) {}

  async require(action: ApprovalAction): Promise<void> {
    if (action.type === "browser") {
      return;
    }

    if (this.mode === "readonly") {
      throw new Error(`Refused ${action.type}: readonly trust mode is active.`);
    }

    const destructive = action.destructive ?? (action.type === "shell" && isDestructiveCommand(action.command));
    if (this.mode === "trusted" && !destructive) {
      return;
    }

    const label =
      action.type === "shell"
        ? formatShellApproval(action.command, destructive, action.cwd)
        : action.type === "mcp"
          ? formatMcpApproval(action, destructive)
          : formatWriteApproval(action, destructive);

    const approved = await this.prompt(label);
    if (!approved) {
      throw new Error(`User denied ${action.type}.`);
    }
  }
}

function formatShellApproval(command: string, destructive: boolean, cwd?: string) {
  return [`${destructive ? "Destructive shell command" : "Shell command"}: ${command}`, cwd ? `Working directory: ${cwd}` : ""]
    .filter(Boolean)
    .join("\n");
}

function formatWriteApproval(action: Extract<ApprovalAction, { type: "write" }>, destructive: boolean) {
  const lines = [`${destructive ? "Destructive write" : "Write"}: ${action.summary}`];
  if (action.path) {
    lines.push(`Path: ${action.path}`);
  }
  if (action.mode) {
    lines.push(`Mode: ${action.mode}`);
  }
  if (action.diff) {
    lines.push("", "Diff:", action.diff);
  } else if (action.original !== undefined || action.content !== undefined) {
    lines.push("", "Original:", action.original ?? "", "Proposed:", action.content ?? "");
  }
  return lines.join("\n");
}

function formatMcpApproval(action: Extract<ApprovalAction, { type: "mcp" }>, destructive: boolean) {
  return [
    `${destructive ? "MCP tool call" : "MCP tool"}: ${action.server}/${action.tool}`,
    action.arguments === undefined ? "" : `Arguments: ${formatJson(action.arguments)}`
  ]
    .filter(Boolean)
    .join("\n");
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
