import { describe, expect, it, vi } from "vitest";
import { RuntimeControlService } from "../desktop/main/runtimeControlService.js";

function createService() {
  const sessionDisabledTools = new Set<string>(["session_tool"]);
  const onSessionBrowserModelChange = vi.fn();
  const onProposeMcpServer = vi.fn(async (input: { name: string }) => ({
    id: "proposal-1",
    name: input.name,
    status: "pending_review" as const,
    reviewLocation: "Settings > Integrations" as const
  }));
  const service = new RuntimeControlService({
    configuredBrowserTaskModel: {
      baseUrl: "https://user:password@primary.example/v1?token=secret",
      model: "primary-model",
      apiKey: "primary-secret",
      fallbacks: [
        {
          baseUrl: "https://fallback.example/v1",
          model: "fallback-model",
          apiKey: "fallback-secret"
        },
        {
          baseUrl: "https://second.example/v1",
          model: "second-fallback"
        }
      ]
    },
    readSavedDisabledTools: async () => ["saved_tool"],
    sessionDisabledTools,
    onSessionBrowserModelChange,
    onProposeMcpServer
  });
  service.setAvailableToolNames(["ask_user", "arivu_runtime_status", "browser_task", "run", "saved_tool", "session_tool"]);
  return { service, sessionDisabledTools, onSessionBrowserModelChange, onProposeMcpServer };
}

describe("RuntimeControlService", () => {
  it("reports sanitized model candidates and effective tool state", async () => {
    const { service } = createService();

    await expect(service.status()).resolves.toMatchObject({
      browserModel: {
        id: "active",
        model: "primary-model",
        endpoint: "https://primary.example/v1",
        active: true
      },
      browserModelCandidates: [
        { id: "primary", model: "primary-model", active: true },
        { id: "fallback-1", model: "fallback-model", active: false },
        { id: "fallback-2", model: "second-fallback", active: false }
      ],
      disabledTools: ["saved_tool", "session_tool"],
      runDisabledTools: [],
      sessionDisabledTools: ["session_tool"],
      protectedTools: ["arivu_runtime_status", "ask_user"],
      toolProposalMode: "review_required"
    });

    const serialized = JSON.stringify(await service.status());
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("secret");
  });

  it("applies run and session tool changes without overriding saved settings", async () => {
    const { service, sessionDisabledTools } = createService();

    await expect(
      service.setToolState({ name: "run", enabled: false, scope: "run", reason: "The shell tool is malfunctioning." })
    ).resolves.toMatchObject({
      name: "run",
      requestedState: "disabled",
      effectiveState: "disabled",
      scope: "run"
    });
    expect(await service.disabledToolNames()).toEqual(["run", "saved_tool", "session_tool"]);

    await expect(
      service.setToolState({ name: "session_tool", enabled: true, scope: "session", reason: "Restore it for this chat." })
    ).resolves.toMatchObject({ effectiveState: "enabled" });
    expect(sessionDisabledTools.has("session_tool")).toBe(false);

    await expect(
      service.setToolState({ name: "saved_tool", enabled: true, scope: "run", reason: "Try to restore it." })
    ).resolves.toMatchObject({
      effectiveState: "disabled",
      note: "The tool remains disabled in saved Settings; only the user can re-enable a saved tool."
    });
  });

  it("protects the control boundary and rejects unknown tools", async () => {
    const { service } = createService();

    await expect(
      service.setToolState({ name: "arivu_runtime_status", enabled: false, scope: "run", reason: "Disable controls." })
    ).rejects.toThrow(/control boundary/);
    await expect(service.setToolState({ name: "ask_user", enabled: false, scope: "run", reason: "Disable questions." })).rejects.toThrow(
      /control boundary/
    );
    await expect(service.setToolState({ name: "made_up_tool", enabled: false, scope: "run", reason: "Unknown tool." })).rejects.toThrow(
      "Unknown tool: made_up_tool"
    );
  });

  it("switches browser models at the requested scope and retains later fallbacks", async () => {
    const { service, onSessionBrowserModelChange } = createService();

    await expect(
      service.selectBrowserModel({ candidateId: "fallback-1", scope: "run", reason: "Primary returned HTTP 503." })
    ).resolves.toMatchObject({
      candidateId: "fallback-1",
      scope: "run",
      model: { model: "fallback-model", active: true }
    });
    expect(service.currentBrowserTaskModel()).toMatchObject({
      model: "fallback-model",
      fallbacks: [{ model: "second-fallback" }]
    });
    expect(onSessionBrowserModelChange).not.toHaveBeenCalled();

    await service.selectBrowserModel({
      candidateId: "fallback-2",
      scope: "session",
      reason: "The first fallback is also rate limited."
    });
    expect(service.currentBrowserTaskModel()).toMatchObject({ model: "second-fallback" });
    expect(service.currentBrowserTaskModel().fallbacks).toBeUndefined();
    expect(onSessionBrowserModelChange).toHaveBeenCalledWith(expect.objectContaining({ model: "second-fallback" }));
  });

  it("forwards MCP additions as review-only proposals", async () => {
    const { service, onProposeMcpServer } = createService();
    const input = {
      name: "servicenow",
      description: "ServiceNow API tools",
      command: "npx",
      args: ["-y", "@example/servicenow-mcp"],
      envKeys: ["SERVICENOW_TOKEN"],
      reason: "The current task needs structured ServiceNow operations."
    };

    await expect(service.proposeMcpServer(input)).resolves.toEqual({
      id: "proposal-1",
      name: "servicenow",
      status: "pending_review",
      reviewLocation: "Settings > Integrations"
    });
    expect(onProposeMcpServer).toHaveBeenCalledWith(input);
  });
});
