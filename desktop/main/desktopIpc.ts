import path from "node:path";
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { ApiRequestLogEntry } from "../../src/agent/OpenAICompatibleChatClient.js";
import type { CreateSkillInput } from "../../src/agent/skills.js";
import type { PromptPayload } from "../../src/agent/promptPayload.js";
import type { BrowserMode } from "../../src/tools/browserControl.js";
import type { ElicitationResponse } from "../../src/tools/elicitation.js";
import type { DesktopBrowserController } from "./browserController.js";
import type { ConfigPatch } from "./configBridge.js";
import {
  type DesktopController,
  type OpenTaskRunEvidenceInput,
  type SessionUpdateInput,
  type TaskRunPlanActionInput,
  type TaskWorktreeActionInput
} from "./desktopController.js";
import { readImageAttachment } from "./desktopAttachments.js";
import type { DesktopInteractionBroker } from "./desktopInteractionBroker.js";
import { isTrustedAppNavigationUrl } from "./navigationSafety.js";
import type { WorkspaceScaffoldOptions } from "./workspaceScaffold.js";

export type DesktopIpcDependencies = {
  controller: DesktopController;
  browserController: DesktopBrowserController;
  interactionBroker: DesktopInteractionBroker;
  apiRequestLog: ApiRequestLogEntry[];
  getMainWindow: () => BrowserWindow | undefined;
  devUrl: string | undefined;
  rendererIndex: string;
};

export function registerDesktopIpc({
  controller,
  browserController,
  interactionBroker,
  apiRequestLog,
  getMainWindow,
  devUrl,
  rendererIndex
}: DesktopIpcDependencies) {
  handleFromMain("app:getState", () => controller.state());
  handleFromMain("workspace:choose", () => controller.chooseWorkspace());
  handleFromMain("workspace:open", (_event, workspaceRoot: string) => controller.openWorkspace(workspaceRoot));
  handleFromMain("images:choose", () => controller.chooseImages());
  handleFromMain("images:readLocal", (_event, filePath: string) => controller.readLocalImage(filePath));
  handleFromMain("files:chooseContext", () => controller.chooseContextFiles());
  handleFromMain("workspace:create", (_event, options: WorkspaceScaffoldOptions) => controller.createWorkspace(options));
  handleFromMain("project:justChats", () => controller.openJustChats());
  handleFromMain("project:selectForChat", (_event, projectRoot: string | null) => controller.selectChatProject(projectRoot));
  handleFromMain("project:forgetMissing", (_event, projectRoot: string) => controller.forgetMissingProject(projectRoot));
  handleFromMain("sessions:list", () => controller.listSessions());
  handleFromMain("sessions:open", (_event, id: string) => controller.openSession(id));
  handleFromMain("sessions:new", () => controller.newChat());
  handleFromMain("sessions:update", (_event, input: SessionUpdateInput) => controller.updateSession(input));
  handleFromMain("sessions:delete", (_event, id: string) => controller.deleteSession(id));
  handleFromMain("context:compact", () => controller.compactContext());
  handleFromMain("context:summarize", () => controller.summarizeContext());
  handleFromMain("apiRequestLog:list", () => apiRequestLog.slice().reverse());
  handleFromMain("apiRequestLog:clear", () => {
    apiRequestLog.length = 0;
    return true;
  });
  handleFromMain("config:save", (_event, patch: ConfigPatch) => controller.saveConfigPatch(patch));
  handleFromMain("models:list", (_event, patch: ConfigPatch) => controller.listModels(patch));
  handleFromMain("doctor:run", (_event, patch: ConfigPatch) => controller.doctor(patch));
  handleFromMain("tools:list", () => controller.listTools());
  handleFromMain("policy:list", () => controller.listCapabilityPolicies());
  handleFromMain("policy:readWorkspaceBundle", () => controller.readWorkspacePolicyBundle());
  handleFromMain("skills:list", () => controller.listSkills());
  handleFromMain("skills:create", (_event, input: CreateSkillInput) => controller.createSkill(input));
  handleFromMain("agent:listTaskWorktrees", () => controller.listTaskWorktrees());
  handleFromMain("agent:sendPrompt", (event, prompt: PromptPayload) => controller.sendPrompt(prompt, event.sender));
  handleFromMain("agent:queuePrompt", (_event, prompt: PromptPayload) => controller.queuePrompt(prompt));
  handleFromMain("agent:steerQueuedPrompt", (_event, promptId: string) => controller.steerQueuedPrompt(promptId));
  handleFromMain("agent:stopLoop", (_event, sessionId?: string) => controller.stopAgentLoop(sessionId));
  handleFromMain("agent:stopRun", (_event, sessionId?: string) => controller.stopAgentRun(sessionId));
  handleFromMain("agent:undoRun", (_event, input: { sessionId?: string; taskRunId: string }) => controller.undoTaskRun(input));
  handleFromMain("agent:taskWorktreeAction", (_event, input: TaskWorktreeActionInput) => controller.taskWorktreeAction(input));
  handleFromMain("agent:taskRunPlanAction", (_event, input: TaskRunPlanActionInput) => controller.taskRunPlanAction(input));
  handleFromMain("agent:openTaskRunEvidence", (_event, input: OpenTaskRunEvidenceInput) => controller.openTaskRunEvidence(input));
  handleFromMain("browser:getState", () => browserController.getState());
  handleFromMain("browser:setPaneOpen", (_event, open: boolean) => browserController.setPaneOpen(Boolean(open)));
  handleFromMain("browser:togglePaneOpen", () => browserController.togglePaneOpen());
  handleFromMain("browser:setDefaultMode", (_event, mode: BrowserMode) => browserController.setDefaultMode(mode));
  handleFromMain("browser:open", (_event, args: { url: string; mode?: BrowserMode; tabId?: string; newTab?: boolean }) =>
    browserController.open(args)
  );
  handleFromMain("browser:newTab", (_event, args?: { url?: string }) => browserController.newVisibleTab(args ?? {}));
  handleFromMain("browser:selectTab", (_event, tabId: string) => browserController.selectVisibleTab(tabId));
  handleFromMain("browser:closeTab", (_event, tabId: string) => browserController.closeVisibleTab(tabId));
  handleFromMain("browser:goBack", (_event, args?: BrowserMode | { mode?: BrowserMode; tabId?: string }) =>
    typeof args === "object" ? browserController.goBack(args.mode, args.tabId) : browserController.goBack(args)
  );
  handleFromMain("browser:goForward", (_event, args?: BrowserMode | { mode?: BrowserMode; tabId?: string }) =>
    typeof args === "object" ? browserController.goForward(args.mode, args.tabId) : browserController.goForward(args)
  );
  handleFromMain("browser:reload", (_event, args?: BrowserMode | { mode?: BrowserMode; tabId?: string }) =>
    typeof args === "object" ? browserController.reload(args.mode, args.tabId) : browserController.reload(args)
  );
  handleFromMain("browser:stop", (_event, args?: BrowserMode | { mode?: BrowserMode; tabId?: string }) =>
    typeof args === "object" ? browserController.stop(args.mode, args.tabId) : browserController.stop(args)
  );
  handleFromMain("browser:screenshot", (_event, args: { mode?: BrowserMode; tabId?: string }) => browserController.screenshot(args ?? {}));
  handleFromMain("approval:respond", (_event, response: { id: string; approved: boolean }) => {
    interactionBroker.respondToApproval(response);
  });
  handleFromMain("elicitation:chooseFiles", async (_event, kind: "images" | "files") => {
    const result = await dialog.showOpenDialog({
      title: kind === "images" ? "Choose images" : "Choose files",
      properties: ["openFile", "multiSelections"],
      ...(kind === "images" ? { filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }] } : {})
    });
    if (result.canceled) {
      return { files: [] };
    }
    const files = await Promise.all(
      result.filePaths.map(async (filePath) => {
        const base = { path: filePath, name: path.basename(filePath) };
        if (kind !== "images") {
          return base;
        }
        try {
          const image = await readImageAttachment(filePath);
          return { ...base, previewDataUrl: image.dataUrl };
        } catch {
          // Preview is decorative; the ordered path is the answer.
          return base;
        }
      })
    );
    return { files };
  });
  handleFromMain("elicitation:respond", (_event, payload: { id: string; response: ElicitationResponse }) => {
    interactionBroker.respondToElicitation(payload);
  });

  function handleFromMain<T extends unknown[]>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: T) => unknown | Promise<unknown>
  ) {
    ipcMain.handle(channel, (event, ...args: T) => {
      assertTrustedIpcSender(event);
      return listener(event, ...args);
    });
  }

  function assertTrustedIpcSender(event: IpcMainInvokeEvent) {
    const mainWindow = getMainWindow();
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error("Refused IPC request from an untrusted sender.");
    }
    if (!event.senderFrame || !isTrustedAppNavigationUrl(event.senderFrame.url, { devUrl, rendererIndex })) {
      throw new Error("Refused IPC request from an untrusted frame.");
    }
  }
}
