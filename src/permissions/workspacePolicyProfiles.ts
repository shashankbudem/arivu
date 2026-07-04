import type { WorkspaceCapabilityPolicy, WorkspacePolicyProfiles } from "../config.js";
import { normalizeWorkspaceScopePolicyRules } from "./scopePolicy.js";
import { normalizeWorkspacePolicyPresetOverrides } from "./workspacePolicyPresets.js";

export function normalizeWorkspacePolicyProfiles(profiles: WorkspacePolicyProfiles | undefined): WorkspacePolicyProfiles {
  const normalized = Object.entries(profiles ?? {})
    .map(([name, policy]) => {
      const normalizedName = normalizeWorkspacePolicyProfileName(name);
      if (!normalizedName) {
        return undefined;
      }
      return [
        normalizedName,
        {
          overrides: normalizeWorkspacePolicyPresetOverrides(policy.overrides ?? {}),
          scopeRules: normalizeWorkspaceScopePolicyRules(policy.scopeRules)
        }
      ] as const;
    })
    .filter((entry): entry is readonly [string, WorkspaceCapabilityPolicy] => Boolean(entry));
  return Object.fromEntries(normalized.sort(([left], [right]) => left.localeCompare(right)));
}

export function normalizeWorkspacePolicyProfileName(name: string) {
  return name.trim().replace(/\s+/g, " ").slice(0, 80);
}
