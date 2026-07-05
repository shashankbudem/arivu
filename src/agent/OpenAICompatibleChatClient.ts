import type { AppConfig } from "../config.js";
import { chatContentHasText, chatContentToText, type ChatContent, type ChatImagePart } from "./content.js";
import type { ChatClient, ChatMessage, ChatRequest, ChatResponse, ChatStreamHandler, ToolCall } from "./types.js";

type OpenAICompatibleConfig = Pick<AppConfig, "apiKey" | "baseUrl" | "model" | "trustMode"> &
  Partial<Pick<AppConfig, "toolCalling" | "tavilyApiKey" | "mcpServers">>;

type OpenAIContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
        detail?: "auto" | "low" | "high";
      };
    };

type OpenAIMessage = {
  role: string;
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

type OpenAIToolCallDelta = {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
    };
  }>;
};

type ToolCallAccumulator = {
  id: string;
  name: string;
  argumentsText: string;
};

export class OpenAICompatibleChatClient implements ChatClient {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  async complete(request: ChatRequest): Promise<ChatResponse> {
    return this.completeWithMode(request, initialCompletionMode(this.config));
  }

  private async completeWithMode(request: ChatRequest, mode: CompletionMode): Promise<ChatResponse> {
    if (!this.config.apiKey) {
      throw new Error("Missing ARIVU_API_KEY, legacy SHANKINSTER_API_KEY, or saved apiKey config.");
    }

    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(toOpenAIRequestBody(this.config.model, request, false, mode))
    });

    if (!response.ok) {
      const body = await response.text();
      if (mode === "tool_calls" && this.config.toolCalling !== "enabled" && shouldRetryWithoutTools(response.status, body, request)) {
        return this.completeWithMode(request, "markdown");
      }
      throw new Error(`Model request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{
        message?: OpenAIMessage;
      }>;
    };
    const message = json.choices?.[0]?.message;
    if (!message) {
      throw new Error("Model response did not include a message.");
    }

    return { message: fromOpenAIMessage(message) };
  }

  async stream(request: ChatRequest, onEvent?: ChatStreamHandler): Promise<ChatResponse> {
    if (!this.config.apiKey) {
      throw new Error("Missing ARIVU_API_KEY, legacy SHANKINSTER_API_KEY, or saved apiKey config.");
    }

    const mode = initialCompletionMode(this.config);
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(toOpenAIRequestBody(this.config.model, request, true, mode))
    });

    if (!response.ok) {
      const body = await response.text();
      if (mode === "tool_calls" && this.config.toolCalling !== "enabled" && shouldRetryWithoutTools(response.status, body, request)) {
        return this.completeWithMode(request, "markdown");
      }
      return this.completeWithMode(request, mode);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/event-stream")) {
      const text = await response.text();
      const parsed = parseBatchResponseText(text);
      return parsed ?? this.complete(request);
    }

    if (!response.body) {
      return this.complete(request);
    }

    const message: ChatMessage = { role: "assistant", content: "" };
    const toolCalls = new Map<number, ToolCallAccumulator>();
    const citationCleaner = new StreamingCitationCleaner();
    let emitted = false;

    const processChunk = async (chunk: OpenAIStreamChunk) => {
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta;
        if (!delta) {
          continue;
        }

        if (typeof delta.content === "string" && delta.content.length > 0) {
          const cleanDelta = citationCleaner.append(delta.content);
          if (cleanDelta) {
            message.content = `${chatContentToText(message.content)}${cleanDelta}`;
            emitted = true;
            await onEvent?.({ type: "content_delta", delta: cleanDelta });
          }
        }

        for (const callDelta of delta.tool_calls ?? []) {
          const index = callDelta.index ?? 0;
          const current = toolCalls.get(index) ?? {
            id: callDelta.id ?? `call_${index}`,
            name: "",
            argumentsText: ""
          };
          if (callDelta.id) {
            current.id = callDelta.id;
          }
          const nameDelta = callDelta.function?.name ?? "";
          const argumentsDelta = callDelta.function?.arguments ?? "";
          current.name += nameDelta;
          current.argumentsText += argumentsDelta;
          toolCalls.set(index, current);
          emitted = true;
          await onEvent?.({
            type: "tool_call_delta",
            index,
            id: current.id,
            name: current.name,
            argumentsDelta,
            argumentsText: current.argumentsText
          });
        }
      }
    };

    try {
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = "";
      let done = false;

      while (!done) {
        const read = await reader.read();
        done = read.done;
        buffer += decoder.decode(read.value, { stream: !done });

        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          const shouldContinue = await processSseEvent(event, processChunk);
          if (!shouldContinue) {
            done = true;
            break;
          }
        }
      }

      if (buffer.trim()) {
        await processSseEvent(buffer, processChunk);
      }
    } catch (error) {
      if (!emitted) {
        return this.complete(request);
      }
      throw error;
    }

    const cleanRemainder = citationCleaner.flush();
    if (cleanRemainder) {
      message.content = `${chatContentToText(message.content)}${cleanRemainder}`;
      await onEvent?.({ type: "content_delta", delta: cleanRemainder });
    }
    message.content = cleanCitationArtifacts(chatContentToText(message.content));

    const assembledToolCalls = Array.from(toolCalls.entries())
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        arguments: parseJson(call.argumentsText)
      }));
    if (assembledToolCalls.length > 0) {
      message.toolCalls = assembledToolCalls;
    }

    return { message };
  }
}

type CompletionMode = "tool_calls" | "markdown";

function initialCompletionMode(config: OpenAICompatibleConfig): CompletionMode {
  return config.toolCalling === "disabled" ? "markdown" : "tool_calls";
}

function toOpenAIRequestBody(model: string, request: ChatRequest, stream: boolean, mode: CompletionMode) {
  const body: Record<string, unknown> = {
    model,
    messages: messagesForMode(request, mode).map(toOpenAIMessage).filter(isSendableOpenAIMessage)
  };

  if (stream) {
    body.stream = true;
  }

  if (mode === "tool_calls" && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
    body.tool_choice = "auto";
  }

  return body;
}

function messagesForMode(request: ChatRequest, mode: CompletionMode): ChatMessage[] {
  if (mode === "tool_calls") {
    return request.tools.length > 0 ? request.messages : stripToolProtocolMessages(request.messages);
  }

  return insertFallbackInstruction(stripToolProtocolMessages(request.messages));
}

function shouldRetryWithoutTools(status: number, body: string, request: ChatRequest) {
  if (!hasToolProtocol(request) || ![400, 404, 422, 500].includes(status)) {
    return false;
  }
  const toolRelated = /\b(tool|tools|tool_calls|tool_call_id|tool_choice|function calling|function_call|functions)\b/i.test(body);
  const decodeRelated = /\b(failed to decode json body|decode json|decode json body|invalid json|invalid character|unexpected end of JSON input|invalid request body)\b/i.test(body);
  const emptyAssistantContentRelated = /\bempty content\b/i.test(body) && /\bassistant messages?\b/i.test(body);
  return toolRelated || decodeRelated || emptyAssistantContentRelated;
}

function hasToolProtocol(request: ChatRequest) {
  return request.tools.length > 0 || request.messages.some((message) => message.role === "tool" || Boolean(message.toolCalls?.length));
}

function insertFallbackInstruction(messages: ChatMessage[]): ChatMessage[] {
  const instruction: ChatMessage = {
    role: "system",
    content: [
      "Tool calling is unavailable for this model endpoint.",
      "The previous local tool requests and results have been converted into plain-text transcript entries.",
      "Do not emit tool calls or function-call JSON.",
      "Reply in Markdown using the provided transcript."
    ].join("\n")
  };

  const firstNonSystem = messages.findIndex((message) => message.role !== "system");
  if (firstNonSystem === -1) {
    return [...messages, instruction];
  }
  return [...messages.slice(0, firstNonSystem), instruction, ...messages.slice(firstNonSystem)];
}

function stripToolProtocolMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      const label = message.name ? ` from ${message.name}` : "";
      const id = message.toolCallId ? ` (${message.toolCallId})` : "";
      return {
        role: "user",
        content: `Local tool result${label}${id}:\n${chatContentToText(message.content)}`
      };
    }

    if (message.toolCalls?.length) {
      const content = chatContentToText(message.content).trim();
      const toolRequests = message.toolCalls
        .map((call) => `- ${call.name}: ${formatToolArguments(call.arguments)}`)
        .join("\n");
      return {
        role: message.role,
        content: [content, `Local tool request${message.toolCalls.length === 1 ? "" : "s"}:\n${toolRequests}`].filter(Boolean).join("\n\n")
      };
    }

    return {
      role: message.role,
      content: message.content
    };
  });
}

function formatToolArguments(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toOpenAIMessage(message: ChatMessage): OpenAIMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: chatContentToText(message.content),
      tool_call_id: message.toolCallId
    };
  }

  const toolCalls = message.toolCalls?.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments)
    }
  }));

  return {
    role: message.role,
    content: message.role === "assistant" && toolCalls?.length && !chatContentHasText(message.content) ? null : toOpenAIContent(message.content),
    tool_calls: toolCalls
  };
}

function isSendableOpenAIMessage(message: OpenAIMessage) {
  if (message.role !== "assistant") {
    return true;
  }
  return Boolean(message.tool_calls?.length) || hasOpenAIContent(message.content);
}

function fromOpenAIMessage(message: OpenAIMessage): ChatMessage {
  const toolCalls: ToolCall[] | undefined = message.tool_calls?.map((call) => ({
    id: call.id,
    name: call.function.name,
    arguments: parseJson(call.function.arguments)
  }));

  return {
    role: "assistant",
    content: cleanCitationArtifacts(openAIContentToText(message.content)),
    toolCalls
  };
}

function toOpenAIContent(content: ChatContent): string | OpenAIContentPart[] {
  if (typeof content === "string") {
    return content;
  }

  return content.map((part) => {
    if (part.type === "text") {
      return {
        type: "text" as const,
        text: part.text
      };
    }
    return toOpenAIImagePart(part);
  });
}

function toOpenAIImagePart(part: ChatImagePart): OpenAIContentPart {
  return {
    type: "image_url",
    image_url: {
      url: part.image_url.url,
      ...(part.image_url.detail ? { detail: part.image_url.detail } : {})
    }
  };
}

function hasOpenAIContent(content: OpenAIMessage["content"]) {
  if (content === null) {
    return false;
  }
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  return content.some((part) => {
    if (part.type === "text") {
      return part.text.trim().length > 0;
    }
    return Boolean(part.image_url.url);
  });
}

function openAIContentToText(content: OpenAIMessage["content"]) {
  if (content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      return "[Image]";
    })
    .join("\n");
}

function cleanCitationArtifacts(content: string) {
  return content
    .replace(/【\d+†L\d+(?:-L\d+)?】/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
}

class StreamingCitationCleaner {
  private pending = "";

  append(delta: string) {
    this.pending += delta;
    const safeLength = safeCitationPrefixLength(this.pending);
    const safeText = this.pending.slice(0, safeLength);
    this.pending = this.pending.slice(safeLength);
    return cleanCitationArtifacts(safeText);
  }

  flush() {
    const remainder = cleanCitationArtifacts(this.pending);
    this.pending = "";
    return remainder;
  }
}

function safeCitationPrefixLength(content: string) {
  const openIndex = content.lastIndexOf("【");
  if (openIndex === -1) {
    return content.length;
  }

  const closeIndex = content.indexOf("】", openIndex);
  return closeIndex === -1 ? openIndex : content.length;
}

async function processSseEvent(event: string, processChunk: (chunk: OpenAIStreamChunk) => Promise<void>) {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();

  if (!data) {
    return true;
  }
  if (data === "[DONE]") {
    return false;
  }

  await processChunk(JSON.parse(data) as OpenAIStreamChunk);
  return true;
}

function parseBatchResponseText(text: string): ChatResponse | undefined {
  try {
    const json = JSON.parse(text) as {
      choices?: Array<{
        message?: OpenAIMessage;
      }>;
    };
    const message = json.choices?.[0]?.message;
    return message ? { message: fromOpenAIMessage(message) } : undefined;
  } catch {
    return undefined;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
