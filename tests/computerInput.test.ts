import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";
import {
  ACCESSIBILITY_SENTINEL,
  analyzeComputerInput,
  buildClickScript,
  buildKeyScript,
  buildScrollScript,
  buildTypeScript,
  chunkText,
  KEY_CODES,
  MAX_TYPE_CHUNK_CHARS,
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
    for (const script of [
      buildClickScript({ x: 1, y: 1 }),
      buildTypeScript({ text: "hi" }),
      buildKeyScript({ key: "return" }),
      buildScrollScript({ deltaY: 3 })
    ]) {
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
    // Parsing without running is the only end-to-end check available here: actually executing one
    // of these posts an event into whatever holds focus, which during a test run is this terminal.
    // A template bug -- an unbalanced brace, a bad interpolation -- would otherwise only surface
    // the first time a user invoked the tool.
    const scripts = [
      buildClickScript({ x: 0, y: 0 }),
      buildClickScript({ x: -10, y: 4000, button: "right", clickCount: MAX_CLICK_COUNT }),
      buildTypeScript({ text: "plain" }),
      buildTypeScript({ text: '"quotes" \\ backslash\nnewline\ttab' }),
      buildTypeScript({ text: "a".repeat(MAX_TYPE_TEXT_CHARS) }),
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
  it("embeds text as a JSON array so quoting cannot break out of the script", () => {
    const payload = '"; $.CGEventPost(0, evil); //';
    const script = buildTypeScript({ text: payload });
    // Encoded, not interpolated: the escaped form is present and the raw form never is.
    expect(script).toContain(JSON.stringify(chunkText(payload, MAX_TYPE_CHUNK_CHARS)));
    expect(script).not.toContain(payload);
    // Nothing of the payload reaches the script above the array literal.
    expect(script.split("var chunks =")[0]).not.toContain("evil");
  });

  it("chunks long text across events", () => {
    const script = buildTypeScript({ text: "a".repeat(40) });
    const chunks = JSON.parse(script.slice(script.indexOf("["), script.indexOf("]") + 1)) as string[];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe("a".repeat(40));
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
