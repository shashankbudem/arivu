import type { AppConfig } from "../config.js";
import { chatContentHasImage, chatContentHasText, chatContentToText, type ChatContent, type ChatImagePart } from "./content.js";
import { recoverTextualToolCalls } from "./textualToolCalls.js";
import type {
  ChatCallOptions,
  ChatClient,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamHandler,
  ChatUsage,
  ToolCall
} from "./types.js";

type OpenAICompatibleConfig = Pick<AppConfig, "apiKey" | "baseUrl" | "model" | "trustMode"> &
  Partial<Pick<AppConfig, "toolCalling" | "imageInput" | "tavilyApiKey" | "mcpServers" | "requestTimeoutMs">> & {
    onCapabilityObservation?: (observation: ProviderCapabilityObservation) => void | Promise<void>;
    maxRequestRetries?: number;
    maxRateLimitRetries?: number;
    /** Invoked once per model call with a redacted diagnostics record (for the API request log). */
    onRequestLog?: (entry: ApiRequestLogEntry) => void;
    /** When true, the log entry also carries the (redacted, truncated) request messages and response body. */
    captureRequestBodies?: boolean;
  };

/**
 * One model call's diagnostics, as surfaced in the API request log. Never contains the API key
 * (redacted) or request headers. `outcome: "empty"` is the exact condition the agent rejects with
 * "empty assistant response" — no content and no tool calls that survive availability filtering.
 */
export type ApiRequestLogEntry = {
  id: string;
  at: string;
  model: string;
  streamed: boolean;
  status?: number;
  ok: boolean;
  outcome: "ok" | "empty" | "error";
  durationMs: number;
  retries: number;
  toolsOffered: string[];
  toolCalls: string[];
  /** Tool calls the model made that were NOT offered this turn (the agent filters these out). */
  droppedToolCalls: string[];
  contentChars: number;
  finishReason?: string;
  usage?: ChatUsage;
  error?: string;
  requestMessages?: Array<{ role: string; content: string; toolCalls?: string[] }>;
  responseBody?: string;
};

/** Per-call, mutable capture context threaded into fetchWithRetry so logging never races across calls. */
type RequestCapture = { status?: number; retries: number; finishReason?: string };

const LOG_MESSAGE_CONTENT_MAX = 4_000;
const LOG_RESPONSE_BODY_MAX = 8_000;
let apiRequestLogSeq = 0;

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REQUEST_RETRIES = 2;
// Rate limits (429) are transient and the server tells us exactly when capacity returns, so they
// get their own, more generous retry budget than generic 5xx/timeout errors — a rate-limit blip
// mid-run shouldn't discard minutes of work, but a genuinely broken upstream should still fail fast.
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_STATUS = 429;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;
// Our own exponential backoff is capped at MAX_RETRY_DELAY_MS, but a server-directed Retry-After is
// an explicit "capacity returns at T" — retrying before then just re-hits the limit and wastes an
// attempt — so we honor it up to a much higher ceiling.
const MAX_RETRY_AFTER_MS = 60_000;

export type ProviderCapabilityObservation = {
  capability: "toolCalling" | "imageInput";
  value: "disabled";
  source: "provider_error";
  status: number;
  detail: string;
};

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

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage | null;
};

type ToolCallAccumulator = {
  id: string;
  name: string;
  argumentsText: string;
};

type FetchAttempt = {
  response: Response;
  /** Present only for a non-ok response whose body was already consumed by the retry loop. */
  errorBody?: string;
};

export class OpenAICompatibleChatClient implements ChatClient {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  async complete(request: ChatRequest, options?: ChatCallOptions): Promise<ChatResponse> {
    const startedAt = Date.now();
    const capture: RequestCapture = { retries: 0 };
    try {
      const response = await this.completeWithMode(request, initialCompletionMode(this.config), options, capture);
      this.emitRequestLog(request, response, capture, startedAt, false);
      return response;
    } catch (error) {
      this.emitRequestLog(request, undefined, capture, startedAt, false, error);
      throw error;
    }
  }

  private async completeWithMode(
    request: ChatRequest,
    mode: CompletionMode,
    options: ChatCallOptions | undefined,
    capture: RequestCapture
  ): Promise<ChatResponse> {
    if (!this.config.apiKey) {
      throw new Error("Missing ARIVU_API_KEY, legacy SHANKINSTER_API_KEY, or saved apiKey config.");
    }
    assertImageInputAllowed(this.config, request);

    const { response, errorBody } = await this.fetchWithRetry(
      toOpenAIRequestBody(this.config.model, request, false, mode),
      options?.signal,
      (status, body) => this.isFallbackError(request, mode, status, body),
      capture
    );

    if (!response.ok) {
      const body = errorBody ?? (await response.text());
      if (mode === "tool_calls" && this.config.toolCalling !== "enabled" && shouldRetryWithoutTools(response.status, body, request)) {
        await this.observeCapability("toolCalling", response.status, body);
        return this.completeWithMode(request, "markdown", options, capture);
      }
      if (this.config.imageInput !== "enabled" && shouldPersistImageInputUnsupported(response.status, body, request)) {
        await this.observeCapability("imageInput", response.status, body);
      }
      throw new Error(`Model request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{
        message?: OpenAIMessage;
        finish_reason?: string | null;
      }>;
      usage?: OpenAIUsage | null;
    };
    const message = json.choices?.[0]?.message;
    if (!message) {
      throw new Error("Model response did not include a message.");
    }
    capture.finishReason = json.choices?.[0]?.finish_reason ?? capture.finishReason;

    // Some providers return the model's tool-call syntax unparsed inside content; recover it
    // into native tool calls so the agent can execute instead of ending the run on prose.
    return withUsage(
      {
        message: recoverTextualToolCalls(
          fromOpenAIMessage(message),
          request.tools.map((tool) => tool.name)
        )
      },
      json.usage
    );
  }

  async stream(request: ChatRequest, onEvent?: ChatStreamHandler, options?: ChatCallOptions): Promise<ChatResponse> {
    const startedAt = Date.now();
    const capture: RequestCapture = { retries: 0 };
    try {
      const response = await this.streamImpl(request, onEvent, options, capture);
      this.emitRequestLog(request, response, capture, startedAt, true);
      return response;
    } catch (error) {
      this.emitRequestLog(request, undefined, capture, startedAt, true, error);
      throw error;
    }
  }

  private async streamImpl(
    request: ChatRequest,
    onEvent: ChatStreamHandler | undefined,
    options: ChatCallOptions | undefined,
    capture: RequestCapture
  ): Promise<ChatResponse> {
    if (!this.config.apiKey) {
      throw new Error("Missing ARIVU_API_KEY, legacy SHANKINSTER_API_KEY, or saved apiKey config.");
    }
    assertImageInputAllowed(this.config, request);

    const mode = initialCompletionMode(this.config);
    const { response, errorBody } = await this.fetchWithRetry(
      toOpenAIRequestBody(this.config.model, request, true, mode),
      options?.signal,
      (status, body) => this.isFallbackError(request, mode, status, body),
      capture
    );

    if (!response.ok) {
      const body = errorBody ?? (await response.text());
      if (mode === "tool_calls" && this.config.toolCalling !== "enabled" && shouldRetryWithoutTools(response.status, body, request)) {
        await this.observeCapability("toolCalling", response.status, body);
        return this.completeWithMode(request, "markdown", options, capture);
      }
      if (this.config.imageInput !== "enabled" && shouldPersistImageInputUnsupported(response.status, body, request)) {
        await this.observeCapability("imageInput", response.status, body);
        throw new Error(`Model request failed (${response.status}): ${body}`);
      }
      return this.completeWithMode(request, mode, options, capture);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/event-stream")) {
      const text = await response.text();
      const parsed = parseBatchResponseText(text);
      if (parsed) {
        // The batch fallback needs textual tool-call recovery just like the other return paths.
        return {
          ...parsed,
          message: recoverTextualToolCalls(
            parsed.message,
            request.tools.map((tool) => tool.name)
          )
        };
      }
      return this.completeWithMode(request, initialCompletionMode(this.config), options, capture);
    }

    if (!response.body) {
      return this.completeWithMode(request, initialCompletionMode(this.config), options, capture);
    }

    const message: ChatMessage = { role: "assistant", content: "" };
    const toolCalls = new Map<number, ToolCallAccumulator>();
    const citationCleaner = new StreamingCitationCleaner();
    let emitted = false;
    let usage: OpenAIUsage | undefined;

    const processChunk = async (chunk: OpenAIStreamChunk) => {
      if (chunk.usage) {
        usage = chunk.usage;
      }
      for (const choice of chunk.choices ?? []) {
        if (choice.finish_reason) {
          capture.finishReason = choice.finish_reason;
        }
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
        return this.completeWithMode(request, initialCompletionMode(this.config), options, capture);
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

    // See completeWithMode: recover provider-unparsed textual tool calls from streamed content.
    return withUsage(
      {
        message: recoverTextualToolCalls(
          message,
          request.tools.map((tool) => tool.name)
        )
      },
      usage
    );
  }

  private async fetchWithRetry(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    // Returns true for errors the caller handles itself (tool/markdown/image fallbacks); these are
    // not transient, so we stop retrying and hand the response back for the fallback path.
    isFallbackError: (status: number, errorBody: string) => boolean,
    capture: RequestCapture
  ): Promise<FetchAttempt> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const payload = JSON.stringify(body);
    const maxRetries = Math.max(0, this.config.maxRequestRetries ?? DEFAULT_MAX_REQUEST_RETRIES);
    const maxRateLimitRetries = Math.max(maxRetries, this.config.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES);
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    // Rate-limit retries are counted separately so a 429 storm doesn't consume the (smaller) budget
    // reserved for genuine transient failures, and vice versa.
    let attempt = 0;
    let rateLimitAttempt = 0;
    for (;;) {
      throwIfAborted(signal);
      const attemptController = new AbortController();
      const removeLink = linkAbortSignal(signal, attemptController);
      const timeout = setTimeout(() => attemptController.abort(new Error(`Model request timed out after ${timeoutMs}ms.`)), timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json"
          },
          body: payload,
          signal: attemptController.signal
        });
      } catch (error) {
        clearTimeout(timeout);
        removeLink();
        // A caller-initiated abort is terminal; do not retry it.
        if (signal?.aborted) {
          throw abortError(signal);
        }
        if (attempt >= maxRetries) {
          throw error;
        }
        await delay(retryDelayMs(attempt), signal);
        attempt += 1;
        continue;
      }
      clearTimeout(timeout);
      removeLink();
      // Record the latest attempt's status and how many retries it took, for the request log.
      // All three return paths below pass through here first, so the log always sees final values.
      capture.status = response.status;
      capture.retries = attempt + rateLimitAttempt;

      if (response.ok) {
        return { response };
      }

      // Read the error body once; the fallback path and the thrown error both reuse it.
      const errorBody = await response.text().catch(() => "");
      if (!RETRYABLE_STATUS_CODES.has(response.status) || isFallbackError(response.status, errorBody)) {
        return { response, errorBody };
      }

      // 429s draw from their own larger budget; everything else uses the generic retry budget.
      const isRateLimit = response.status === RATE_LIMIT_STATUS;
      const usedAttempts = isRateLimit ? rateLimitAttempt : attempt;
      const budget = isRateLimit ? maxRateLimitRetries : maxRetries;
      if (usedAttempts >= budget) {
        return { response, errorBody };
      }

      const retryAfterMs = retryAfterFromHeaders(response.headers) ?? retryDelayMs(usedAttempts);
      await delay(retryAfterMs, signal);
      if (isRateLimit) {
        rateLimitAttempt += 1;
      } else {
        attempt += 1;
      }
    }
  }

  private isFallbackError(request: ChatRequest, mode: CompletionMode, status: number, body: string): boolean {
    if (mode === "tool_calls" && this.config.toolCalling !== "enabled" && shouldRetryWithoutTools(status, body, request)) {
      return true;
    }
    return this.config.imageInput !== "enabled" && shouldPersistImageInputUnsupported(status, body, request);
  }

  private async observeCapability(capability: ProviderCapabilityObservation["capability"], status: number, body: string) {
    await this.config.onCapabilityObservation?.({
      capability,
      value: "disabled",
      source: "provider_error",
      status,
      detail: compactErrorDetail(body)
    });
  }

  /**
   * Builds one API-request-log record for a finished model call and hands it to the configured sink.
   * Defensive: a failure here must never surface as a model-call failure, so everything is wrapped.
   */
  private emitRequestLog(
    request: ChatRequest,
    response: ChatResponse | undefined,
    capture: RequestCapture,
    startedAt: number,
    streamed: boolean,
    error?: unknown
  ): void {
    const sink = this.config.onRequestLog;
    if (!sink) {
      return;
    }
    try {
      const key = this.config.apiKey;
      const toolsOffered = request.tools.map((tool) => tool.name);
      const offered = new Set(toolsOffered);
      const toolCalls = response?.message.toolCalls?.map((call) => call.name) ?? [];
      const droppedToolCalls = [...new Set(toolCalls.filter((name) => !offered.has(name)))];
      const survivingToolCalls = toolCalls.filter((name) => offered.has(name));
      const contentChars = response ? chatContentToText(response.message.content).trim().length : 0;
      // "empty" mirrors exactly what the agent rejects: no content and no tool call that survives
      // availability filtering (so a turn that only called unavailable tools reads as empty here too).
      const outcome: ApiRequestLogEntry["outcome"] = error
        ? "error"
        : contentChars === 0 && survivingToolCalls.length === 0
          ? "empty"
          : "ok";
      const entry: ApiRequestLogEntry = {
        id: `req_${(apiRequestLogSeq += 1)}`,
        at: new Date().toISOString(),
        model: this.config.model,
        streamed,
        status: capture.status,
        ok: !error && (capture.status === undefined || capture.status < 400),
        outcome,
        durationMs: Date.now() - startedAt,
        retries: capture.retries,
        toolsOffered,
        toolCalls,
        droppedToolCalls,
        contentChars,
        finishReason: capture.finishReason,
        usage: response?.usage,
        error: error ? stripApiKey(errorMessageText(error), key) : undefined
      };
      if (this.config.captureRequestBodies) {
        entry.requestMessages = request.messages.map((message) => ({
          role: message.role,
          content: truncateForLog(stripApiKey(chatContentToText(message.content), key), LOG_MESSAGE_CONTENT_MAX),
          toolCalls: message.toolCalls?.map((call) => call.name)
        }));
        if (response) {
          entry.responseBody = truncateForLog(
            stripApiKey(
              JSON.stringify({
                content: chatContentToText(response.message.content),
                toolCalls: response.message.toolCalls
              }),
              key
            ),
            LOG_RESPONSE_BODY_MAX
          );
        }
      }
      sink(entry);
    } catch {
      // Diagnostics must never break a real model call.
    }
  }
}

function stripApiKey(text: string, apiKey: string | undefined): string {
  if (!apiKey || apiKey.length < 8) {
    return text;
  }
  return text.split(apiKey).join("***REDACTED***");
}

function truncateForLog(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (+${text.length - max} more chars)`;
}

function errorMessageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type CompletionMode = "tool_calls" | "markdown";

function initialCompletionMode(config: OpenAICompatibleConfig): CompletionMode {
  return config.toolCalling === "disabled" ? "markdown" : "tool_calls";
}

function assertImageInputAllowed(config: OpenAICompatibleConfig, request: ChatRequest) {
  if (config.imageInput !== "disabled") {
    return;
  }
  if (!request.messages.some((message) => chatContentHasImage(message.content))) {
    return;
  }
  throw new Error("Image input is disabled for this provider. Enable Image input in Settings or choose an image-capable provider/model.");
}

function toOpenAIRequestBody(model: string, request: ChatRequest, stream: boolean, mode: CompletionMode) {
  const body: Record<string, unknown> = {
    model,
    messages: messagesForMode(request, mode).map(toOpenAIMessage).filter(isSendableOpenAIMessage)
  };

  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
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
  const decodeRelated =
    /\b(failed to decode json body|decode json|decode json body|invalid json|invalid character|unexpected end of JSON input|invalid request body)\b/i.test(
      body
    );
  const emptyAssistantContentRelated = /\bempty content\b/i.test(body) && /\bassistant messages?\b/i.test(body);
  return toolRelated || decodeRelated || emptyAssistantContentRelated;
}

function shouldPersistImageInputUnsupported(status: number, body: string, request: ChatRequest) {
  if (!request.messages.some((message) => chatContentHasImage(message.content)) || ![400, 404, 415, 422, 500].includes(status)) {
    return false;
  }
  const imageRelated =
    /\b(image|images|image_url|vision|visual|multimodal|multi-modal|content part|content parts|input image|data url|base64)\b/i.test(body);
  const unsupportedRelated =
    /\b(unsupported|not supported|does not support|do not support|invalid|unrecognized|unknown|cannot|can't|text[- ]?only|media type)\b/i.test(
      body
    );
  return imageRelated && unsupportedRelated;
}

function compactErrorDetail(body: string) {
  return body.replace(/\s+/g, " ").trim().slice(0, 500);
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
      const toolRequests = message.toolCalls.map((call) => `- ${call.name}: ${formatToolArguments(call.arguments)}`).join("\n");
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
    content:
      message.role === "assistant" && toolCalls?.length && !chatContentHasText(message.content) ? null : toOpenAIContent(message.content),
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
      usage?: OpenAIUsage | null;
    };
    const message = json.choices?.[0]?.message;
    return message ? withUsage({ message: fromOpenAIMessage(message) }, json.usage) : undefined;
  } catch {
    return undefined;
  }
}

function withUsage(response: ChatResponse, usage: OpenAIUsage | null | undefined): ChatResponse {
  const normalized = normalizeUsage(usage);
  return normalized ? { ...response, usage: normalized } : response;
}

function normalizeUsage(usage: OpenAIUsage | null | undefined): ChatUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = numericField(usage.prompt_tokens);
  const completionTokens = numericField(usage.completion_tokens);
  const totalTokens = numericField(usage.total_tokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? { totalTokens: sumTokens(promptTokens, completionTokens) } : { totalTokens })
  };
}

function sumTokens(promptTokens: number | undefined, completionTokens: number | undefined) {
  if (promptTokens === undefined && completionTokens === undefined) {
    return undefined;
  }
  return (promptTokens ?? 0) + (completionTokens ?? 0);
}

function numericField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(typeof reason === "string" && reason ? reason : "Model request aborted.");
  error.name = "AbortError";
  return error;
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) {
    return () => undefined;
  }
  if (source.aborted) {
    target.abort(source.reason);
    return () => undefined;
  }
  const onAbort = () => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function retryDelayMs(attempt: number) {
  const capped = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** attempt);
  // Full jitter (AWS-style): wait between half and all of the capped backoff, so several clients
  // sharing one API key (e.g. the main agent and an in-page browser task) don't retry in lockstep
  // and immediately re-trip the same rate limit.
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

export function retryAfterFromHeaders(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, seconds * 1_000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, dateMs - Date.now()));
  }
  return undefined;
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(abortError(signal));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
