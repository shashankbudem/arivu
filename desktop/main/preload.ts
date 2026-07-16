import { contextBridge, ipcRenderer } from "electron";

const desktopApi = {
  getState: () => ipcRenderer.invoke("app:getState"),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  openWorkspace: (workspaceRoot: string) => ipcRenderer.invoke("workspace:open", workspaceRoot),
  chooseImages: () => ipcRenderer.invoke("images:choose"),
  readLocalImage: (filePath: string) => ipcRenderer.invoke("images:readLocal", filePath),
  chooseContextFiles: () => ipcRenderer.invoke("files:chooseContext"),
  createWorkspace: (options: unknown) => ipcRenderer.invoke("workspace:create", options),
  openJustChats: () => ipcRenderer.invoke("project:justChats"),
  selectChatProject: (projectRoot: string | null) => ipcRenderer.invoke("project:selectForChat", projectRoot),
  forgetMissingProject: (projectRoot: string) => ipcRenderer.invoke("project:forgetMissing", projectRoot),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  openSession: (id: string) => ipcRenderer.invoke("sessions:open", id),
  newChat: () => ipcRenderer.invoke("sessions:new"),
  updateSession: (input: unknown) => ipcRenderer.invoke("sessions:update", input),
  deleteSession: (id: string) => ipcRenderer.invoke("sessions:delete", id),
  compactContext: () => ipcRenderer.invoke("context:compact"),
  summarizeContext: () => ipcRenderer.invoke("context:summarize"),
  saveConfig: (patch: unknown) => ipcRenderer.invoke("config:save", patch),
  listModels: (patch: unknown) => ipcRenderer.invoke("models:list", patch),
  runDoctor: (patch: unknown) => ipcRenderer.invoke("doctor:run", patch),
  listTools: () => ipcRenderer.invoke("tools:list"),
  getApiRequestLog: () => ipcRenderer.invoke("apiRequestLog:list"),
  clearApiRequestLog: () => ipcRenderer.invoke("apiRequestLog:clear"),
  listCapabilityPolicies: () => ipcRenderer.invoke("policy:list"),
  readWorkspacePolicyBundle: () => ipcRenderer.invoke("policy:readWorkspaceBundle"),
  listSkills: () => ipcRenderer.invoke("skills:list"),
  createSkill: (input: unknown) => ipcRenderer.invoke("skills:create", input),
  listTaskWorktrees: () => ipcRenderer.invoke("agent:listTaskWorktrees"),
  sendPrompt: (prompt: unknown) => ipcRenderer.invoke("agent:sendPrompt", prompt),
  stopAgentLoop: (sessionId?: string) => ipcRenderer.invoke("agent:stopLoop", sessionId),
  stopAgentRun: (sessionId?: string) => ipcRenderer.invoke("agent:stopRun", sessionId),
  undoTaskRun: (input: { sessionId?: string; taskRunId: string }) => ipcRenderer.invoke("agent:undoRun", input),
  taskWorktreeAction: (input: unknown) => ipcRenderer.invoke("agent:taskWorktreeAction", input),
  taskRunPlanAction: (input: unknown) => ipcRenderer.invoke("agent:taskRunPlanAction", input),
  openTaskRunEvidence: (input: unknown) => ipcRenderer.invoke("agent:openTaskRunEvidence", input),
  getBrowserState: () => ipcRenderer.invoke("browser:getState"),
  setBrowserPaneOpen: (open: boolean) => ipcRenderer.invoke("browser:setPaneOpen", open),
  setBrowserDefaultMode: (mode: unknown) => ipcRenderer.invoke("browser:setDefaultMode", mode),
  openBrowserUrl: (args: unknown) => ipcRenderer.invoke("browser:open", args),
  browserNewTab: (args?: unknown) => ipcRenderer.invoke("browser:newTab", args),
  browserSelectTab: (tabId: string) => ipcRenderer.invoke("browser:selectTab", tabId),
  browserCloseTab: (tabId: string) => ipcRenderer.invoke("browser:closeTab", tabId),
  browserGoBack: (args?: unknown) => ipcRenderer.invoke("browser:goBack", args),
  browserGoForward: (args?: unknown) => ipcRenderer.invoke("browser:goForward", args),
  browserReload: (args?: unknown) => ipcRenderer.invoke("browser:reload", args),
  browserStop: (args?: unknown) => ipcRenderer.invoke("browser:stop", args),
  captureBrowserScreenshot: (args?: unknown) => ipcRenderer.invoke("browser:screenshot", args),
  respondApproval: (id: string, approved: boolean) => ipcRenderer.invoke("approval:respond", { id, approved }),
  onApprovalRequest: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("approval:request", listener);
    return () => ipcRenderer.removeListener("approval:request", listener);
  },
  onAgentEvent: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  onSessionEvent: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("session:event", listener);
    return () => ipcRenderer.removeListener("session:event", listener);
  },
  onBrowserState: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("browser:state", listener);
    return () => ipcRenderer.removeListener("browser:state", listener);
  },
  onApiRequestLog: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("apiRequestLog:entry", listener);
    return () => ipcRenderer.removeListener("apiRequestLog:entry", listener);
  }
};

contextBridge.exposeInMainWorld("arivu", desktopApi);
contextBridge.exposeInMainWorld("shankinster", desktopApi);
