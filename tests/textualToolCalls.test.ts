import { describe, expect, it } from "vitest";
import { recoverTextualToolCalls } from "../src/agent/textualToolCalls.js";
import type { ChatMessage } from "../src/agent/types.js";

const TOOLS = ["browser_task", "browser_state", "browser_click_at", "browser_snapshot", "search", "read", "current_datetime"];

function assistant(content: string): ChatMessage {
  return { role: "assistant", content };
}

describe("recoverTextualToolCalls", () => {
  it("recovers the transcript-format tool call observed in session 89de8811 (glm-5.2)", () => {
    const content = [
      "I can see the ServiceNow instance is open. Let me take the task to create the catalog item via autonomous browser interaction.",
      "",
      "Local tool request:",
      '- browser_task: {\n  "instruction": "Create the catalog item named IP Whitelisting",\n  "mode": "visible",\n  "tabId": "tab-1",\n  "maxSteps": 120,\n  "timeoutMs": 300000\n}'
    ].join("\n");

    const result = recoverTextualToolCalls(assistant(content), TOOLS);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({
      name: "browser_task",
      arguments: { instruction: "Create the catalog item named IP Whitelisting", mode: "visible", tabId: "tab-1", maxSteps: 120 }
    });
    expect(result.toolCalls?.[0]?.id).toMatch(/^call_rec_/);
    expect(String(result.content)).toContain("ServiceNow instance is open");
    expect(String(result.content)).not.toContain("Local tool request");
  });

  it("recovers multiple bullets from the plural transcript format observed with kimi-k2.6", () => {
    const content = [
      "Local tool requests:",
      '- search: {\n  "query": "normalizeBrowserUrl|browser_open.*test"\n}',
      '- read: {\n  "path": "src/tools/browserControl.ts",\n  "offset": 1\n}'
    ].join("\n");

    const result = recoverTextualToolCalls(assistant(content), TOOLS);

    expect(result.toolCalls?.map((call) => call.name)).toEqual(["search", "read"]);
    expect(result.toolCalls?.[1]?.arguments).toMatchObject({ path: "src/tools/browserControl.ts", offset: 1 });
    expect(String(result.content).trim()).toBe("");
  });

  it("does NOT recover the truncated qwen XML block observed in session f7515a1c", () => {
    // Real payload: the provider cut the stream mid-parameter, so no closing tags exist.
    // Executing truncated arguments would be wrong; the agent-level guard retries instead.
    const content = [
      "Now I'll use browser_task to create the catalog item.",
      "",
      "<tool_call>",
      "<function=browser_task>",
      "<parameter=instruction>",
      "Create a new Catalog Item with the following details:",
      '1. Click the "New" button',
      "   - Active: true"
    ].join("\n");

    const result = recoverTextualToolCalls(assistant(content), TOOLS);

    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe(content);
  });

  it("recovers a complete qwen function-XML block with parameter type coercion", () => {
    const content = [
      "Delegating now.",
      "<tool_call>",
      "<function=browser_task>",
      "<parameter=instruction>",
      "Fill the form and submit it.",
      "</parameter>",
      "<parameter=maxSteps>",
      "40",
      "</parameter>",
      "<parameter=mode>",
      "visible",
      "</parameter>",
      "</function>",
      "</tool_call>"
    ].join("\n");

    const result = recoverTextualToolCalls(assistant(content), TOOLS);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({
      name: "browser_task",
      arguments: { instruction: "Fill the form and submit it.", maxSteps: 40, mode: "visible" }
    });
    expect(String(result.content)).toBe("Delegating now.");
  });

  it("recovers the Hermes/Qwen JSON tool_call template", () => {
    const content = 'Checking state first.\n<tool_call>\n{"name": "browser_state", "arguments": {}}\n</tool_call>';

    const result = recoverTextualToolCalls(assistant(content), TOOLS);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({ name: "browser_state", arguments: {} });
    expect(String(result.content)).toBe("Checking state first.");
  });

  it("ignores unknown tool names, malformed JSON, and messages that already have native calls", () => {
    const unknownTool = recoverTextualToolCalls(assistant('Local tool request:\n- not_a_tool: {"x": 1}'), TOOLS);
    expect(unknownTool.toolCalls).toBeUndefined();

    const badJson = recoverTextualToolCalls(assistant('Local tool request:\n- browser_task: {"instruction": '), TOOLS);
    expect(badJson.toolCalls).toBeUndefined();

    const native: ChatMessage = {
      role: "assistant",
      content: "Local tool request:\n- browser_task: {}",
      toolCalls: [{ id: "call_native", name: "browser_state", arguments: {} }]
    };
    expect(recoverTextualToolCalls(native, TOOLS)).toBe(native);

    const noTools = recoverTextualToolCalls(assistant('Local tool request:\n- browser_task: {"instruction": "x"}'), []);
    expect(noTools.toolCalls).toBeUndefined();
  });

  it("does not misfire on prose that merely mentions the transcript format", () => {
    const content = "Earlier the transcript contained a Local tool request: entry, which I have already handled.";
    const result = recoverTextualToolCalls(assistant(content), TOOLS);
    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe(content);
  });

  it("never recovers examples quoted inside markdown code fences", () => {
    const fenced = [
      "The transcript format looks like this:",
      "```",
      "Local tool request:",
      '- browser_task: {"instruction": "example only"}',
      "```"
    ].join("\n");
    expect(recoverTextualToolCalls(assistant(fenced), TOOLS).toolCalls).toBeUndefined();

    const fencedXml = [
      "Qwen wraps calls like so:",
      "```xml",
      '<tool_call>\n{"name": "browser_state", "arguments": {}}\n</tool_call>',
      "```"
    ].join("\n");
    expect(recoverTextualToolCalls(assistant(fencedXml), TOOLS).toolCalls).toBeUndefined();
  });

  it("does not recover a quoted block that is followed by more prose (end-of-message anchor)", () => {
    const content = [
      "The last run failed. It emitted:",
      "",
      "Local tool request:",
      '- browser_task: {"instruction": "Create the catalog item"}',
      "",
      "but the provider dropped it, so nothing executed. Want me to retry?"
    ].join("\n");

    const result = recoverTextualToolCalls(assistant(content), TOOLS);

    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe(content);
  });

  it("does not merge an unclosed function block with the next closed one", () => {
    // Lazy regex matching would otherwise pair the truncated block's name with the next
    // block's closing tag and execute mixed-up arguments under the wrong tool.
    const content = [
      "<function=read><parameter=path>",
      "secrets.txt",
      "</parameter>",
      "<function=search><parameter=query>",
      "hello",
      "</parameter></function>"
    ].join("\n");

    const result = recoverTextualToolCalls(assistant(content), TOOLS);

    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe(content);
  });

  it("recovers a real trailing block even when an earlier fenced example exists", () => {
    const content = [
      "As documented:",
      "```",
      '<tool_call>\n{"name": "browser_task", "arguments": {"instruction": "docs example"}}\n</tool_call>',
      "```",
      "Now executing for real:",
      '<tool_call>\n{"name": "browser_state", "arguments": {}}\n</tool_call>'
    ].join("\n");

    const result = recoverTextualToolCalls(assistant(content), TOOLS);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({ name: "browser_state", arguments: {} });
    expect(String(result.content)).toContain("docs example");
    expect(String(result.content)).toContain("Now executing for real:");
  });

  it("handles nested braces and escaped quotes inside recovered JSON arguments", () => {
    const content =
      'Local tool request:\n- browser_task: {\n  "instruction": "Set config to {\\"a\\": {\\"b\\": 1}} then finish",\n  "allowedDomains": ["example.com"]\n}';

    const result = recoverTextualToolCalls(assistant(content), TOOLS);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.arguments).toMatchObject({
      instruction: 'Set config to {"a": {"b": 1}} then finish',
      allowedDomains: ["example.com"]
    });
  });
});
