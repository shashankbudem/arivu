import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  parseWorkspacePolicyBundle,
  WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH,
  type WorkspacePolicyBundle
} from "../../src/permissions/workspacePolicyBundles.js";
import { relativeToWorkspace, resolveSafeWorkspacePath } from "../../src/tools/pathSafety.js";

const WORKSPACE_POLICY_BUNDLE_MAX_BYTES = 64 * 1024;

export type WorkspacePolicyBundleResult = {
  path: string;
  exists: boolean;
  bundle: WorkspacePolicyBundle | null;
  error?: string;
};

export async function readWorkspacePolicyBundleFromRoot(workspaceRoot: string): Promise<WorkspacePolicyBundleResult> {
  const fallbackPath = path.join(workspaceRoot, WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH);
  let bundlePath = fallbackPath;
  try {
    bundlePath = await resolveSafeWorkspacePath(workspaceRoot, WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { path: fallbackPath, exists: false, bundle: null };
    }
    return { path: fallbackPath, exists: true, bundle: null, error: formatError(error) };
  }

  try {
    const bundleStat = await stat(bundlePath);
    if (!bundleStat.isFile()) {
      return {
        path: bundlePath,
        exists: true,
        bundle: null,
        error: "Workspace policy bundle path exists but is not a file."
      };
    }
    if (bundleStat.size > WORKSPACE_POLICY_BUNDLE_MAX_BYTES) {
      return {
        path: bundlePath,
        exists: true,
        bundle: null,
        error: `Workspace policy bundle is larger than ${formatBytes(WORKSPACE_POLICY_BUNDLE_MAX_BYTES)}.`
      };
    }
    const bundleText = await readFile(bundlePath, "utf8");
    return {
      path: bundlePath,
      exists: true,
      bundle: parseWorkspacePolicyBundle(bundleText, relativeToWorkspace(workspaceRoot, bundlePath))
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return { path: bundlePath, exists: false, bundle: null };
    }
    return { path: bundlePath, exists: true, bundle: null, error: formatError(error) };
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
