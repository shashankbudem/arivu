import { describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { capabilityForToolName } from "../src/agent/toolCapabilities.js";
import { scopeForApprovalAction } from "../src/permissions/approvalScope.js";
import { capabilityForApprovalAction, evaluateCapabilityPolicy } from "../src/permissions/capabilityPolicy.js";
import {
  buildComputerScreenshotPlan,
  captureScaleFactor,
  describeCaptureTarget,
  MAX_DISPLAY_ID,
  MIN_DISPLAY_ID,
  readPngDimensions,
  screenCaptureUnsupportedReason,
  screenshotFileName
} from "../src/tools/computerControl.js";

const OUT = "/tmp/capture.png";

/** Minimal valid PNG header: signature, IHDR length/type, then width and height as big-endian u32. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

describe("buildComputerScreenshotPlan", () => {
  it("captures the main display when neither display nor region is given", () => {
    // Bare `screencapture` merges every attached display into one image, which would capture more
    // than the approval prompt described.
    const plan = buildComputerScreenshotPlan({ output: OUT });
    expect(plan.bin).toBe("screencapture");
    expect(plan.argv).toEqual(["-t", "png", "-D", "1", OUT]);
    expect(plan.target).toBe("entire display 1");
  });

  it("builds a display capture", () => {
    const plan = buildComputerScreenshotPlan({ output: OUT, display: 2 });
    expect(plan.argv).toEqual(["-t", "png", "-D", "2", OUT]);
    expect(plan.target).toBe("entire display 2");
  });

  it("builds a region capture", () => {
    const plan = buildComputerScreenshotPlan({ output: OUT, region: { x: 10, y: 20, width: 800, height: 600 } });
    expect(plan.argv).toEqual(["-t", "png", "-R", "10,20,800,600", OUT]);
    expect(plan.target).toBe("screen region 800x600 at 10,20");
  });

  it("appends the cursor flag only when asked", () => {
    expect(buildComputerScreenshotPlan({ output: OUT, includeCursor: true }).argv).toContain("-C");
    expect(buildComputerScreenshotPlan({ output: OUT }).argv).not.toContain("-C");
  });

  it("never silences the shutter sound", () => {
    // The sound is the only signal a person at the machine gets that their screen was read.
    const plan = buildComputerScreenshotPlan({ output: OUT, display: 1, includeCursor: true });
    expect(plan.argv).not.toContain("-x");
  });

  it("rejects display and region together", () => {
    expect(() => buildComputerScreenshotPlan({ output: OUT, display: 1, region: { x: 0, y: 0, width: 10, height: 10 } })).toThrow(
      /not both/
    );
  });

  it("rejects out-of-range displays", () => {
    for (const display of [0, -1, MAX_DISPLAY_ID + 1, 1.5]) {
      expect(() => buildComputerScreenshotPlan({ output: OUT, display })).toThrow(/Invalid display/);
    }
    expect(() => buildComputerScreenshotPlan({ output: OUT, display: MIN_DISPLAY_ID })).not.toThrow();
  });

  it("rejects degenerate and non-integer regions", () => {
    // screencapture answers a zero-area rectangle with an empty file rather than an error.
    expect(() => buildComputerScreenshotPlan({ output: OUT, region: { x: 0, y: 0, width: 0, height: 10 } })).toThrow(/Invalid region size/);
    expect(() => buildComputerScreenshotPlan({ output: OUT, region: { x: 0, y: 0, width: 10, height: -5 } })).toThrow(
      /Invalid region size/
    );
    expect(() => buildComputerScreenshotPlan({ output: OUT, region: { x: 0.5, y: 0, width: 10, height: 10 } })).toThrow(/must be integers/);
  });

  it("requires an output path", () => {
    expect(() => buildComputerScreenshotPlan({ output: "  " })).toThrow(/output is required/);
  });
});

describe("capture target description", () => {
  it("names what the approval prompt is authorizing", () => {
    expect(describeCaptureTarget({})).toBe("entire display 1");
    expect(describeCaptureTarget({ display: 3 })).toBe("entire display 3");
    expect(describeCaptureTarget({ region: { x: 1, y: 2, width: 3, height: 4 } })).toBe("screen region 3x4 at 1,2");
  });
});

describe("platform support", () => {
  it("supports macOS and explains itself elsewhere", () => {
    expect(screenCaptureUnsupportedReason("darwin")).toBeUndefined();
    expect(screenCaptureUnsupportedReason("win32")).toMatch(/requires macOS/);
    expect(screenCaptureUnsupportedReason("linux")).toMatch(/requires macOS/);
  });
});

describe("readPngDimensions", () => {
  it("reads width and height from the IHDR chunk", () => {
    expect(readPngDimensions(pngHeader(2560, 1440))).toEqual({ width: 2560, height: 1440 });
  });

  it("rejects non-PNG, truncated, and zero-sized data", () => {
    expect(readPngDimensions(new Uint8Array(24))).toBeUndefined();
    expect(readPngDimensions(pngHeader(100, 100).slice(0, 20))).toBeUndefined();
    expect(readPngDimensions(pngHeader(0, 100))).toBeUndefined();
  });
});

describe("captureScaleFactor", () => {
  it("derives the Retina backing scale from requested points versus written pixels", () => {
    // Measured against a built-in 2560x1664 Retina panel: a 1x1 point region wrote a 2x2 PNG.
    expect(captureScaleFactor(1, 2)).toBe(2);
    expect(captureScaleFactor(800, 1600)).toBe(2);
    expect(captureScaleFactor(800, 800)).toBe(1);
  });

  it("declines to report a ratio that is clipping rather than scaling", () => {
    // A region running off the screen edge comes back far smaller than requested; calling that a
    // scale factor would send a later click to the wrong place.
    expect(captureScaleFactor(800, 10)).toBeUndefined();
    expect(captureScaleFactor(10, 800)).toBeUndefined();
    expect(captureScaleFactor(0, 100)).toBeUndefined();
    expect(captureScaleFactor(100, 0)).toBeUndefined();
  });
});

describe("screenshotFileName", () => {
  it("produces a filesystem-safe name from the capture time", () => {
    const name = screenshotFileName(new Date("2026-08-22T02:55:15.123Z"), "4242");
    expect(name).toBe("screen-2026-08-22T02-55-15-123Z-4242.png");
    expect(name).not.toMatch(/[:]/);
  });
});

describe("tool registration", () => {
  it("advertises computer_screenshot without needing a browser controller", () => {
    // The unit tests above all exercise the module in isolation; this is the one assertion that the
    // tool actually reaches a model. Unlike the browser tools it has no controller dependency, so a
    // plain registry must already carry it.
    const registry = createToolRegistry({ workspaceRoot: process.cwd(), approvals: new ApprovalManager("trusted") });
    expect(registry.schemas.map((schema) => schema.name)).toContain("computer_screenshot");
  });

  it("describes the capture as observation only, so the model does not expect to click", () => {
    const registry = createToolRegistry({ workspaceRoot: process.cwd(), approvals: new ApprovalManager("trusted") });
    const schema = registry.schemas.find((candidate) => candidate.name === "computer_screenshot");
    expect(schema?.description).toMatch(/cannot click or type/);
  });
});

describe("computer_control policy wiring", () => {
  it("maps computer_ tools and screen approvals to the capability", () => {
    expect(capabilityForToolName("computer_screenshot")).toBe("computer_control");
    expect(capabilityForApprovalAction({ type: "screen", action: "capture", target: "entire display 1" })).toBe("computer_control");
  });

  it("does not file screen capture under browser or command control", () => {
    // A workspace must be able to allow commands and the isolated browser while still blocking
    // reads of the whole machine's screen.
    expect(capabilityForToolName("computer_screenshot")).not.toBe("browser_control");
    expect(capabilityForToolName("computer_screenshot")).not.toBe("run_command");
  });

  it("requires approval in every trust mode, including trusted", () => {
    for (const mode of ["readonly", "ask", "trusted"] as const) {
      expect(evaluateCapabilityPolicy(mode, "computer_control").effect).toBe("prompt");
    }
  });

  it("honours a workspace override that denies screen capture", () => {
    const decision = evaluateCapabilityPolicy("trusted", "computer_control", { overrides: { computer_control: "deny" } });
    expect(decision.effect).toBe("deny");
  });

  it("records the capture target and destination as the approval scope", () => {
    const scope = scopeForApprovalAction({
      type: "screen",
      action: "capture",
      target: "screen region 800x600 at 10,20",
      output: "/data/screen-captures/screen-1.png"
    });
    expect(scope.kind).toBe("screen");
    expect(scope.value).toBe("screen region 800x600 at 10,20");
    expect(scope.detail).toMatch(/screen-1\.png/);
  });
});
