import path from "node:path";
import { chatContentToText } from "../agent/content.js";
import type { AgentSession } from "../agent/types.js";

export type SessionPinnedFilter = "all" | "pinned" | "unpinned";
export type SessionProjectFilter = "all" | "project" | "standalone";

export type SessionListFilters = {
  search?: string;
  workspace?: string;
  pinned?: SessionPinnedFilter;
  project?: SessionProjectFilter;
};

export function filterSessions(sessions: AgentSession[], filters: SessionListFilters = {}) {
  const normalized = normalizeSessionListFilters(filters);
  return sessions.filter((session) => {
    if (normalized.pinned === "pinned" && !session.pinnedAt) {
      return false;
    }
    if (normalized.pinned === "unpinned" && session.pinnedAt) {
      return false;
    }
    if (normalized.project === "project" && sessionProjectRoot(session) === null) {
      return false;
    }
    if (normalized.project === "standalone" && sessionProjectRoot(session) !== null) {
      return false;
    }
    if (normalized.workspace && !matchesTokens(sessionWorkspaceFields(session), normalized.workspace)) {
      return false;
    }
    if (normalized.search && !matchesTokens(sessionSearchFields(session), normalized.search)) {
      return false;
    }
    return true;
  });
}

export function normalizeSessionListFilters(filters: SessionListFilters = {}): Required<SessionListFilters> {
  return {
    search: normalizeOptionalFilter(filters.search),
    workspace: normalizeOptionalFilter(filters.workspace),
    pinned: filters.pinned ?? "all",
    project: filters.project ?? "all"
  };
}

export function describeSessionListFilters(filters: SessionListFilters = {}) {
  const normalized = normalizeSessionListFilters(filters);
  const descriptions = [
    normalized.search ? `search=${normalized.search}` : undefined,
    normalized.workspace ? `workspace=${normalized.workspace}` : undefined,
    normalized.pinned !== "all" ? normalized.pinned : undefined,
    normalized.project !== "all" ? normalized.project : undefined
  ].filter((description): description is string => Boolean(description));
  return descriptions.join(", ");
}

/** Max words kept when auto-freezing a chat title into session JSON. */
const SESSION_TITLE_WORD_LIMIT = 12;

/** Short continuation prompts that should not become the permanent chat title. */
const CONTINUATION_TITLE_PATTERN = /^(continue|resume|go on|ok|yes|y|please continue|keep going)\.?$/i;

/**
 * Build a short display title from free text (first N words). Empty input becomes
 * "Untitled session".
 */
export function deriveSessionTitleFromText(text: string, wordLimit = SESSION_TITLE_WORD_LIMIT): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, Math.max(1, wordLimit));
  return words.join(" ") || "Untitled session";
}

/**
 * Best available title source for a session without mutating it: saved title, first
 * substantial user message, earliest task-run preview, then any user message.
 */
export function resolveSessionTitleSource(session: AgentSession): string {
  const savedTitle = session.title?.trim();
  if (savedTitle) {
    return savedTitle;
  }

  for (const message of session.messages) {
    if (message.role !== "user") {
      continue;
    }
    const text = chatContentToText(message.content).trim();
    if (!text || CONTINUATION_TITLE_PATTERN.test(text)) {
      continue;
    }
    return deriveSessionTitleFromText(text);
  }

  for (const run of session.taskRuns ?? []) {
    const text = run.promptPreview?.trim();
    if (!text || CONTINUATION_TITLE_PATTERN.test(text)) {
      continue;
    }
    return deriveSessionTitleFromText(text);
  }

  const anyUser = session.messages.find((message) => message.role === "user");
  if (anyUser) {
    return deriveSessionTitleFromText(chatContentToText(anyUser.content));
  }

  return "Untitled session";
}

/**
 * Freeze a permanent `session.title` when missing so compaction (which drops early
 * user messages) cannot wipe the sidebar label. Does not overwrite a user rename.
 * Returns true when a title was written.
 */
export function ensureSessionTitle(session: AgentSession): boolean {
  if (session.title?.trim()) {
    return false;
  }
  const resolved = resolveSessionTitleSource(session);
  if (resolved === "Untitled session" && !(session.taskRuns?.length || session.messages.some((m) => m.role === "user"))) {
    return false;
  }
  // Even "Untitled session" is better frozen only when we had real content that still
  // resolved to something useful; skip writing pure untitled with no evidence.
  if (resolved === "Untitled session") {
    return false;
  }
  session.title = resolved;
  return true;
}

export function sessionDisplayTitle(session: AgentSession) {
  return resolveSessionTitleSource(session);
}

export function sessionWorkspacePath(session: AgentSession) {
  return sessionProjectRoot(session) ?? session.cwd;
}

export function sessionProjectRoot(session: AgentSession, options: { legacyCwdAsProject?: boolean } = {}) {
  if (session.projectRoot !== undefined) {
    return session.projectRoot;
  }
  return options.legacyCwdAsProject ? session.cwd : null;
}

export function sessionBelongsToProject(session: AgentSession, projectRoot: string, options: { legacyCwdAsProject?: boolean } = {}) {
  return sessionProjectRoot(session, options) === projectRoot;
}

export function detachSessionFromProject(session: AgentSession, fallbackCwd: string): AgentSession {
  return {
    ...session,
    cwd: fallbackCwd,
    projectRoot: null
  };
}

export function sessionWorkspaceName(session: AgentSession) {
  const workspacePath = sessionWorkspacePath(session);
  return path.basename(workspacePath) || workspacePath;
}

function sessionSearchFields(session: AgentSession) {
  const firstUserMessage = session.messages.find((message) => message.role === "user");
  return [
    session.id,
    sessionDisplayTitle(session),
    firstUserMessage ? chatContentToText(firstUserMessage.content) : undefined,
    session.cwd,
    sessionProjectRoot(session) ?? undefined,
    session.model,
    session.selectedModel,
    session.selectedProviderName,
    session.baseUrl,
    session.trustMode,
    session.pinnedAt ? "pinned" : "unpinned",
    sessionProjectRoot(session) ? "project" : "standalone"
  ];
}

function sessionWorkspaceFields(session: AgentSession) {
  return [session.cwd, sessionProjectRoot(session) ?? undefined, sessionWorkspaceName(session)];
}

function matchesTokens(fields: Array<string | undefined>, query: string) {
  const haystack = fields
    .filter((field): field is string => Boolean(field))
    .join("\n")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function normalizeOptionalFilter(value: string | undefined) {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}
