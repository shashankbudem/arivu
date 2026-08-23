import { execa } from "execa";
import type { AgentSession } from "../agent/types.js";
import {
  describeSessionListFilters,
  filterSessions,
  sessionDisplayTitle,
  sessionWorkspaceName,
  type SessionListFilters
} from "../sessions/sessionList.js";

export type TuiSlashCommand =
  | { kind: "activity" | "clear" | "continue" | "delete" | "diff" | "exit" | "help" | "new" | "pin" | "runs" | "status" | "summarize" }
  | { kind: "tools"; action: "list" | "enable" | "disable"; name?: string }
  | { kind: "integrations"; action: "list" | "install" | "enable" | "disable" | "reject" | "remove"; id?: string }
  | { kind: "compact"; recentMessageCount?: number }
  | { kind: "model"; model?: string }
  | { kind: "sessions"; limit: number; filters?: SessionListFilters; pick?: boolean }
  | { kind: "resume"; sessionId: string }
  | { kind: "undo"; taskRunId: string }
  | { kind: "steer"; promptId: string }
  | { kind: "attach"; attachmentType: "file" | "image"; path: string }
  | { kind: "attachments"; action: "list" | "clear" | "remove"; index?: number }
  | { kind: "queue"; action: "retry" }
  | { kind: "plan"; action: "arm" | "approve" | "revise" | "cancel" | "run"; taskRunId?: string }
  | { kind: "loop"; action: "arm" | "stop"; maxIterations?: number }
  | {
      kind: "worktree";
      action:
        | "arm"
        | "run"
        | "replay"
        | "status"
        | "preview"
        | "merge"
        | "sync"
        | "continue"
        | "abort"
        | "discard"
        | "cleanup"
        | "prepare_pr"
        | "create_pr"
        | "refresh_pr"
        | "checks";
      taskRunId?: string;
      replayOfTaskRunId?: string;
    }
  | { kind: "rename"; title: string }
  | { kind: "error"; message: string }
  | { kind: "unknown" };

export type TuiGitDiffSummary = {
  root: string;
  branch?: string;
  stagedShortstat?: string;
  unstagedShortstat?: string;
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
};

export const DEFAULT_TUI_SESSION_LIST_LIMIT = 10;
const MAX_TUI_SESSION_LIST_LIMIT = 50;

export function parseTuiSlashCommand(value: string): TuiSlashCommand | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const [name = "", ...args] = trimmed.split(/\s+/);
  switch (name.toLowerCase()) {
    case "/exit":
    case "/quit":
      return { kind: "exit" };
    case "/help":
      return { kind: "help" };
    case "/activity":
      return { kind: "activity" };
    case "/tools":
      if (args.length === 0 || args[0] === "list") return { kind: "tools", action: "list" };
      if (["enable", "disable"].includes(args[0]!) && args.length === 2)
        return { kind: "tools", action: args[0] as "enable" | "disable", name: args[1] };
      return { kind: "error", message: "Usage: /tools [list|enable|disable <tool-name>]" };
    case "/integrations":
    case "/mcp":
      if (args.length === 0 || args[0] === "list") return { kind: "integrations", action: "list" };
      if (["install", "enable", "disable", "reject", "remove"].includes(args[0]!) && args.length === 2)
        return { kind: "integrations", action: args[0] as "install" | "enable" | "disable" | "reject" | "remove", id: args[1] };
      return { kind: "error", message: "Usage: /integrations [list|install|enable|disable|reject|remove <id>]" };
    case "/clear":
      return { kind: "clear" };
    case "/new":
      return { kind: "new" };
    case "/delete":
      return { kind: "delete" };
    case "/pin":
      return { kind: "pin" };
    case "/rename":
      if (args.length === 0) {
        return { kind: "error", message: "Usage: /rename <session title>" };
      }
      return { kind: "rename", title: args.join(" ") };
    case "/continue":
      return { kind: "continue" };
    case "/status":
      return { kind: "status" };
    case "/diff":
      return { kind: "diff" };
    case "/runs":
    case "/evidence":
      return { kind: "runs" };
    case "/undo":
      if (!args[0] || args.length > 1) {
        return { kind: "error", message: "Usage: /undo <task-run-id>" };
      }
      return { kind: "undo", taskRunId: args[0] };
    case "/steer":
      if (!args[0] || args.length > 1) {
        return { kind: "error", message: "Usage: /steer <queued-prompt-id>" };
      }
      return { kind: "steer", promptId: args[0] };
    case "/attach": {
      const attachmentMatch = /^\/attach\s+(file|image)\s+(.+)$/i.exec(trimmed);
      if (!attachmentMatch) {
        return { kind: "error", message: "Usage: /attach <file|image> <workspace-path>" };
      }
      return { kind: "attach", attachmentType: attachmentMatch[1]!.toLowerCase() as "file" | "image", path: attachmentMatch[2]!.trim() };
    }
    case "/attachments":
      if (args.length === 0 || args[0] === "list") return { kind: "attachments", action: "list" };
      if (args[0] === "clear" && args.length === 1) return { kind: "attachments", action: "clear" };
      if (args[0] === "remove" && args.length === 2 && Number.isInteger(Number(args[1])) && Number(args[1]) > 0) {
        return { kind: "attachments", action: "remove", index: Number(args[1]) };
      }
      return { kind: "error", message: "Usage: /attachments [list|clear|remove <number>]" };
    case "/queue":
      if (args[0] === "retry" && args.length === 1) return { kind: "queue", action: "retry" };
      return { kind: "error", message: "Usage: /queue retry" };
    case "/plan":
      if (!args[0]) return { kind: "plan", action: "arm" };
      if (["approve", "revise", "cancel", "run"].includes(args[0]) && args[1] && args.length === 2) {
        return { kind: "plan", action: args[0] === "revise" ? "revise" : (args[0] as "approve" | "cancel" | "run"), taskRunId: args[1] };
      }
      return { kind: "error", message: "Usage: /plan [approve|revise|cancel|run <task-run-id>]" };
    case "/loop":
      if (args[0] === "stop" && args.length === 1) return { kind: "loop", action: "stop" };
      if (args.length <= 1) {
        const maxIterations = args[0] ? Number(args[0]) : 5;
        if (Number.isInteger(maxIterations) && maxIterations >= 1 && maxIterations <= 10)
          return { kind: "loop", action: "arm", maxIterations };
      }
      return { kind: "error", message: "Usage: /loop [1-10|stop]" };
    case "/worktree":
      if (!args[0]) return { kind: "worktree", action: "arm" };
      if (args[0] === "run" && args[1] && args.length === 2) return { kind: "worktree", action: "run", taskRunId: args[1] };
      if (args[0] === "replay" && args[1] && args[2] && args.length === 3)
        return { kind: "worktree", action: "replay", taskRunId: args[1], replayOfTaskRunId: args[2] };
      if (
        [
          "status",
          "preview",
          "merge",
          "sync",
          "continue",
          "abort",
          "discard",
          "cleanup",
          "prepare_pr",
          "create_pr",
          "refresh_pr",
          "checks"
        ].includes(args[0]) &&
        args[1] &&
        args.length === 2
      )
        return {
          kind: "worktree",
          action: args[0] as
            | "status"
            | "preview"
            | "merge"
            | "sync"
            | "continue"
            | "abort"
            | "discard"
            | "cleanup"
            | "prepare_pr"
            | "create_pr"
            | "refresh_pr"
            | "checks",
          taskRunId: args[1]
        };
      return { kind: "error", message: "Usage: /worktree [status|preview|merge|sync|continue|abort|discard|cleanup <run>]" };
    case "/compact":
      return parseCompactCommand(args);
    case "/model":
      if (args.length > 1) {
        return { kind: "error", message: "Usage: /model [model-id]" };
      }
      return { kind: "model", model: args[0] };
    case "/summarize":
      return { kind: "summarize" };
    case "/sessions":
      return parseSessionsCommand(args);
    case "/resume":
      if (!args[0]) {
        return { kind: "error", message: "Usage: /resume <session-id>" };
      }
      return { kind: "resume", sessionId: args[0] };
    default:
      return { kind: "unknown" };
  }
}

export async function loadTuiGitDiffSummary(root: string): Promise<TuiGitDiffSummary> {
  await execa("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
  const [branch, stagedShortstat, unstagedShortstat, stagedFiles, unstagedFiles, statusShort] = await Promise.all([
    gitOutput(root, ["branch", "--show-current"]),
    gitOutput(root, ["diff", "--cached", "--shortstat"]),
    gitOutput(root, ["diff", "--shortstat"]),
    gitOutput(root, ["diff", "--cached", "--name-status", "--"]),
    gitOutput(root, ["diff", "--name-status", "--"]),
    gitOutput(root, ["status", "--short", "--untracked-files=normal"])
  ]);

  return {
    root,
    branch: branch || undefined,
    stagedShortstat: stagedShortstat || undefined,
    unstagedShortstat: unstagedShortstat || undefined,
    stagedFiles: splitGitLines(stagedFiles).map(formatNameStatusLine),
    unstagedFiles: splitGitLines(unstagedFiles).map(formatNameStatusLine),
    untrackedFiles: splitGitLines(statusShort)
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
  };
}

export function formatTuiGitDiffSummary(summary: TuiGitDiffSummary) {
  const hasChanges =
    Boolean(summary.stagedShortstat || summary.unstagedShortstat) ||
    summary.stagedFiles.length > 0 ||
    summary.unstagedFiles.length > 0 ||
    summary.untrackedFiles.length > 0;
  if (!hasChanges) {
    return [
      "Git diff summary:",
      `Root: ${summary.root}`,
      summary.branch ? `Branch: ${summary.branch}` : undefined,
      "",
      "No staged, unstaged, or untracked changes."
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  return [
    "Git diff summary:",
    `Root: ${summary.root}`,
    summary.branch ? `Branch: ${summary.branch}` : undefined,
    "",
    formatDiffSection("Staged", summary.stagedShortstat, summary.stagedFiles),
    "",
    formatDiffSection("Unstaged", summary.unstagedShortstat, summary.unstagedFiles),
    "",
    formatDiffSection("Untracked", undefined, summary.untrackedFiles)
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function formatTuiSessionList(sessions: AgentSession[], limit = DEFAULT_TUI_SESSION_LIST_LIMIT, filters?: SessionListFilters) {
  const filterDescription = describeSessionListFilters(filters);
  const visible = filterSessions(sessions, filters).slice(0, clampSessionLimit(limit));
  if (visible.length === 0) {
    return filterDescription ? `No saved sessions match filters: ${filterDescription}.` : "No saved sessions.";
  }

  return [
    filterDescription ? "Matching sessions:" : "Recent sessions:",
    filterDescription ? `Filters: ${filterDescription}` : undefined,
    "",
    ...visible.map((session) =>
      [session.id, formatSessionUpdatedAt(session.updatedAt), sessionWorkspaceName(session), sessionDisplayTitle(session)].join("  ")
    ),
    "",
    "Resume with /resume <session-id>."
  ].join("\n");
}

export function clampSessionLimit(value: number) {
  return Math.min(Math.max(Math.floor(value), 1), MAX_TUI_SESSION_LIST_LIMIT);
}

export function formatSessionUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseCompactCommand(args: string[]): TuiSlashCommand {
  if (args.length === 0) {
    return { kind: "compact" };
  }
  if (args.length > 1) {
    return compactUsageError();
  }
  const recentMessageCount = Number.parseInt(args[0] ?? "", 10);
  if (!Number.isFinite(recentMessageCount) || recentMessageCount < 1) {
    return compactUsageError();
  }
  return { kind: "compact", recentMessageCount };
}

function compactUsageError(): TuiSlashCommand {
  return { kind: "error", message: "Usage: /compact [positive-recent-message-count]" };
}

function parseSessionsCommand(args: string[]): TuiSlashCommand {
  if (args.length === 0) {
    return { kind: "sessions", limit: DEFAULT_TUI_SESSION_LIST_LIMIT };
  }

  let index = 0;
  let limit = DEFAULT_TUI_SESSION_LIST_LIMIT;
  if (!args[0]?.startsWith("--")) {
    limit = Number.parseInt(args[0] ?? "", 10);
    if (!Number.isFinite(limit) || limit < 1) {
      return sessionUsageError();
    }
    index = 1;
  }

  const filters: SessionListFilters = {};
  let pick = false;
  while (index < args.length) {
    const flag = args[index];
    if (flag === "--pick" || flag === "--interactive") {
      pick = true;
      index += 1;
      continue;
    }
    if (flag === "--search") {
      const result = readFlagValue(args, index + 1);
      if (!result.value) {
        return sessionUsageError();
      }
      filters.search = result.value;
      index = result.nextIndex;
      continue;
    }
    if (flag === "--workspace") {
      const result = readFlagValue(args, index + 1);
      if (!result.value) {
        return sessionUsageError();
      }
      filters.workspace = result.value;
      index = result.nextIndex;
      continue;
    }
    if (flag === "--pinned") {
      if (filters.pinned === "unpinned") {
        return sessionUsageError("Use only one of --pinned or --unpinned.");
      }
      filters.pinned = "pinned";
      index += 1;
      continue;
    }
    if (flag === "--unpinned") {
      if (filters.pinned === "pinned") {
        return sessionUsageError("Use only one of --pinned or --unpinned.");
      }
      filters.pinned = "unpinned";
      index += 1;
      continue;
    }
    if (flag === "--project") {
      if (filters.project === "standalone") {
        return sessionUsageError("Use only one of --project or --standalone.");
      }
      filters.project = "project";
      index += 1;
      continue;
    }
    if (flag === "--standalone") {
      if (filters.project === "project") {
        return sessionUsageError("Use only one of --project or --standalone.");
      }
      filters.project = "standalone";
      index += 1;
      continue;
    }
    return sessionUsageError();
  }

  const hasFilters = Boolean(filters.search || filters.workspace || filters.pinned || filters.project);
  return { kind: "sessions", limit: clampSessionLimit(limit), ...(hasFilters ? { filters } : {}), ...(pick ? { pick } : {}) };
}

function readFlagValue(args: string[], startIndex: number) {
  const parts: string[] = [];
  let index = startIndex;
  while (index < args.length && !args[index]?.startsWith("--")) {
    parts.push(args[index] ?? "");
    index += 1;
  }
  return { value: parts.join(" ").trim(), nextIndex: index };
}

function sessionUsageError(message?: string): TuiSlashCommand {
  return {
    kind: "error",
    message:
      message ??
      "Usage: /sessions [positive-limit] [--pick] [--search text] [--workspace text] [--pinned|--unpinned] [--project|--standalone]"
  };
}

async function gitOutput(root: string, args: string[]) {
  const result = await execa("git", ["-C", root, ...args]);
  return result.stdout.trim();
}

function splitGitLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatNameStatusLine(line: string) {
  const [status = "", ...paths] = line.split("\t");
  return `${status.padEnd(3)} ${paths.join(" -> ")}`.trimEnd();
}

function formatDiffSection(title: string, shortstat: string | undefined, files: string[]) {
  if (!shortstat && files.length === 0) {
    return `${title}:\n  none`;
  }
  return [`${title}:`, shortstat ? `  ${shortstat}` : undefined, ...files.map((file) => `  ${file}`)]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
