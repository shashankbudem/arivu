import { describe, expect, it, vi } from "vitest";

const saved = {
  baseUrl: "https://api.example.test/v1",
  model: "test",
  toolCalling: "auto",
  imageInput: "auto",
  chatModelRequestDelayMs: 0,
  providers: [],
  webSearchProviders: [],
  disabledTools: [],
  trustMode: "ask",
  mcpServers: {},
  toolProposals: [],
  workspacePolicies: {},
  workspacePolicyProfiles: {}
};

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(async () => structuredClone(saved)),
  saveConfig: vi.fn(async (next) => Object.assign(saved, structuredClone(next)))
}));

import {
  normalizeMcpServerProposalInput,
  proposeMcpServer,
  reviewMcpProposal,
  safeMcpProposalDisplay
} from "../src/harness/mcpProposals.js";

describe("MCP proposal governance", () => {
  it("rejects secret values and keeps only environment key metadata", () => {
    expect(() =>
      normalizeMcpServerProposalInput({
        name: "GitHub",
        description: "",
        command: "npx",
        args: ["-y", "mcp"],
        envKeys: ["GITHUB_TOKEN"],
        reason: "Need GitHub tools"
      })
    ).not.toThrow();
    expect(() =>
      normalizeMcpServerProposalInput({
        name: "GitHub",
        description: "",
        command: "npx",
        args: ["--token=sk_abcdefghijklmnop"],
        envKeys: [],
        reason: "Need GitHub tools"
      })
    ).toThrow(/secret values/);
    expect(() =>
      normalizeMcpServerProposalInput({
        name: "x",
        description: "",
        command: "npx",
        args: ["Authorization: Basic x"],
        envKeys: [],
        reason: "Need it"
      })
    ).toThrow(/secret values/);
    expect(() =>
      normalizeMcpServerProposalInput({
        name: "GitHub",
        description: "",
        command: "npx",
        args: [],
        envKeys: ["TOKEN=not-a-key"],
        reason: "Need GitHub tools"
      })
    ).toThrow(/environment keys/);
    expect(() =>
      normalizeMcpServerProposalInput({
        name: "x",
        description: "",
        command: "https://alice:hunter2@example.com",
        args: [],
        envKeys: [],
        reason: "Need it"
      })
    ).toThrow(/secret values/);
    expect(() =>
      normalizeMcpServerProposalInput({
        name: "x",
        description: "",
        command: "npx",
        args: ["Authorization: Bearer supersecretvalue"],
        envKeys: [],
        reason: "Need it"
      })
    ).toThrow(/secret values/);
  });

  it("persists a proposal disabled by default, then activates or removes only by explicit review", async () => {
    Object.assign(saved, { mcpServers: {}, toolProposals: [] });
    const proposal = await proposeMcpServer({
      name: "GitHub",
      description: "GitHub operations",
      command: "npx",
      args: ["-y", "github-mcp"],
      envKeys: ["GITHUB_TOKEN"],
      reason: "Need GitHub tools"
    });
    expect(saved.toolProposals).toHaveLength(1);
    await expect(reviewMcpProposal(proposal.id, "install")).resolves.toMatchObject({ enabled: false, serverName: "GitHub" });
    expect((saved.mcpServers as Record<string, unknown>).GitHub).toMatchObject({ disabled: true, env: { GITHUB_TOKEN: "" } });
    await reviewMcpProposal("GitHub", "enable");
    expect((saved.mcpServers as Record<string, { disabled?: boolean }>).GitHub?.disabled).toBe(false);
    await reviewMcpProposal("GitHub", "remove");
    expect((saved.mcpServers as Record<string, unknown>).GitHub).toBeUndefined();
  });

  it("redacts legacy proposal values before terminal display", () => {
    const display = safeMcpProposalDisplay({
      id: "p",
      kind: "mcp_server",
      name: "x",
      description: "token=shh",
      command: "npx",
      args: ["--key=sk_abcdefghijklmnop"],
      envKeys: ["TOKEN"],
      reason: "password=hush",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    expect(JSON.stringify(display)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(display)).not.toContain("hush");
  });

  it("redacts legacy bearer and URL-userinfo values as whole display fields", () => {
    const display = safeMcpProposalDisplay({
      id: "legacy-secret",
      kind: "mcp_server",
      name: "x",
      description: "https://alice:hunter2@example.com",
      command: "Authorization: Bearer supersecretvalue",
      args: ["https://alice:hunter2@example.com", "Authorization: Bearer supersecretvalue"],
      envKeys: ["Authorization: Bearer supersecretvalue"],
      reason: "https://alice:hunter2@example.com",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    expect(display).toMatchObject({ command: "[redacted]", description: "[redacted]", reason: "[redacted]" });
    expect(display.args).toEqual(["[redacted]", "[redacted]"]);
    expect(display.envKeys).toEqual(["[redacted]"]);
    expect(JSON.stringify(display)).not.toContain("hunter2");
    expect(JSON.stringify(display)).not.toContain("supersecretvalue");
  });

  it("redacts short authorization tokens and encoded sensitive query metadata", () => {
    const display = safeMcpProposalDisplay({
      id: "legacy-encoded",
      kind: "mcp_server",
      name: "x",
      description: "safe",
      command: "Authorization: Bearer x",
      args: ["https://example.test/?access_token=x", "https%3A%2F%2Fexample.test%2F%3Fclient_secret%3Dx"],
      envKeys: [],
      reason: "safe",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    expect(display.command).toBe("[redacted]");
    expect(display.args).toEqual(["[redacted]", "[redacted]"]);
  });
});
