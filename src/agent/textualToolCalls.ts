import { randomUUID } from "node:crypto";
import { chatContentToText } from "./content.js";
import type { ChatMessage, ToolCall } from "./types.js";

/**
 * Recovers tool calls that a model emitted as plain text instead of native tool-call protocol.
 *
 * Some OpenAI-compatible providers (observed with NVIDIA NIM across nemotron, glm, minimax,
 * gemma, kimi, and qwen) intermittently fail to parse a model's tool-call syntax server-side,
 * so the call arrives in `content` as text and the run would otherwise end without executing
 * anything. Two textual shapes are recovered:
 *
 * 1. Arivu's own transcript format, which models imitate after seeing compacted or textified
 *    history:  `Local tool request(s):` followed by `- name: {json args}` bullets.
 * 2. Qwen/Hermes chat-template formats: `<tool_call>{"name": ..., "arguments": ...}</tool_call>`
 *    and `<function=name><parameter=key>value</parameter>...</function>`.
 *
 * Guardrails against false positives (quoted examples, documentation, injection echoes):
 * - Blocks inside markdown code fences are never recovered.
 * - The recovered block must END the message (only whitespace may follow): genuine emissions
 *   terminate the turn, while quoted examples are typically followed by prose.
 * - Only complete, well-formed calls naming a tool actually offered in the request qualify;
 *   truncated XML, unknown tools, and malformed JSON are left untouched so the agent-level
 *   mimicry guard can force a corrective retry instead of executing a guess.
 */
export function recoverTextualToolCalls(message: ChatMessage, availableToolNames: readonly string[]): ChatMessage {
  if (message.role !== "assistant" || message.toolCalls?.length || availableToolNames.length === 0) {
    return message;
  }
  const text = chatContentToText(message.content);
  if (!text.trim()) {
    return message;
  }

  const names = new Set(availableToolNames);
  const fences = fencedRanges(text);
  const recovered =
    parseLocalToolRequestBlock(text, names, fences) ??
    parseToolCallJsonBlock(text, names, fences) ??
    parseFunctionXmlBlock(text, names, fences);
  if (!recovered || recovered.calls.length === 0) {
    return message;
  }

  return {
    ...message,
    content: recovered.strippedText.trim(),
    toolCalls: recovered.calls
  };
}

/**
 * Removes markdown-fenced code regions. The agent's mimicry guard matches its pattern against
 * this stripped text so a final answer that merely QUOTES tool-call syntax inside a code fence
 * is not popped and retried.
 */
export function stripFencedCodeBlocks(text: string): string {
  let result = "";
  let cursor = 0;
  for (const [start, end] of fencedRanges(text)) {
    result += text.slice(cursor, start);
    cursor = end;
  }
  return result + text.slice(cursor);
}

type RecoveredCalls = {
  calls: ToolCall[];
  strippedText: string;
};

type Range = [number, number];

/** Sequentially pairs ``` fence markers; an unclosed trailing fence extends to end-of-text. */
function fencedRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const marker = /```/g;
  let open: number | undefined;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text))) {
    if (open === undefined) {
      open = match.index;
    } else {
      ranges.push([open, match.index + match[0].length]);
      open = undefined;
    }
  }
  if (open !== undefined) {
    ranges.push([open, text.length]);
  }
  return ranges;
}

function insideFence(index: number, fences: Range[]): boolean {
  return fences.some(([start, end]) => index >= start && index < end);
}

function recoveredCallId(): string {
  // "call_" prefix keeps the conventional OpenAI id shape for providers with strict chat
  // templates while staying identifiable as a recovered call in transcripts.
  return `call_rec_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** True when nothing but whitespace follows the recovered block — see the anchoring guardrail. */
function endsMessage(text: string, afterIndex: number): boolean {
  return text.slice(afterIndex).trim().length === 0;
}

/**
 * Parses `Local tool request(s):` bullets: `- name: {json}` where the JSON object may span
 * multiple lines (models imitate our own `JSON.stringify(args, null, 2)` serialization).
 */
function parseLocalToolRequestBlock(text: string, names: Set<string>, fences: Range[]): RecoveredCalls | undefined {
  const header = /(^|\n)[ \t]*Local tool requests?:[ \t]*\n/.exec(text);
  if (!header || insideFence(header.index, fences)) {
    return undefined;
  }
  const blockStart = header.index + (header[1] === "\n" ? 1 : 0);
  let cursor = header.index + header[0].length;
  const calls: ToolCall[] = [];

  for (;;) {
    const bullet = /^[ \t]*-[ \t]*([\w.-]+)[ \t]*:[ \t]*/.exec(text.slice(cursor));
    if (!bullet) {
      break;
    }
    const argsStart = cursor + bullet[0].length;
    const json = scanBalancedJsonObject(text, argsStart);
    if (!json) {
      break;
    }
    let args: unknown;
    try {
      args = JSON.parse(json.raw);
    } catch {
      break;
    }
    if (names.has(bullet[1])) {
      calls.push({ id: recoveredCallId(), name: bullet[1], arguments: args });
    }
    cursor = json.end;
    const lineBreak = /^[ \t]*\r?\n/.exec(text.slice(cursor));
    if (lineBreak) {
      cursor += lineBreak[0].length;
    }
  }

  if (calls.length === 0 || !endsMessage(text, cursor)) {
    return undefined;
  }
  return { calls, strippedText: text.slice(0, blockStart) };
}

/**
 * Parses `<tool_call>{"name": "x", "arguments": {...}}</tool_call>` blocks (Qwen3/Hermes JSON
 * template). The closing tag is required: a block the provider truncated mid-stream must not
 * execute with partial arguments.
 */
function parseToolCallJsonBlock(text: string, names: Set<string>, fences: Range[]): RecoveredCalls | undefined {
  const pattern = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  return collectTailBlocks(text, pattern, fences, (match) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]!);
    } catch {
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : undefined;
    if (!name || !names.has(name)) {
      return undefined;
    }
    return { id: recoveredCallId(), name, arguments: record.arguments ?? record.parameters ?? {} };
  });
}

/**
 * Parses the qwen-coder XML template:
 * `<function=name>\n<parameter=key>\nvalue\n</parameter>...</function>` (optionally wrapped in
 * `<tool_call>...</tool_call>`). `</function>` is required: the observed real-world failure was
 * a provider-truncated block cut off mid-parameter, which must trigger a retry, not execute.
 */
function parseFunctionXmlBlock(text: string, names: Set<string>, fences: Range[]): RecoveredCalls | undefined {
  const pattern = /(<tool_call>\s*)?<function=([\w.-]+)>([\s\S]*?)<\/function>(\s*<\/tool_call>)?/g;
  return collectTailBlocks(text, pattern, fences, (match) => {
    const name = match[2]!;
    const body = match[3]!;
    // A lazy body match would otherwise swallow an earlier UNCLOSED block and pair its name
    // with the next block's closing tag, executing mixed-up arguments under the wrong tool.
    if (!names.has(name) || body.includes("<function=")) {
      return undefined;
    }
    const args: Record<string, unknown> = {};
    const paramPattern = /<parameter=([\w.-]+)>\r?\n?([\s\S]*?)\r?\n?<\/parameter>/g;
    let param: RegExpExecArray | null;
    while ((param = paramPattern.exec(body))) {
      args[param[1]!] = coerceParameterValue(param[2]!);
    }
    return { id: recoveredCallId(), name, arguments: args };
  });
}

/**
 * Shared collector for tag-delimited formats: keeps only unfenced, well-formed blocks, requires
 * the final kept block to end the message, and strips kept blocks from the returned text.
 */
function collectTailBlocks(
  text: string,
  pattern: RegExp,
  fences: Range[],
  toCall: (match: RegExpExecArray) => ToolCall | undefined
): RecoveredCalls | undefined {
  const kept: Array<{ match: RegExpExecArray; call: ToolCall }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (insideFence(match.index, fences)) {
      continue;
    }
    const call = toCall(match);
    if (call) {
      kept.push({ match, call });
    }
  }
  if (kept.length === 0) {
    return undefined;
  }
  const last = kept[kept.length - 1]!;
  if (!endsMessage(text, last.match.index + last.match[0].length)) {
    return undefined;
  }
  let strippedText = text;
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const keptMatch = kept[index]!.match;
    strippedText = strippedText.slice(0, keptMatch.index) + strippedText.slice(keptMatch.index + keptMatch[0].length);
  }
  return { calls: kept.map((entry) => entry.call), strippedText };
}

/** Template parameter values are untyped text; recover numbers/booleans/JSON where unambiguous. */
function coerceParameterValue(raw: string): unknown {
  const value = raw.trim();
  if (/^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(value) || /^[[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Scans a balanced `{...}` JSON object starting at `start` (skipping leading whitespace),
 * respecting string literals and escapes. Returns the raw slice and the index after it.
 */
function scanBalancedJsonObject(text: string, start: number): { raw: string; end: number } | undefined {
  let index = start;
  while (index < text.length && /\s/.test(text[index]!)) {
    index += 1;
  }
  if (text[index] !== "{") {
    return undefined;
  }
  const objectStart = index;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { raw: text.slice(objectStart, index + 1), end: index + 1 };
      }
    }
  }
  return undefined;
}
