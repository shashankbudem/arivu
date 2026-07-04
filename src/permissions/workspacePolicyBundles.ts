import {
  parseWorkspacePolicyTransfer,
  type WorkspacePolicyTransferPayload
} from "./workspacePolicyTransfer.js";

export const WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH = ".arivu/workspace-policy.json";

export type WorkspacePolicyBundle = WorkspacePolicyTransferPayload & {
  name: string;
  description?: string;
  sourcePath: string;
};

export function parseWorkspacePolicyBundle(
  text: string,
  sourcePath = WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH
): WorkspacePolicyBundle {
  const container = parseJsonObject(text);
  const policy = parseWorkspacePolicyTransfer(text);
  return {
    ...policy,
    name: normalizeWorkspacePolicyBundleText(container.name, "Workspace policy bundle", 80),
    description: normalizeWorkspacePolicyBundleOptionalText(container.description, 280),
    sourcePath
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    throw new Error("Workspace policy bundle must be valid JSON.");
  }
  throw new Error("Workspace policy bundle must be a JSON object.");
}

function normalizeWorkspacePolicyBundleText(value: unknown, fallback: string, maxLength: number) {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength) || fallback;
}

function normalizeWorkspacePolicyBundleOptionalText(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength) || undefined;
}
