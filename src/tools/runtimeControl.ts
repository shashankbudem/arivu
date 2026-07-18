import type { BrowserTaskModelConfig } from "./browserControl.js";

export type RuntimeControlScope = "run" | "session";

export type RuntimeBrowserModelSummary = {
  id: string;
  model: string;
  providerId?: string;
  providerName?: string;
  endpoint: string;
  active: boolean;
};

export type RuntimeControlStatus = {
  browserModel: RuntimeBrowserModelSummary;
  browserModelCandidates: RuntimeBrowserModelSummary[];
  disabledTools: string[];
  runDisabledTools: string[];
  sessionDisabledTools: string[];
  protectedTools: string[];
  toolProposalMode: "review_required";
};

export type RuntimeToolStateChange = {
  name: string;
  requestedState: "enabled" | "disabled";
  scope: RuntimeControlScope;
  effectiveState: "enabled" | "disabled";
  reason: string;
  note?: string;
};

export type RuntimeBrowserModelChange = {
  candidateId: string;
  scope: RuntimeControlScope;
  model: RuntimeBrowserModelSummary;
  reason: string;
};

export type RuntimeMcpServerProposalInput = {
  name: string;
  description: string;
  command: string;
  args: string[];
  envKeys: string[];
  reason: string;
};

export type RuntimeMcpServerProposalResult = {
  id: string;
  name: string;
  status: "pending_review";
  reviewLocation: "Settings > Integrations";
};

export interface RuntimeControl {
  status(): Promise<RuntimeControlStatus>;
  setAvailableToolNames(names: string[]): void;
  setToolState(input: { name: string; enabled: boolean; scope: RuntimeControlScope; reason: string }): Promise<RuntimeToolStateChange>;
  selectBrowserModel(input: { candidateId: string; scope: RuntimeControlScope; reason: string }): Promise<RuntimeBrowserModelChange>;
  proposeMcpServer(input: RuntimeMcpServerProposalInput): Promise<RuntimeMcpServerProposalResult>;
  currentBrowserTaskModel(): BrowserTaskModelConfig;
  disabledToolNames(): Promise<string[]>;
}
