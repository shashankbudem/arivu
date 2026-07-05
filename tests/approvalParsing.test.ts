import { describe, expect, it } from "vitest";
import { parseApprovalMessage } from "../desktop/renderer/src/approvalParsing.js";

describe("approval parsing", () => {
  it("preserves multiline shell commands before the working directory metadata", () => {
    const view = parseApprovalMessage("Destructive shell command: echo ok\nrm -R dist\nWorking directory: /tmp/workspace");

    expect(view.type).toBe("shell");
    if (view.type !== "shell") {
      return;
    }
    expect(view.command).toBe("echo ok\nrm -R dist");
    expect(view.mode).toBe("shell");
    expect(view.cwd).toBe("/tmp/workspace");
    expect(view.warnings).toContain("rm -rf");
  });

  it("parses structured command approvals and stops before analysis metadata", () => {
    const view = parseApprovalMessage(
      "Structured command: node -e \"process.stdout.write('ok')\"\nCommand mode: argv\nCommand analysis: low risk - commands: node\nWorking directory: /workspace"
    );

    expect(view.type).toBe("shell");
    if (view.type !== "shell") {
      return;
    }
    expect(view.destructive).toBe(false);
    expect(view.mode).toBe("argv");
    expect(view.command).toBe("node -e \"process.stdout.write('ok')\"");
    expect(view.cwd).toBe("/workspace");
    expect(view.executable).toBe("node");
  });

  it("does not include command analysis in shell command text when cwd is absent", () => {
    const view = parseApprovalMessage("Shell command: npm test\nCommand analysis: low risk - commands: npm");

    expect(view.type).toBe("shell");
    if (view.type !== "shell") {
      return;
    }
    expect(view.command).toBe("npm test");
  });

  it("parses network approvals with the outgoing query", () => {
    const view = parseApprovalMessage("Network request: web_search\nDestination: Bing RSS\nQuery: latest private thing");

    expect(view).toMatchObject({
      type: "network",
      destructive: true,
      summary: "web_search",
      destination: "Bing RSS",
      query: "latest private thing"
    });
  });
});
