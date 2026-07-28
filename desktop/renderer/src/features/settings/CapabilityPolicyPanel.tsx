import { useState } from "react";
import { Check, Copy, FileText, RefreshCw, Save, Shield, Trash2 } from "lucide-react";
import { formatError, writeClipboardText } from "../../format";
import { capabilityLabel, policyEffectLabel, trustModeLabel } from "../activity/capabilityPresentation";
import { scopePolicySummaryItems } from "../../../../../src/permissions/scopePolicy";
import {
  WORKSPACE_POLICY_PRESETS,
  workspacePolicyPresetMatches,
  type WorkspacePolicyPreset
} from "../../../../../src/permissions/workspacePolicyPresets";
import {
  normalizeWorkspacePolicyProfileName,
  normalizeWorkspacePolicyProfiles
} from "../../../../../src/permissions/workspacePolicyProfiles";
import { WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH } from "../../../../../src/permissions/workspacePolicyBundles";
import {
  parseWorkspacePolicyTransfer,
  serializeWorkspacePolicyTransfer,
  workspacePolicyTransferPayload,
  type WorkspacePolicyTransferPayload
} from "../../../../../src/permissions/workspacePolicyTransfer";

const TRUST_MODE_ORDER: TrustMode[] = ["readonly", "ask", "trusted"];

const WORKSPACE_POLICY_CAPABILITIES: WorkspacePolicyCapability[] = [
  "read_repo",
  "write_workspace",
  "run_command",
  "network_fetch",
  "browser_control",
  "mcp_call",
  "unknown"
];

export function CapabilityPolicyPanel({
  activeTrustMode,
  policies,
  source,
  workspaceRoot,
  workspaceOverrides,
  workspaceScopeRules,
  workspacePolicyProfiles,
  workspacePolicyBundle,
  workspacePolicyBundleLoading,
  workspacePolicyBundleError,
  onWorkspaceOverrideChange,
  onWorkspaceScopeRulesChange,
  onWorkspacePolicyProfilesChange,
  onWorkspacePresetApply,
  onWorkspacePolicyImport,
  onWorkspacePolicyBundleReload,
  loading,
  error,
  onRefresh
}: {
  activeTrustMode: TrustMode;
  policies: CapabilityPolicySummary[];
  source: CapabilityPolicyResult["source"];
  workspaceRoot: string;
  workspaceOverrides: WorkspaceCapabilityPolicyOverrides;
  workspaceScopeRules: WorkspaceScopePolicyRules;
  workspacePolicyProfiles: WorkspacePolicyProfiles;
  workspacePolicyBundle: WorkspacePolicyBundleResult | null;
  workspacePolicyBundleLoading: boolean;
  workspacePolicyBundleError: string | null;
  onWorkspaceOverrideChange: (capability: WorkspacePolicyCapability, override: CapabilityPolicyOverrideEffect | "inherit") => void;
  onWorkspaceScopeRulesChange: (rules: WorkspaceScopePolicyRules) => void;
  onWorkspacePolicyProfilesChange: (profiles: WorkspacePolicyProfiles) => void;
  onWorkspacePresetApply: (preset: WorkspacePolicyPreset) => void;
  onWorkspacePolicyImport: (policy: WorkspacePolicyTransferPayload) => void;
  onWorkspacePolicyBundleReload: () => void;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const [profileName, setProfileName] = useState("");
  const [selectedProfileName, setSelectedProfileName] = useState("");
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [teamBundleStatus, setTeamBundleStatus] = useState<string | null>(null);
  const [teamBundleError, setTeamBundleError] = useState<string | null>(null);
  const [transferText, setTransferText] = useState("");
  const [transferStatus, setTransferStatus] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const activeScopeItems = scopePolicySummaryItems(workspaceScopeRules);
  const profileEntries = Object.entries(normalizeWorkspacePolicyProfiles(workspacePolicyProfiles));
  const selectedProfile = selectedProfileName ? workspacePolicyProfiles[selectedProfileName] : undefined;
  const selectedProfileValue = selectedProfile ? selectedProfileName : "";
  const activePresetId = WORKSPACE_POLICY_PRESETS.find((preset) =>
    workspacePolicyPresetMatches(preset, workspaceOverrides, workspaceScopeRules)
  )?.id;
  const teamBundle = workspacePolicyBundle?.bundle ?? null;
  const teamBundleProblem = workspacePolicyBundleError ?? workspacePolicyBundle?.error ?? null;

  function reloadWorkspacePolicyBundle() {
    setTeamBundleStatus(null);
    setTeamBundleError(null);
    onWorkspacePolicyBundleReload();
  }

  function applyWorkspacePolicyBundle() {
    setTeamBundleStatus(null);
    setTeamBundleError(null);
    if (!teamBundle) {
      setTeamBundleError(teamBundleProblem || `No team bundle found at ${WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH}.`);
      return;
    }
    const policy = workspacePolicyTransferPayload(teamBundle.overrides, teamBundle.scopeRules);
    onWorkspacePolicyImport(policy);
    setTeamBundleStatus(`Applied "${teamBundle.name}". Save settings to persist workspace changes.`);
  }

  function saveWorkspacePolicyProfile() {
    const name = normalizeWorkspacePolicyProfileName(profileName);
    setProfileStatus(null);
    setProfileError(null);
    if (!name) {
      setProfileError("Enter a profile name before saving.");
      return;
    }
    const policy = workspacePolicyTransferPayload(workspaceOverrides, workspaceScopeRules);
    onWorkspacePolicyProfilesChange(
      normalizeWorkspacePolicyProfiles({
        ...workspacePolicyProfiles,
        [name]: {
          overrides: policy.overrides,
          scopeRules: policy.scopeRules
        }
      })
    );
    setProfileName(name);
    setSelectedProfileName(name);
    setProfileStatus(`Saved "${name}" as a profile. Save settings to persist it.`);
  }

  function applyWorkspacePolicyProfile() {
    setProfileStatus(null);
    setProfileError(null);
    if (!selectedProfile) {
      setProfileError("Choose a profile before applying.");
      return;
    }
    const policy = workspacePolicyTransferPayload(selectedProfile.overrides, selectedProfile.scopeRules);
    onWorkspacePolicyImport(policy);
    setProfileStatus(`Applied "${selectedProfileName}". Save settings to persist workspace changes.`);
  }

  function deleteWorkspacePolicyProfile() {
    setProfileStatus(null);
    setProfileError(null);
    if (!selectedProfile) {
      setProfileError("Choose a profile before deleting.");
      return;
    }
    const next = { ...workspacePolicyProfiles };
    delete next[selectedProfileName];
    onWorkspacePolicyProfilesChange(normalizeWorkspacePolicyProfiles(next));
    setSelectedProfileName("");
    setProfileStatus(`Deleted "${selectedProfileName}". Save settings to persist it.`);
  }

  async function copyWorkspacePolicyJson() {
    const text = serializeWorkspacePolicyTransfer(workspaceOverrides, workspaceScopeRules);
    setTransferText(text);
    setTransferError(null);
    try {
      await writeClipboardText(text);
      setTransferStatus("Workspace policy JSON copied.");
    } catch (err) {
      setTransferStatus(null);
      setTransferError(`Workspace policy JSON is ready below, but clipboard copy failed: ${formatError(err)}`);
    }
  }

  function applyWorkspacePolicyJson() {
    setTransferStatus(null);
    setTransferError(null);
    try {
      const policy = parseWorkspacePolicyTransfer(transferText);
      onWorkspacePolicyImport(policy);
      setTransferText(serializeWorkspacePolicyTransfer(policy.overrides, policy.scopeRules));
      setTransferStatus("Workspace policy JSON imported. Save settings to persist it.");
    } catch (err) {
      setTransferError(formatError(err));
    }
  }

  return (
    <section className="skills-settings-section policy-settings-section" aria-label="Capability policy">
      <div className="settings-section-heading">
        <div>
          <strong>Capability policy</strong>
          <span>{capabilityPolicySummary(policies, activeTrustMode, source, loading)}</span>
        </div>
        <button className="secondary-command" type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} />
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </div>

      {error ? <div className="error-strip">{error}</div> : null}

      <div className="workspace-policy-box">
        <div className="workspace-policy-heading">
          <div>
            <strong>Workspace overrides</strong>
            <span title={workspaceRoot}>{workspaceRoot}</span>
          </div>
          <p>Tighten this workspace without changing the built-in {trustModeLabel(activeTrustMode)} posture.</p>
        </div>
        <div className="workspace-preset-grid" aria-label="Workspace policy presets">
          {WORKSPACE_POLICY_PRESETS.map((preset) => {
            const selected = preset.id === activePresetId;
            return (
              <button
                key={preset.id}
                className={`workspace-preset-button${selected ? " active" : ""}`}
                type="button"
                onClick={() => onWorkspacePresetApply(preset)}
                aria-pressed={selected}
              >
                <span className="workspace-preset-icon">
                  <Shield size={14} />
                </span>
                <span className="workspace-preset-copy">
                  <strong>{preset.label}</strong>
                  <small>{preset.description}</small>
                </span>
                {selected ? <Check size={14} className="workspace-preset-check" /> : null}
              </button>
            );
          })}
        </div>
        <div className={`workspace-policy-team-bundle${teamBundleProblem ? " has-error" : teamBundle ? " has-bundle" : ""}`}>
          <div className="workspace-policy-team-copy">
            <strong>Team bundle</strong>
            <small title={workspacePolicyBundle?.path ?? WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH}>
              {workspacePolicyBundleLoading
                ? "Checking workspace bundle"
                : teamBundle
                  ? `${teamBundle.name} · ${workspacePolicyBundle?.path ?? teamBundle.sourcePath}`
                  : teamBundleProblem
                    ? `Invalid ${WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH}`
                    : `No ${WORKSPACE_POLICY_BUNDLE_RELATIVE_PATH}`}
            </small>
            {teamBundle?.description ? <p>{teamBundle.description}</p> : null}
          </div>
          <div className="workspace-policy-team-actions">
            <button
              className="secondary-command"
              type="button"
              onClick={reloadWorkspacePolicyBundle}
              disabled={workspacePolicyBundleLoading}
            >
              <RefreshCw size={14} />
              {workspacePolicyBundleLoading ? "Checking" : "Reload"}
            </button>
            <button className="secondary-command" type="button" onClick={applyWorkspacePolicyBundle} disabled={!teamBundle}>
              <FileText size={14} />
              Apply
            </button>
          </div>
          {teamBundleStatus ? <small className="workspace-policy-team-status">{teamBundleStatus}</small> : null}
          {teamBundleProblem || teamBundleError ? (
            <small className="workspace-policy-team-error">{teamBundleError ?? teamBundleProblem}</small>
          ) : null}
        </div>
        <div className="workspace-policy-profiles">
          <div className="workspace-policy-profile-save">
            <label>
              <span>Policy profile</span>
              <input
                value={profileName}
                onChange={(event) => {
                  setProfileName(event.target.value);
                  setProfileStatus(null);
                  setProfileError(null);
                }}
                placeholder="Sensitive repo"
              />
            </label>
            <button className="secondary-command" type="button" onClick={saveWorkspacePolicyProfile}>
              <Save size={14} />
              Save profile
            </button>
          </div>
          <div className="workspace-policy-profile-actions">
            <select
              value={selectedProfileValue}
              onChange={(event) => {
                setSelectedProfileName(event.target.value);
                setProfileName(event.target.value || profileName);
                setProfileStatus(null);
                setProfileError(null);
              }}
            >
              <option value="">No saved profile</option>
              {profileEntries.map(([name]) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button className="secondary-command" type="button" onClick={applyWorkspacePolicyProfile} disabled={!selectedProfile}>
              <FileText size={14} />
              Apply
            </button>
            <button
              className="secondary-command danger-command"
              type="button"
              onClick={deleteWorkspacePolicyProfile}
              disabled={!selectedProfile}
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
          {profileStatus ? <small className="workspace-policy-profile-status">{profileStatus}</small> : null}
          {profileError ? <small className="workspace-policy-profile-error">{profileError}</small> : null}
        </div>
        <div className="workspace-policy-transfer">
          <div className="workspace-policy-transfer-head">
            <strong>Workspace policy JSON</strong>
            <div className="workspace-policy-transfer-actions">
              <button className="secondary-command" type="button" onClick={() => void copyWorkspacePolicyJson()}>
                <Copy size={14} />
                Copy JSON
              </button>
              <button className="secondary-command" type="button" onClick={applyWorkspacePolicyJson} disabled={!transferText.trim()}>
                <FileText size={14} />
                Apply JSON
              </button>
            </div>
          </div>
          <textarea
            value={transferText}
            onChange={(event) => {
              setTransferText(event.target.value);
              setTransferStatus(null);
              setTransferError(null);
            }}
            spellCheck={false}
            rows={4}
            placeholder='{"kind":"arivu.workspacePolicy","version":1,"overrides":{},"scopeRules":{}}'
          />
          {transferStatus ? <small className="workspace-policy-transfer-status">{transferStatus}</small> : null}
          {transferError ? <small className="workspace-policy-transfer-error">{transferError}</small> : null}
        </div>
        <div className="workspace-policy-grid">
          {WORKSPACE_POLICY_CAPABILITIES.map((capability) => {
            const override = workspaceOverrides[capability] ?? "inherit";
            const policy = policies.find((entry) => entry.capability === capability);
            return (
              <label key={capability} className="workspace-policy-row">
                <span>{capabilityLabel(capability)}</span>
                <select
                  value={override}
                  onChange={(event) =>
                    onWorkspaceOverrideChange(capability, event.target.value as CapabilityPolicyOverrideEffect | "inherit")
                  }
                >
                  <option value="inherit">Inherit</option>
                  <option value="prompt">Require approval</option>
                  <option value="deny">Block</option>
                </select>
                <small>{workspaceOverrideNote(policy, activeTrustMode, override)}</small>
              </label>
            );
          })}
        </div>
        <small>Overrides only make this workspace stricter: they cannot turn a built-in approval or block into allow.</small>
        {activeScopeItems.length > 0 ? (
          <div className="workspace-scope-summary" aria-label="Active workspace scope rules">
            {activeScopeItems.map((item) => (
              <span key={item.label}>
                <strong>{item.label}</strong>
                {item.value}
              </span>
            ))}
          </div>
        ) : null}
        <div className="workspace-scope-grid">
          <label className="workspace-scope-field">
            <span>Blocked path prefixes</span>
            <textarea
              value={scopeListToText(workspaceScopeRules.blockedPathPrefixes)}
              onChange={(event) =>
                onWorkspaceScopeRulesChange({
                  ...workspaceScopeRules,
                  blockedPathPrefixes: scopeTextToList(event.target.value)
                })
              }
              placeholder={[".env", "secrets", "private"].join("\n")}
              rows={4}
            />
            <small>One workspace-relative prefix per line. Matching reads, writes, and patches are blocked.</small>
          </label>
          <label className="workspace-scope-field">
            <span>Allowed network domains</span>
            <textarea
              value={scopeListToText(workspaceScopeRules.allowedNetworkDomains)}
              onChange={(event) =>
                onWorkspaceScopeRulesChange({
                  ...workspaceScopeRules,
                  allowedNetworkDomains: scopeTextToList(event.target.value)
                })
              }
              placeholder={["api.tavily.com", "www.bing.com"].join("\n")}
              rows={4}
            />
            <small>Optional allowlist. When set, network tools are denied unless the destination host matches.</small>
          </label>
          <label className="workspace-scope-field">
            <span>Allowed MCP servers</span>
            <textarea
              value={scopeListToText(workspaceScopeRules.allowedMcpServers)}
              onChange={(event) =>
                onWorkspaceScopeRulesChange({
                  ...workspaceScopeRules,
                  allowedMcpServers: scopeTextToList(event.target.value)
                })
              }
              placeholder={["github", "chrome-devtools"].join("\n")}
              rows={4}
            />
            <small>Optional allowlist. When set, MCP list/call tools only use matching configured servers.</small>
          </label>
          <label className="workspace-scope-field">
            <span>Allowed browser target classes</span>
            <textarea
              value={scopeListToText(workspaceScopeRules.allowedBrowserTargetClasses)}
              onChange={(event) =>
                onWorkspaceScopeRulesChange({
                  ...workspaceScopeRules,
                  allowedBrowserTargetClasses: browserTargetClassTextToList(event.target.value)
                })
              }
              placeholder={["background", "local", "public"].join("\n")}
              rows={4}
            />
            <small>Optional allowlist. Valid classes: background, visible, local, file, public.</small>
          </label>
        </div>
      </div>

      <div className="policy-table-wrap">
        <table className="policy-table">
          <thead>
            <tr>
              <th scope="col">Capability</th>
              {TRUST_MODE_ORDER.map((mode) => (
                <th key={mode} scope="col" className={mode === activeTrustMode ? "active-policy-column" : undefined}>
                  {trustModeLabel(mode)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {policies.length === 0 ? (
              <tr>
                <td colSpan={TRUST_MODE_ORDER.length + 1} className="policy-empty">
                  {loading ? "Loading policy" : "No policy loaded"}
                </td>
              </tr>
            ) : (
              policies.map((policy) => (
                <tr key={policy.capability}>
                  <th scope="row">
                    <strong>{policy.label}</strong>
                    <span>{policy.description}</span>
                    <p className="policy-capability-risk">{policy.risk}</p>
                    <ul className="policy-example-list" aria-label={`${policy.label} examples`}>
                      {policy.examples.map((example) => (
                        <li key={example}>{example}</li>
                      ))}
                    </ul>
                    <small className="policy-default-posture">{policy.defaultPosture}</small>
                  </th>
                  {TRUST_MODE_ORDER.map((mode) => (
                    <PolicyModeCell key={`${policy.capability}:${mode}`} policy={policy} mode={mode} active={mode === activeTrustMode} />
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PolicyModeCell({ policy, mode, active }: { policy: CapabilityPolicySummary; mode: TrustMode; active: boolean }) {
  const summary = policy.modes.find((entry) => entry.trustMode === mode);
  if (!summary) {
    return <td className={active ? "active-policy-column" : undefined}>-</td>;
  }
  return (
    <td className={active ? "active-policy-column" : undefined}>
      <div className="policy-cell">
        <PolicyEffectBadge effect={summary.effect} />
        <span>{summary.label}</span>
        <small title={summary.reason}>Why: {summary.reason}</small>
        {summary.override ? (
          <small className="policy-override-note">
            Workspace override: {summary.override === "deny" ? "blocked" : "approval required"}
          </small>
        ) : null}
        {summary.riskyEffect ? (
          <small className="policy-risk-note" title={summary.riskyReason}>
            Risky action: {policyEffectLabel(summary.riskyEffect)}
          </small>
        ) : null}
      </div>
    </td>
  );
}

function PolicyEffectBadge({ effect }: { effect: CapabilityPolicyEffect }) {
  return <span className={`policy-effect-badge ${effect}`}>{policyEffectLabel(effect)}</span>;
}

export function workspacePolicyOverridesFromConfig(
  policies: WorkspaceCapabilityPolicies,
  workspaceRoot: string
): WorkspaceCapabilityPolicyOverrides {
  return policies[workspaceRoot]?.overrides ?? {};
}

export function workspaceScopeRulesFromConfig(policies: WorkspaceCapabilityPolicies, workspaceRoot: string): WorkspaceScopePolicyRules {
  return normalizeWorkspaceScopeRules(policies[workspaceRoot]?.scopeRules);
}

export function updateWorkspacePolicyOverride(
  overrides: WorkspaceCapabilityPolicyOverrides,
  capability: WorkspacePolicyCapability,
  override: CapabilityPolicyOverrideEffect | "inherit"
): WorkspaceCapabilityPolicyOverrides {
  const next = { ...overrides };
  if (override === "inherit") {
    delete next[capability];
  } else {
    next[capability] = override;
  }
  return next;
}

export function updateWorkspacePoliciesForRoot(
  policies: WorkspaceCapabilityPolicies,
  workspaceRoot: string,
  overrides: WorkspaceCapabilityPolicyOverrides,
  scopeRules: WorkspaceScopePolicyRules
): WorkspaceCapabilityPolicies {
  const next = { ...policies };
  const normalized = Object.fromEntries(
    Object.entries(overrides).filter(
      (entry): entry is [WorkspacePolicyCapability, CapabilityPolicyOverrideEffect] =>
        WORKSPACE_POLICY_CAPABILITIES.includes(entry[0] as WorkspacePolicyCapability) && (entry[1] === "prompt" || entry[1] === "deny")
    )
  );
  const normalizedScopeRules = normalizeWorkspaceScopeRules(scopeRules);
  if (Object.keys(normalized).length === 0 && !workspaceScopeRulesHaveEntries(normalizedScopeRules)) {
    delete next[workspaceRoot];
  } else {
    next[workspaceRoot] = { overrides: normalized, scopeRules: normalizedScopeRules };
  }
  return next;
}

function normalizeWorkspaceScopeRules(rules: WorkspaceScopePolicyRules | undefined): WorkspaceScopePolicyRules {
  return {
    blockedPathPrefixes: normalizeScopeList(rules?.blockedPathPrefixes),
    allowedNetworkDomains: normalizeScopeList(rules?.allowedNetworkDomains),
    allowedMcpServers: normalizeScopeList(rules?.allowedMcpServers),
    allowedBrowserTargetClasses: normalizeBrowserTargetClassList(rules?.allowedBrowserTargetClasses)
  };
}

function workspaceScopeRulesHaveEntries(rules: WorkspaceScopePolicyRules) {
  return Boolean(
    rules.blockedPathPrefixes?.length ||
    rules.allowedNetworkDomains?.length ||
    rules.allowedMcpServers?.length ||
    rules.allowedBrowserTargetClasses?.length
  );
}

function scopeListToText(values: string[] | undefined) {
  return (values ?? []).join("\n");
}

function scopeTextToList(value: string) {
  return normalizeScopeList(value.split(/\r?\n/g));
}

function browserTargetClassTextToList(value: string) {
  return normalizeBrowserTargetClassList(value.split(/\r?\n/g));
}

function normalizeScopeList(values: string[] | undefined) {
  return Array.from(new Set((values ?? []).map((entry) => entry.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function normalizeBrowserTargetClassList(values: string[] | undefined): WorkspaceScopePolicyRules["allowedBrowserTargetClasses"] {
  const normalized = normalizeScopeList(values)
    .map((entry) => entry.toLowerCase())
    .filter(
      (entry): entry is NonNullable<WorkspaceScopePolicyRules["allowedBrowserTargetClasses"]>[number] =>
        entry === "background" || entry === "visible" || entry === "local" || entry === "file" || entry === "public"
    );
  return Array.from(new Set(normalized)).sort((left, right) => left.localeCompare(right));
}

function capabilityPolicySummary(
  policies: CapabilityPolicySummary[],
  activeTrustMode: TrustMode,
  source: CapabilityPolicyResult["source"],
  loading: boolean
) {
  if (loading && policies.length === 0) {
    return "Loading policy";
  }
  const counts = { allow: 0, prompt: 0, deny: 0 };
  for (const policy of policies) {
    const mode = policy.modes.find((entry) => entry.trustMode === activeTrustMode);
    if (mode) {
      counts[mode.effect] += 1;
    }
  }
  const sourceLabel = source === "built-in" ? "built-in" : "workspace overrides";
  return `${trustModeLabel(activeTrustMode)} · ${counts.allow} allowed · ${counts.prompt} approval · ${counts.deny} blocked · ${sourceLabel}`;
}

function workspaceOverrideNote(
  policy: CapabilityPolicySummary | undefined,
  activeTrustMode: TrustMode,
  override: CapabilityPolicyOverrideEffect | "inherit"
) {
  if (override === "deny") {
    return "Blocked for this workspace.";
  }
  if (override === "prompt") {
    return "Requires approval for this workspace.";
  }
  const mode = policy?.modes.find((entry) => entry.trustMode === activeTrustMode);
  if (!mode) {
    return "Follows the selected trust mode.";
  }
  return `Inherits ${policyEffectLabel(mode.effect).toLowerCase()} from ${trustModeLabel(activeTrustMode)}.`;
}
