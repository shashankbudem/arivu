import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";
import {
  ACCESSIBILITY_SENTINEL,
  analyzeComputerInput,
  buildClickScript,
  buildKeyScript,
  buildScrollScript,
  appleScriptString,
  buildTypeScript,
  chunkText,
  KEY_CODES,
  MAX_CLICK_COUNT,
  MAX_SCROLL_LINES,
  MAX_TYPE_TEXT_CHARS,
  resolveKeyCode
} from "../src/tools/computerInput.js";
import { createToolRegistry } from "../src/tools/registry.js";

const INPUT_TOOLS = ["computer_click", "computer_type", "computer_key", "computer_scroll"];

describe("generated script preamble", () => {
  it("preflights Accessibility in every action", () => {
    // Unlike Screen Recording, this permission is checkable before acting. Without the check
    // CGEventPost drops the event silently -- no error, no exit code, nothing to report.
    // computer_type is excluded deliberately: it runs through System Events, which reports the
    // same missing permission in its own words rather than needing a preflight.
    for (const script of [buildClickScript({ x: 1, y: 1 }), buildKeyScript({ key: "return" }), buildScrollScript({ deltaY: 3 })]) {
      expect(script).toContain("AXIsProcessTrusted");
      expect(script).toContain(ACCESSIBILITY_SENTINEL);
    }
  });

  it("uses numeric literals rather than the bridged kCG constants", () => {
    // JXA reports these ObjC enums with typeof "string"; passing one where a uint32 is expected
    // relies on bridge coercion. Verified against the real bridge: $.kCGHIDEventTap is a string.
    for (const script of [buildClickScript({ x: 1, y: 1 }), buildScrollScript({ deltaY: 1 })]) {
      expect(script).not.toContain("$.kCG");
    }
  });
});

describe("generated script syntax", () => {
  it("emits parseable JavaScript for every action and option combination", () => {
    // computer_type is AppleScript, not JavaScript, so it is checked by osacompile instead.
    // Parsing without running is the only end-to-end check available here: actually executing one
    // of these posts an event into whatever holds focus, which during a test run is this terminal.
    // A template bug -- an unbalanced brace, a bad interpolation -- would otherwise only surface
    // the first time a user invoked the tool.
    const scripts = [
      buildClickScript({ x: 0, y: 0 }),
      buildClickScript({ x: -10, y: 4000, button: "right", clickCount: MAX_CLICK_COUNT }),
      buildKeyScript({ key: "return" }),
      buildKeyScript({ key: "delete", modifiers: ["command", "shift", "option", "control"] }),
      buildScrollScript({ deltaY: -MAX_SCROLL_LINES }),
      buildScrollScript({ deltaY: 1, deltaX: -1, x: 0, y: 0 })
    ];
    for (const script of scripts) {
      expect(() => new vm.Script(script)).not.toThrow();
    }
  });
});

describe("buildClickScript", () => {
  it("moves the pointer, then presses and releases at the point", () => {
    const script = buildClickScript({ x: 100, y: 200 });
    expect(script).toContain("{ x: 100, y: 200 }");
    expect(script).toContain("CGEventCreateMouseEvent");
    expect(script).toContain("CGEventPost");
  });

  it("sets an incrementing click state so a double click registers as one", () => {
    // Without kCGMouseEventClickState the window server sees two single clicks and nothing opens.
    const script = buildClickScript({ x: 5, y: 5, clickCount: 2 });
    expect(script).toContain("CGEventSetIntegerValueField");
    expect(script).toContain("i <= 2");
  });

  it("uses the right-button event types when asked", () => {
    const right = buildClickScript({ x: 1, y: 1, button: "right" });
    // kCGEventRightMouseDown is 3 and kCGEventRightMouseUp is 4; left would be 1 and 2.
    expect(right).toContain("$(), 3, point");
    expect(right).toContain("$(), 4, point");
  });

  it("rejects non-integer coordinates and out-of-range click counts", () => {
    expect(() => buildClickScript({ x: 1.5, y: 1 })).toThrow(/must be integers/);
    expect(() => buildClickScript({ x: 1, y: 1, clickCount: 0 })).toThrow(/Invalid clickCount/);
    expect(() => buildClickScript({ x: 1, y: 1, clickCount: MAX_CLICK_COUNT + 1 })).toThrow(/Invalid clickCount/);
  });
});

describe("buildTypeScript", () => {
  it("uses System Events keystroke, not the CGEvent unicode path", () => {
    // CGEventKeyboardSetUnicodeString wants a UniChar buffer JXA cannot produce: measured, an
    // NSString, a char-code array, and a wrapped array all read back a length of 0.
    const script = buildTypeScript({ text: "hi" });
    expect(script).toContain('tell application "System Events"');
    expect(script).toContain("keystroke");
    expect(script).not.toContain("CGEventKeyboardSetUnicodeString");
  });

  it("escapes quotes and backslashes so text cannot close the AppleScript literal", () => {
    expect(appleScriptString('say "hi"')).toBe('"say \\"hi\\""');
    expect(appleScriptString("back\\slash")).toBe('"back\\\\slash"');
    // Backslash first, then quote: the other order would re-escape the backslash it just added.
    expect(appleScriptString('\\"')).toBe('"\\\\\\""');
  });

  it("keeps an injection attempt inside the literal", () => {
    const script = buildTypeScript({ text: '" \n end tell \n tell application "Finder" to delete' });
    // The payload's own text may contain "end tell" -- harmlessly, inside a string. What matters is
    // that it opens no second block and closes the real one exactly once, at the end.
    expect(script.match(/^tell application/gm)).toHaveLength(1);
    expect(script.match(/^end tell$/gm)).toHaveLength(1);
    expect(script.endsWith("end tell")).toBe(true);
  });

  it("chunks long text across keystroke calls without losing characters", () => {
    const script = buildTypeScript({ text: "a".repeat(40) });
    const typed = [...script.matchAll(/keystroke "([^"]*)"/g)].map((match) => match[1]).join("");
    expect(script.match(/keystroke/g)?.length).toBeGreaterThan(1);
    expect(typed).toBe("a".repeat(40));
  });

  it("rejects empty and oversized text", () => {
    expect(() => buildTypeScript({ text: "" })).toThrow(/text is required/);
    expect(() => buildTypeScript({ text: "a".repeat(MAX_TYPE_TEXT_CHARS + 1) })).toThrow(/the limit is/);
  });

  it("splits exactly, losing and duplicating nothing", () => {
    expect(chunkText("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
    expect(chunkText("abcde", 2)).toEqual(["ab", "cd", "e"]);
    expect(chunkText("a", 4)).toEqual(["a"]);
  });
});

describe("generated AppleScript compiles", () => {
  // osacompile parses and compiles without executing, so this validates the escaping against the
  // real compiler rather than against my model of it. macOS-only, hence the guard.
  const onMac = process.platform === "darwin";
  it.runIf(onMac)("survives quotes, backslashes, newlines, and unicode", async () => {
    const { execa } = await import("execa");
    const payloads = [
      "plain text",
      'say "hi"',
      "back\\slash",
      '\\"',
      "line1\nline2",
      "tab\there",
      '" \n end tell \n tell application "Finder" to delete',
      "unicode: caf\u00e9 \u00e9\u00e0\u00fc \u4f60\u597d",
      "a".repeat(MAX_TYPE_TEXT_CHARS)
    ];
    for (const payload of payloads) {
      const result = await execa("osacompile", ["-o", "/dev/null", "-e", buildTypeScript({ text: payload })], { reject: false });
      expect(`${payload.slice(0, 20)} -> ${result.exitCode} ${result.stderr}`).toBe(`${payload.slice(0, 20)} -> 0 `);
    }
  });
});

describe("buildKeyScript", () => {
  it("resolves named keys to macOS virtual key codes", () => {
    expect(resolveKeyCode("Return")).toBe(36);
    expect(resolveKeyCode(" escape ")).toBe(53);
    expect(buildKeyScript({ key: "tab" })).toContain("$(), 48, true");
  });

  it("ORs modifier flags together", () => {
    // kCGEventFlagMaskCommand (1<<20) | kCGEventFlagMaskShift (1<<17)
    expect(buildKeyScript({ key: "delete", modifiers: ["command", "shift"] })).toContain(String((1 << 20) | (1 << 17)));
  });

  it("omits the flags call entirely when there are no modifiers", () => {
    expect(buildKeyScript({ key: "space" })).not.toContain("CGEventSetFlags");
  });

  it("rejects unknown keys and modifiers rather than guessing a code", () => {
    expect(() => buildKeyScript({ key: "q" })).toThrow(/Unknown key/);
    expect(() => buildKeyScript({ key: "return", modifiers: ["hyper" as never] })).toThrow(/Unknown modifier/);
  });

  it("offers no letter keys, because their codes are layout-dependent", () => {
    // Code 12 is Q on a US layout and A on AZERTY; pressing the wrong key silently is worse than
    // not offering it. computer_type covers text entry instead.
    for (const letter of ["a", "q", "z"]) {
      expect(KEY_CODES[letter]).toBeUndefined();
    }
  });
});

describe("buildScrollScript", () => {
  it("scrolls under the current pointer when no position is given", () => {
    const script = buildScrollScript({ deltaY: -3 });
    expect(script).toContain("CGEventCreateScrollWheelEvent");
    expect(script).not.toContain("CGEventCreateMouseEvent");
  });

  it("moves the pointer first when a position is given", () => {
    const script = buildScrollScript({ deltaY: 3, x: 10, y: 20 });
    expect(script).toContain("{ x: 10, y: 20 }");
    expect(script.indexOf("CGEventCreateMouseEvent")).toBeLessThan(script.indexOf("CGEventCreateScrollWheelEvent"));
  });

  it("requires x and y together", () => {
    expect(() => buildScrollScript({ deltaY: 1, x: 10 })).toThrow(/both x and y/);
    expect(() => buildScrollScript({ deltaY: 1, y: 10 })).toThrow(/both x and y/);
  });

  it("rejects a no-op scroll and out-of-range deltas", () => {
    expect(() => buildScrollScript({ deltaY: 0 })).toThrow(/non-zero/);
    expect(() => buildScrollScript({ deltaY: MAX_SCROLL_LINES + 1 })).toThrow(/Invalid deltaY/);
    expect(() => buildScrollScript({ deltaY: 1, deltaX: 1.5 })).toThrow(/Invalid deltaX/);
  });
});

describe("analyzeComputerInput", () => {
  it("treats every input action as destructive", () => {
    // Injected input lands in whatever holds focus, which this code never knows.
    for (const action of ["click", "type", "key", "scroll"] as const) {
      expect(analyzeComputerInput(action, {}).destructive).toBe(true);
    }
  });

  it("escalates typed text that confirms a payment or deletes an account", () => {
    for (const text of ["Place order", "confirm transfer now", "delete my account"]) {
      const analysis = analyzeComputerInput("type", { text });
      expect(analysis.risk).toBe("high");
      expect(analysis.reasons.join("; ")).toMatch(/purchase|money|account/);
    }
  });

  it("escalates text shaped like a credential", () => {
    for (const [text, reason] of [
      ["sk-abcdefghijklmnop", /API token/],
      ["-----BEGIN RSA PRIVATE KEY-----", /private key/],
      ["4111 1111 1111 1111", /card number/]
    ] as const) {
      const analysis = analyzeComputerInput("type", { text });
      expect(analysis.risk).toBe("high");
      expect(analysis.reasons.join("; ")).toMatch(reason);
    }
  });

  it("leaves ordinary typed text at medium risk", () => {
    const analysis = analyzeComputerInput("type", { text: "hello world" });
    expect(analysis.risk).toBe("medium");
    expect(analysis.reasons).toEqual([]);
  });

  it("escalates destructive key combinations and only exact matches", () => {
    expect(analyzeComputerInput("key", { key: "delete", modifiers: ["command"] }).risk).toBe("high");
    expect(analyzeComputerInput("key", { key: "delete", modifiers: ["command", "shift"] }).risk).toBe("high");
    // A bare delete is ordinary editing, and an extra modifier is a different combination.
    expect(analyzeComputerInput("key", { key: "delete" }).risk).toBe("medium");
    expect(analyzeComputerInput("key", { key: "delete", modifiers: ["command", "option"] }).risk).toBe("medium");
  });

  it("says plainly that a click cannot be screened by content", () => {
    // Coordinates carry no information about what sits under them. Claiming a guard here would be
    // worse than admitting there is none.
    const analysis = analyzeComputerInput("click", {});
    expect(analysis.reasons.join("; ")).toMatch(/cannot be screened by content/);
  });
});

describe("the analysis reaches the person approving", () => {
  /** Captures the prompt label an approval would show, and always denies. */
  const capturingManager = () => {
    const labels: string[] = [];
    const manager = new ApprovalManager("ask", async (label) => {
      labels.push(label);
      return false;
    });
    return { manager, labels };
  };

  it("puts the flagged reason in front of the user, not only in the audit record", async () => {
    // The analyzer knowing a string looks like a token is worth nothing if the prompt does not
    // say so. This is the seam between analysis and consent.
    const { manager, labels } = capturingManager();
    const analysis = analyzeComputerInput("type", { text: "sk-abcdefghijklmnop" });
    await expect(
      manager.require({
        type: "screen",
        action: "type",
        target: "type 19 characters into the focused application",
        destructive: analysis.destructive,
        risk: analysis.risk,
        analysisSummary: analysis.summary,
        analysisReasons: analysis.reasons
      })
    ).rejects.toThrow(/denied/);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/API token/);
    expect(labels[0]).toMatch(/Risk: high/);
  });

  it("does not tell the user their screen is being captured when input is being injected", async () => {
    const { manager, labels } = capturingManager();
    await manager
      .require({ type: "screen", action: "click", target: "left click x1 at 10,20 (points)", destructive: true })
      .catch(() => undefined);
    expect(labels[0]).toMatch(/Computer input: click/);
    expect(labels[0]).toMatch(/injected into whatever currently holds focus/);
    expect(labels[0]).not.toMatch(/Screen capture/);
  });

  it("still describes a capture as a capture", async () => {
    const { manager, labels } = capturingManager();
    await manager
      .require({ type: "screen", action: "capture", target: "entire display 1", output: "/data/screen-1.png", destructive: true })
      .catch(() => undefined);
    expect(labels[0]).toMatch(/Screen capture: entire display 1/);
    expect(labels[0]).toMatch(/Saves to: \/data\/screen-1\.png/);
    expect(labels[0]).not.toMatch(/Computer input/);
  });
});

describe("input tool registration", () => {
  const registry = () => createToolRegistry({ workspaceRoot: process.cwd(), approvals: new ApprovalManager("trusted") });

  it("advertises all four input tools", () => {
    const names = registry().schemas.map((schema) => schema.name);
    for (const tool of INPUT_TOOLS) {
      expect(names).toContain(tool);
    }
  });

  it("files every input tool under computer_control, not run_command", async () => {
    const { capabilityForToolName } = await import("../src/agent/toolCapabilities.js");
    for (const tool of INPUT_TOOLS) {
      expect(capabilityForToolName(tool)).toBe("computer_control");
    }
  });

  it("tells the model coordinates are points, not screenshot pixels", () => {
    // The screenshot is 2x on a Retina display, so a pixel read off it clicks the wrong place.
    const click = registry().schemas.find((schema) => schema.name === "computer_click");
    expect(click?.description).toMatch(/screen points/);
    expect(click?.description).toMatch(/divided by that capture's reported scale/);
  });

  it("tells the model not to type credentials", () => {
    const type = registry().schemas.find((schema) => schema.name === "computer_type");
    expect(type?.description).toMatch(/Never use this for passwords/);
  });
});
