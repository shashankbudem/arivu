import { createHash } from "node:crypto";
import type { AgentSession, AgentTaskRun, AgentTaskRunArtifact } from "../../src/agent/types.js";

export function parseSavedPullRequestCheckLogCommand(command: string | undefined) {
  const ghMatch = /^gh run view '([^']+)' --repo '([^']+)'(?: --job '([^']+)')? (--log(?:-failed)?)$/.exec(command ?? "");
  if (ghMatch) {
    const [, runId, repo, jobId, logFlag] = ghMatch;
    if (!runId || !/^\d+$/.test(runId) || !repo || !logFlag || (jobId !== undefined && !/^\d+$/.test(jobId))) {
      throw new Error("Unsupported PR check evidence command.");
    }
    return {
      source: "github_actions" as const,
      file: "gh",
      runId,
      jobId,
      args: ["run", "view", runId, "--repo", repo, ...(jobId ? ["--job", jobId] : []), logFlag]
    };
  }
  const curlMatch = /^curl -L --max-time 30 --silent --show-error '([^']+)'$/.exec(command ?? "");
  if (!curlMatch?.[1]) {
    throw new Error("Unsupported PR check evidence command.");
  }
  const url = curlMatch[1];
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Unsupported PR check evidence command.");
  }
  return {
    source: "details_url" as const,
    file: "curl",
    url,
    args: ["-L", "--max-time", "30", "--silent", "--show-error", url]
  };
}

export function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function safeArtifactSegment(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "check"
  );
}

export function truncateInlineText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

export function taskRunExecutionRoot(session: AgentSession, taskRun: AgentTaskRun) {
  const worktree = taskRun.worktree;
  if (worktree?.enabled && worktree.path && !["discarded", "cleaned"].includes(worktree.status)) {
    return worktree.path;
  }
  return session.cwd;
}

export function taskRunArtifactIncludesEvidencePath(artifact: AgentTaskRunArtifact, requestedPath: string) {
  if (artifact.kind !== "command_output") {
    return false;
  }

  const paths = new Set<string>();
  for (const reportPath of artifact.reportPaths ?? []) {
    paths.add(reportPath);
  }
  for (const report of artifact.testReports ?? []) {
    paths.add(report.path);
    for (const failure of report.failedTests ?? []) {
      if (failure.file) {
        paths.add(failure.file);
      }
    }
    for (const finding of report.findingDetails ?? []) {
      if (finding.path) {
        paths.add(finding.path);
      }
    }
  }
  for (const diagnostic of artifact.diagnostics ?? []) {
    if (diagnostic.path) {
      paths.add(diagnostic.path);
    }
  }

  return paths.has(requestedPath);
}
