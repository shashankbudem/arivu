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
    expect(view.cwd).toBe("/tmp/workspace");
    expect(view.warnings).toContain("rm -rf");
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
