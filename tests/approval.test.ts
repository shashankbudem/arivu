import { describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";

describe("approval manager", () => {
  it("allows trusted non-destructive shell commands", async () => {
    const approvals = new ApprovalManager("trusted", async () => false);
    await expect(approvals.require({ type: "shell", command: "npm test" })).resolves.toBeUndefined();
  });

  it("prompts for destructive commands even in trusted mode", async () => {
    const approvals = new ApprovalManager("trusted", async () => false);
    await expect(approvals.require({ type: "shell", command: "rm -rf dist" })).rejects.toThrow(/denied/);
  });

  it("blocks writes in readonly mode", async () => {
    const approvals = new ApprovalManager("readonly", async () => true);
    await expect(approvals.require({ type: "write", summary: "edit file" })).rejects.toThrow(/readonly/);
  });

  it("never prompts for browser actions", async () => {
    let prompted = false;
    const approvals = new ApprovalManager("readonly", async () => {
      prompted = true;
      return false;
    });

    await expect(
      approvals.require({
        type: "browser",
        action: "open",
        target: "https://example.com",
        mode: "visible",
        destructive: true
      })
    ).resolves.toBeUndefined();
    expect(prompted).toBe(false);
  });
});
