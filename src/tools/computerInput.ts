/**
 * Pure JXA script builders and risk analysis for the `computer_click` / `computer_type` /
 * `computer_key` / `computer_scroll` tools. As with `applescript.ts` and `computerControl.ts`,
 * nothing here does I/O: the registry spawns `osascript` and owns approvals, so every script and
 * every risk verdict is unit-testable without posting a single event.
 *
 * Input is injected through CoreGraphics `CGEventPost` reached from JXA's ObjC bridge, rather than
 * through System Events UI scripting. System Events has no scroll verb at all and its `click at`
 * is unreliable, while CGEvent covers mouse, keyboard, and scroll with one mechanism and no native
 * module to rebuild per Electron ABI.
 *
 * Coordinates are screen points — the same space `CGDisplayBounds` and `screencapture -R` use, so a
 * pixel read off a `computer_screenshot` image converts by dividing by that capture's reported
 * scale. See `captureGeometry` in `computerControl.ts` for why that scale cannot be assumed to be 1.
 */

/**
 * Fixed rather than caller-tunable. Posting a handful of CGEvents returns immediately; anything that
 * hangs this long is osascript itself wedged, which no caller has better information about than the
 * tool does.
 */
export const COMPUTER_INPUT_DEFAULT_TIMEOUT_MS = 20_000;

/** One keystroke event carries a bounded unicode payload; long text is split across events. */
export const MAX_TYPE_CHUNK_CHARS = 16;
export const MAX_TYPE_TEXT_CHARS = 4_000;
export const MAX_SCROLL_LINES = 100;
export const MAX_CLICK_COUNT = 3;

export type MouseButton = "left" | "right";
export type ComputerInputAction = "click" | "type" | "key" | "scroll";

export type ComputerClickParams = { x: number; y: number; button?: MouseButton; clickCount?: number };
export type ComputerTypeParams = { text: string };
export type ComputerKeyParams = { key: string; modifiers?: Modifier[] };
export type ComputerScrollParams = { deltaY: number; deltaX?: number; x?: number; y?: number };

export type Modifier = "command" | "shift" | "option" | "control";

/**
 * JXA reports these ObjC enum constants with `typeof === "string"` even though they stringify to
 * their numeric value, so passing `$.kCGHIDEventTap` straight into a function expecting a uint32
 * relies on bridge coercion that is not worth betting an input event on. The literals are inlined
 * instead, with the constant each one stands for named beside it.
 */
const CG = {
  hidEventTap: 0, // kCGHIDEventTap
  leftMouseDown: 1, // kCGEventLeftMouseDown
  leftMouseUp: 2, // kCGEventLeftMouseUp
  rightMouseDown: 3, // kCGEventRightMouseDown
  rightMouseUp: 4, // kCGEventRightMouseUp
  mouseMoved: 5, // kCGEventMouseMoved
  mouseButtonLeft: 0, // kCGMouseButtonLeft
  mouseButtonRight: 1, // kCGMouseButtonRight
  scrollUnitLine: 1, // kCGScrollEventUnitLine
  clickStateField: 1 // kCGMouseEventClickState
} as const;

/** CGEventFlags. Only the four a caller can name; the rest are not worth exposing. */
const MODIFIER_FLAGS: Record<Modifier, number> = {
  shift: 1 << 17, // kCGEventFlagMaskShift
  control: 1 << 18, // kCGEventFlagMaskControl
  option: 1 << 19, // kCGEventFlagMaskAlternate
  command: 1 << 20 // kCGEventFlagMaskCommand
};

export const MODIFIERS: readonly Modifier[] = ["command", "shift", "option", "control"];

/**
 * macOS virtual key codes. Deliberately a small named set rather than raw numbers, and deliberately
 * no letters: these codes are positional, so code 12 is Q on a US layout and A on AZERTY. The keys
 * below sit at the same position on every layout. Letter shortcuts such as Cmd+A are therefore not
 * offered rather than offered wrong; `computer_type` covers text entry.
 */
export const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  escape: 53,
  home: 115,
  pageup: 116,
  forwarddelete: 117,
  end: 119,
  pagedown: 121,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97
};

export const ACCESSIBILITY_PERMISSION_HINT =
  "Input injection needs macOS Accessibility permission for the app running Arivu. Grant it in " +
  "System Settings > Privacy & Security > Accessibility. This is a different permission from the " +
  "Screen Recording one that computer_screenshot needs, and granting one does not grant the other.";

/** Sentinel the generated script throws so the registry can turn it into the hint above. */
export const ACCESSIBILITY_SENTINEL = "ARIVU_ACCESSIBILITY_NOT_TRUSTED";

export type ComputerInputRisk = "low" | "medium" | "high";

export type ComputerInputAnalysis = {
  risk: ComputerInputRisk;
  /** Always true. Injected input acts on whatever holds focus, which is never known from here. */
  destructive: true;
  summary: string;
  reasons: string[];
};

/**
 * Phrases that mark a confirmation the user would want to make themselves. Mirrors
 * SENSITIVE_ACTION_PATTERN in `desktop/main/browserTaskSupervisor.ts`, which guards the browser
 * agent against the same class of action; keeping the vocabulary aligned means a phrase blocked in
 * one surface is not quietly allowed in the other.
 */
const SENSITIVE_TEXT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(confirm(ed)?\s+(payment|purchase|order)|place\s+order|complete\s+purchase|pay\s+now)\b/i,
    reason: "confirms a purchase or payment"
  },
  {
    pattern: /\b(submit\s+payment|authorize\s+payment|confirm\s+transfer|send\s+money|wire\s+transfer)\b/i,
    reason: "authorizes a money movement"
  },
  {
    pattern: /\b(delete\s+(my\s+)?account|permanently\s+delete|deactivate\s+account|cancel\s+subscription)\b/i,
    reason: "deletes or deactivates an account"
  }
];

/**
 * Shapes that look like a secret. Heuristic and easily evaded, so it escalates the approval prompt
 * rather than blocking: the point is that the user sees "this looks like a credential" before they
 * approve, not that the tool believes it caught everything.
 */
const CREDENTIAL_TEXT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}/i, reason: "contains something shaped like an API token" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: "contains a private key block" },
  { pattern: /\b(?:\d[ -]?){13,19}\b/, reason: "contains something shaped like a card number" }
];

/**
 * Key combinations that destroy data. Only combinations `KEY_CODES` can actually produce are worth
 * listing: a guard entry for a key the builder rejects is dead code that reads like coverage.
 * Letter-key shortcuts such as Cmd+Q are therefore absent from both, since letter virtual key codes
 * are layout-dependent -- code 12 is Q on a US layout and A on AZERTY -- and silently pressing the
 * wrong key is worse than not offering the key at all.
 */
const DESTRUCTIVE_KEY_COMBOS: Array<{ key: string; modifiers: Modifier[]; reason: string }> = [
  { key: "delete", modifiers: ["command"], reason: "moves the selection to the Trash" },
  { key: "delete", modifiers: ["command", "shift"], reason: "empties the Trash" },
  { key: "forwarddelete", modifiers: ["command"], reason: "deletes forward to the end of the line" }
];

export function analyzeComputerInput(
  action: ComputerInputAction,
  params: { text?: string; key?: string; modifiers?: Modifier[] }
): ComputerInputAnalysis {
  const reasons: string[] = [];
  let risk: ComputerInputRisk = "medium";

  if (action === "type" && params.text) {
    for (const { pattern, reason } of [...SENSITIVE_TEXT_PATTERNS, ...CREDENTIAL_TEXT_PATTERNS]) {
      if (pattern.test(params.text)) {
        reasons.push(reason);
        risk = "high";
      }
    }
  }

  if (action === "key" && params.key) {
    const modifiers = new Set(params.modifiers ?? []);
    for (const combo of DESTRUCTIVE_KEY_COMBOS) {
      const matches =
        combo.key.toLowerCase() === params.key.toLowerCase() &&
        combo.modifiers.length === modifiers.size &&
        combo.modifiers.every((modifier) => modifiers.has(modifier));
      if (matches) {
        reasons.push(combo.reason);
        risk = "high";
      }
    }
  }

  if (action === "click") {
    // A click carries coordinates and nothing else. What sits under the pointer is not knowable
    // from here, so there is no content guard to apply -- unlike typed text or a named key combo.
    // Saying so is the honest position; pretending a coordinate can be screened is not.
    reasons.push("clicks cannot be screened by content; what is under the pointer is unknown");
  }

  return {
    risk,
    destructive: true,
    summary: summarizeInput(action, params, reasons),
    reasons
  };
}

function summarizeInput(
  action: ComputerInputAction,
  params: { text?: string; key?: string; modifiers?: Modifier[] },
  reasons: string[]
): string {
  const base =
    action === "type"
      ? `Types ${params.text?.length ?? 0} characters into whatever holds focus`
      : action === "key"
        ? `Presses ${[...(params.modifiers ?? []), params.key].join("+")} in whatever holds focus`
        : action === "click"
          ? "Clicks at a screen position outside the workspace"
          : "Scrolls whatever is under the pointer";
  return reasons.length > 0 ? `${base}; ${reasons.join("; ")}.` : `${base}.`;
}

export function buildClickScript(params: ComputerClickParams): string {
  const x = assertFiniteInteger("x", params.x);
  const y = assertFiniteInteger("y", params.y);
  const clickCount = params.clickCount ?? 1;
  if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > MAX_CLICK_COUNT) {
    throw new Error(`Invalid clickCount ${clickCount}; expected an integer from 1 to ${MAX_CLICK_COUNT}.`);
  }
  const right = params.button === "right";
  const button = right ? CG.mouseButtonRight : CG.mouseButtonLeft;
  const down = right ? CG.rightMouseDown : CG.leftMouseDown;
  const up = right ? CG.rightMouseUp : CG.leftMouseUp;

  return wrapScript(`
var point = { x: ${x}, y: ${y} };
$.CGEventPost(${CG.hidEventTap}, $.CGEventCreateMouseEvent($(), ${CG.mouseMoved}, point, ${button}));
for (var i = 1; i <= ${clickCount}; i++) {
  var down = $.CGEventCreateMouseEvent($(), ${down}, point, ${button});
  // Without an incrementing click state the window server sees N separate single clicks rather
  // than a double click, so a clickCount of 2 would never open anything.
  $.CGEventSetIntegerValueField(down, ${CG.clickStateField}, i);
  $.CGEventPost(${CG.hidEventTap}, down);
  var up = $.CGEventCreateMouseEvent($(), ${up}, point, ${button});
  $.CGEventSetIntegerValueField(up, ${CG.clickStateField}, i);
  $.CGEventPost(${CG.hidEventTap}, up);
}`);
}

export function buildTypeScript(params: ComputerTypeParams): string {
  const text = params.text;
  if (text.length === 0) {
    throw new Error("text is required for a type action.");
  }
  if (text.length > MAX_TYPE_TEXT_CHARS) {
    throw new Error(`text is ${text.length} characters; the limit is ${MAX_TYPE_TEXT_CHARS}.`);
  }
  // Chunked because one keyboard event's unicode payload is bounded; the chunks are embedded as a
  // JSON array so no amount of quoting in the text can break out of the generated script.
  const chunks = chunkText(text, MAX_TYPE_CHUNK_CHARS);
  return wrapScript(`
var chunks = ${JSON.stringify(chunks)};
for (var i = 0; i < chunks.length; i++) {
  var chunk = chunks[i];
  var down = $.CGEventCreateKeyboardEvent($(), 0, true);
  $.CGEventKeyboardSetUnicodeString(down, chunk.length, $(chunk));
  $.CGEventPost(${CG.hidEventTap}, down);
  var up = $.CGEventCreateKeyboardEvent($(), 0, false);
  $.CGEventKeyboardSetUnicodeString(up, chunk.length, $(chunk));
  $.CGEventPost(${CG.hidEventTap}, up);
}`);
}

export function buildKeyScript(params: ComputerKeyParams): string {
  const code = resolveKeyCode(params.key);
  const modifiers = params.modifiers ?? [];
  for (const modifier of modifiers) {
    if (!MODIFIERS.includes(modifier)) {
      throw new Error(`Unknown modifier "${modifier}"; expected one of: ${MODIFIERS.join(", ")}.`);
    }
  }
  const flags = modifiers.reduce((total, modifier) => total | MODIFIER_FLAGS[modifier], 0);
  return wrapScript(`
var down = $.CGEventCreateKeyboardEvent($(), ${code}, true);
var up = $.CGEventCreateKeyboardEvent($(), ${code}, false);
${flags === 0 ? "" : `$.CGEventSetFlags(down, ${flags});\n$.CGEventSetFlags(up, ${flags});`}
$.CGEventPost(${CG.hidEventTap}, down);
$.CGEventPost(${CG.hidEventTap}, up);`);
}

export function buildScrollScript(params: ComputerScrollParams): string {
  const deltaY = assertScrollDelta("deltaY", params.deltaY);
  const deltaX = assertScrollDelta("deltaX", params.deltaX ?? 0);
  if (deltaY === 0 && deltaX === 0) {
    throw new Error("A scroll needs a non-zero deltaY or deltaX.");
  }
  const hasPoint = params.x !== undefined || params.y !== undefined;
  if (hasPoint && (params.x === undefined || params.y === undefined)) {
    throw new Error("Pass both x and y to scroll at a position, or neither to scroll under the current pointer.");
  }
  const move = hasPoint
    ? `$.CGEventPost(${CG.hidEventTap}, $.CGEventCreateMouseEvent($(), ${CG.mouseMoved}, { x: ${assertFiniteInteger(
        "x",
        params.x as number
      )}, y: ${assertFiniteInteger("y", params.y as number)} }, ${CG.mouseButtonLeft}));\n`
    : "";
  // Line units rather than pixel units: a "line" is what a physical wheel notch produces, so the
  // scroll lands the same distance regardless of the app's pixel-scrolling behaviour.
  return wrapScript(`
${move}$.CGEventPost(${CG.hidEventTap}, $.CGEventCreateScrollWheelEvent($(), ${CG.scrollUnitLine}, 2, ${deltaY}, ${deltaX}));`);
}

/**
 * Every generated script gets the same preamble. Unlike Screen Recording, Accessibility *can* be
 * checked before acting: `AXIsProcessTrusted` answers honestly, and without it `CGEventPost`
 * silently drops the event with no error and no exit code. Preflighting turns that silence into a
 * message that names the permission and the pane it lives in.
 */
function wrapScript(body: string): string {
  return `ObjC.import("CoreGraphics");
ObjC.import("ApplicationServices");
if (!$.AXIsProcessTrusted()) {
  throw new Error("${ACCESSIBILITY_SENTINEL}");
}
${body.trim()}
"ok";`;
}

export function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

export function resolveKeyCode(key: string): number {
  const normalized = key.trim().toLowerCase();
  const named = KEY_CODES[normalized];
  if (named !== undefined) {
    return named;
  }
  throw new Error(`Unknown key "${key}"; expected one of: ${Object.keys(KEY_CODES).join(", ")}.`);
}

function assertFiniteInteger(name: string, value: number): number {
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid ${name} ${value}; screen coordinates must be integers.`);
  }
  return value;
}

function assertScrollDelta(name: string, value: number): number {
  if (!Number.isInteger(value) || Math.abs(value) > MAX_SCROLL_LINES) {
    throw new Error(`Invalid ${name} ${value}; expected an integer between -${MAX_SCROLL_LINES} and ${MAX_SCROLL_LINES}.`);
  }
  return value;
}
