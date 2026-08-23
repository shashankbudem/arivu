import { basename } from "../../format";

export const STANDALONE_PROJECT_VALUE = "__standalone__";

export type ProjectSummary = {
  projectRoot: string;
  name: string;
  projectRootExists: boolean;
  latestSessionId?: string;
  updatedAt?: string;
  pinnedAt?: string;
  chatCount: number;
  sessions: SessionSummary[];
};

export type ProjectOption = {
  projectRoot: string;
  name: string;
  projectRootExists?: boolean;
  updatedAt?: string;
};

export function deriveProjects(sessions: SessionSummary[], state: DesktopState | null): ProjectSummary[] {
  const projectsByRoot = new Map<string, ProjectSummary>();

  for (const session of sessions) {
    if (session.projectRoot === null) {
      continue;
    }

    const existing = projectsByRoot.get(session.projectRoot);
    if (!existing) {
      projectsByRoot.set(session.projectRoot, {
        projectRoot: session.projectRoot,
        name: basename(session.projectRoot),
        projectRootExists: session.projectRootExists !== false,
        latestSessionId: session.id,
        updatedAt: session.updatedAt,
        pinnedAt: session.pinnedAt,
        chatCount: 1,
        sessions: [session]
      });
      continue;
    }

    existing.chatCount += 1;
    existing.sessions.push(session);
    if (session.projectRootExists === false) {
      existing.projectRootExists = false;
    }
    if (session.pinnedAt && (!existing.pinnedAt || session.pinnedAt > existing.pinnedAt)) {
      existing.pinnedAt = session.pinnedAt;
    }
    if (!existing.updatedAt || session.updatedAt > existing.updatedAt) {
      existing.latestSessionId = session.id;
      existing.updatedAt = session.updatedAt;
    }
  }

  const projects = Array.from(projectsByRoot.values()).sort(compareProjectsForDisplay);
  for (const project of projects) {
    project.sessions.sort(compareSessionsForDisplay);
  }

  if (!state || state.projectRoot === null) {
    return projects;
  }

  const existingActiveProject = projectsByRoot.get(state.projectRoot);
  const activeProject = existingActiveProject ?? {
    projectRoot: state.projectRoot,
    name: state.workspace.packageName ?? basename(state.workspace.root),
    projectRootExists: true,
    chatCount: 0,
    sessions: []
  };
  activeProject.name = state.workspace.packageName ?? basename(state.workspace.root);

  return [activeProject, ...projects.filter((project) => project.projectRoot !== activeProject.projectRoot)];
}

export function compareProjectsForDisplay(left: ProjectSummary, right: ProjectSummary) {
  if (left.pinnedAt || right.pinnedAt) {
    if (!left.pinnedAt) {
      return 1;
    }
    if (!right.pinnedAt) {
      return -1;
    }
    return right.pinnedAt.localeCompare(left.pinnedAt);
  }
  return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
}

export function compareSessionsForDisplay(left: SessionSummary, right: SessionSummary) {
  if (left.pinnedAt || right.pinnedAt) {
    if (!left.pinnedAt) {
      return 1;
    }
    if (!right.pinnedAt) {
      return -1;
    }
    return right.pinnedAt.localeCompare(left.pinnedAt);
  }
  return right.updatedAt.localeCompare(left.updatedAt);
}
