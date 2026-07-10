import { describe, expect, it } from "vitest";
import { approvalViewFromRequest, parseApprovalMessage } from "../desktop/renderer/src/approvalParsing.js";

describe("structured approval requests", () => {
  it("builds a write view with a diff from a structured change preview", () => {
    const view = approvalViewFromRequest({
      actionType: "write",
      capability: "write_workspace",
      summary: "replace app.ts",
      label: "Write: replace app.ts",
      reason: "",
      risky: false,
      changePreview: {
        kind: "file_change",
        title: "app.ts",
        summary: "replace app.ts",
        path: "app.ts",
        writeMode: "replace",
        original: "const a = 1;\n",
        content: "const a = 2;\n"
      }
    });

    expect(view?.type).toBe("write");
    if (view?.type !== "write") {
      return;
    }
    expect(view.summary).toBe("replace app.ts");
    expect(view.diff?.rows.some((row) => row.kind === "change" || row.kind === "add")).toBe(true);
  });

  it("builds a shell view from a structured command scope and flags risky commands", () => {
    const view = approvalViewFromRequest({
      actionType: "shell",
      capability: "run_command",
      summary: "rm -rf dist",
      label: "Destructive shell command: rm -rf dist",
      reason: "",
      risky: true,
      scope: { kind: "command", label: "Command", value: "rm -rf dist" }
    });

    expect(view?.type).toBe("shell");
    if (view?.type !== "shell") {
      return;
    }
    expect(view.executable).toBe("rm");
    expect(view.destructive).toBe(true);
    expect(view.warnings).toContain("rm -rf");
  });

  it("returns undefined for read approvals so the caller falls back to text", () => {
    const view = approvalViewFromRequest({
      actionType: "read",
      capability: "read_repo",
      summary: "read file",
      label: "Repo read: read file",
      reason: "",
      risky: false
    });
    expect(view).toBeUndefined();
  });
});

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
