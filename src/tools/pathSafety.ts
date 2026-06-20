import path from "node:path";

export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  if (!requestedPath || requestedPath.trim() === "") {
    throw new Error("Path is required.");
  }

  const resolved = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(workspaceRoot, requestedPath);
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, resolved);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }

  throw new Error(`Path escapes workspace: ${requestedPath}`);
}

export function relativeToWorkspace(workspaceRoot: string, fullPath: string): string {
  return path.relative(workspaceRoot, fullPath) || ".";
}

