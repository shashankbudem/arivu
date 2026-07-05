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
    if (normalized.project === "project" && !session.projectRoot) {
      return false;
    }
    if (normalized.project === "standalone" && session.projectRoot) {
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

export function sessionDisplayTitle(session: AgentSession) {
  const savedTitle = session.title?.trim();
  if (savedTitle) {
    return savedTitle;
  }
  const content = session.messages.find((message) => message.role === "user")?.content;
  return content ? chatContentToText(content).trim().split(/\s+/).slice(0, 12).join(" ") || "Untitled session" : "Untitled session";
}

export function sessionWorkspacePath(session: AgentSession) {
  return session.projectRoot ?? session.cwd;
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
    session.projectRoot ?? undefined,
    session.model,
    session.selectedModel,
    session.selectedProviderName,
    session.baseUrl,
    session.trustMode,
    session.pinnedAt ? "pinned" : "unpinned",
    session.projectRoot ? "project" : "standalone"
  ];
}

function sessionWorkspaceFields(session: AgentSession) {
  return [session.cwd, session.projectRoot ?? undefined, sessionWorkspaceName(session)];
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
