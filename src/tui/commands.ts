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
  | { kind: "activity" | "clear" | "continue" | "diff" | "exit" | "help" | "status" | "summarize" }
  | { kind: "compact"; recentMessageCount?: number }
  | { kind: "model"; model?: string }
  | { kind: "sessions"; limit: number; filters?: SessionListFilters; pick?: boolean }
  | { kind: "resume"; sessionId: string }
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
    case "/tools":
      return { kind: "activity" };
    case "/clear":
      return { kind: "clear" };
    case "/continue":
      return { kind: "continue" };
    case "/status":
      return { kind: "status" };
    case "/diff":
      return { kind: "diff" };
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
