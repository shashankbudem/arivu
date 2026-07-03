import { realpath } from "node:fs/promises";
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

export async function resolveSafeWorkspacePath(workspaceRoot: string, requestedPath: string): Promise<string> {
  const resolved = resolveWorkspacePath(workspaceRoot, requestedPath);
  await assertRealPathInsideWorkspace(workspaceRoot, resolved, requestedPath);
  return resolved;
}

export async function assertRealPathInsideWorkspace(workspaceRoot: string, resolvedPath: string, requestedPath = resolvedPath): Promise<void> {
  const rootRealPath = await realpath(path.resolve(workspaceRoot));
  const targetRealPath = await realpathExistingTargetOrParent(resolvedPath);

  if (isInsidePath(rootRealPath, targetRealPath)) {
    return;
  }

  throw new Error(`Path escapes workspace through symlink: ${requestedPath}`);
}

export function relativeToWorkspace(workspaceRoot: string, fullPath: string): string {
  return path.relative(workspaceRoot, fullPath) || ".";
}

function isInsidePath(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathExistingTargetOrParent(targetPath: string): Promise<string> {
  let candidate = path.resolve(targetPath);

  while (true) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      candidate = parent;
    }
  }
}

function isMissingPathError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
