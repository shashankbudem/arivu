import { randomUUID } from "node:crypto";
import { app, BrowserWindow } from "electron";
import type { ApprovalPromptRequest } from "../../src/agent/types.js";
import type { ElicitationRequest, ElicitationResponse } from "../../src/tools/elicitation.js";

type ApprovalPayload = {
  id: string;
  message: string;
  request?: ApprovalPromptRequest;
};

export class DesktopInteractionBroker {
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
  private readonly pendingElicitations = new Map<string, (response: ElicitationResponse) => void>();

  constructor(private readonly getMainWindow: () => BrowserWindow | undefined) {}

  requestApproval(message: string, request?: ApprovalPromptRequest): Promise<boolean> {
    const window = this.getMainWindow();
    if (!window || window.isDestroyed()) {
      return Promise.resolve(false);
    }

    const id = randomUUID();
    const payload: ApprovalPayload = { id, message, request };
    window.webContents.send("approval:request", payload);

    return new Promise((resolve) => {
      this.pendingApprovals.set(id, resolve);
    });
  }

  requestElicitation(request: ElicitationRequest): Promise<ElicitationResponse> {
    const window = this.getMainWindow();
    if (!window || window.isDestroyed()) {
      return Promise.resolve({ status: "unavailable", note: "The desktop window is not available." });
    }

    const id = randomUUID();
    window.webContents.send("elicitation:request", { id, request });
    // A pending question signals politely and waits; it never surfaces or focuses the window.
    if (process.platform === "darwin" && !BrowserWindow.getFocusedWindow()) {
      try {
        app.dock?.bounce("informational");
      } catch {
        // Dock signaling is decorative.
      }
    }

    return new Promise((resolve) => {
      this.pendingElicitations.set(id, resolve);
    });
  }

  respondToApproval(response: { id: string; approved: boolean }) {
    const resolve = this.pendingApprovals.get(response.id);
    if (!resolve) {
      return;
    }
    this.pendingApprovals.delete(response.id);
    resolve(response.approved);
  }

  respondToElicitation(payload: { id: string; response: ElicitationResponse }) {
    const resolve = this.pendingElicitations.get(payload.id);
    if (!resolve) {
      return;
    }
    this.pendingElicitations.delete(payload.id);

    const response = payload.response;
    const status = response?.status === "answered" || response?.status === "declined" ? response.status : "declined";
    resolve({
      status,
      answers: Array.isArray(response?.answers)
        ? response.answers.map((answer) => ({
            id: String(answer?.id ?? ""),
            value: answer?.value,
            skipped: Boolean(answer?.skipped)
          }))
        : undefined
    });
  }
}
