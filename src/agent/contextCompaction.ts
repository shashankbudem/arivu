import { chatContentToText, type ChatContent, type ChatContentPart } from "./content.js";
import type { AgentSession, ChatMessage } from "./types.js";

export const COMPACT_RECENT_MESSAGE_COUNT = 8;
export const AUTO_COMPACT_REQUEST_TOKEN_LIMIT = 48_000;
export const AUTO_COMPACT_REQUEST_RECENT_MESSAGE_COUNT = 8;
export const AUTO_COMPACT_REQUEST_ENTRY_CHARACTER_LIMIT = 700;
export const AUTO_COMPACT_REQUEST_RECENT_CHARACTER_LIMIT = 6_000;
export const AUTO_COMPACT_REQUEST_ACTIVE_USER_CHARACTER_LIMIT = 32_000;

const COMPACTION_PREFIX = "Context compacted locally to reduce future model requests.";
export const MODEL_SUMMARY_PREFIX = "Conversation summary (model-generated) to reduce context size.";
const DEFAULT_ENTRY_LIMIT = 700;

/**
 * Tools whose output can be regenerated on demand (the file is still on disk, the page can be
 * re-snapshotted, the search can be re-run). Their older results carry almost no unique
 * information, so compaction collapses them to a stub instead of spending transcript budget on
 * stale copies. Results of tools NOT listed here (edits, commands, browser actions) describe
 * something that HAPPENED and cannot be re-observed, so they keep the regular budget.
 */
const REDERIVABLE_RESULT_TOOLS = new Set([
  "list",
  "read",
  "search",
  "git_status",
  "web_search",
  "browser_state",
  "browser_snapshot",
  "browser_screenshot",
  "browser_console",
  "current_datetime",
  "current_location",
  "list_skills",
  "read_skill",
  "mcp_list_tools"
]);
/** Head kept from a collapsed re-derivable result so the bullet still shows what came back. */
const REDERIVABLE_RESULT_HEAD_CHARS = 160;
/** Head kept from a succeeded command/browser-task result; the outcome line is what matters. */
const SUCCEEDED_RESULT_HEAD_CHARS = 200;
/** Failed commands/browser tasks keep head plus this much tail — errors live at the end. */
const FAILED_RESULT_TAIL_CHARS = 1_000;

type CompactOptions = {
  recentMessageCount?: number;
  entryCharacterLimit?: number;
  recentEntryCharacterLimit?: number;
  activeUserMessageCharacterLimit?: number;
  preserveLatestUserMessage?: boolean;
  force?: boolean;
  now?: Date;
};

type ModelRequestCompactOptions = CompactOptions & {
  tokenLimit?: number;
};

export type ContextCompactionResult = {
  messages: ChatMessage[];
  compacted: boolean;
  compactedMessageCount: number;
  remainingMessageCount: number;
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
};

type ContextCompactionSession = Pick<AgentSession, "messages" | "contextCompaction">;

/**
 * Build the model's current working context without changing the canonical transcript.
 *
 * A checkpoint contains the summary and recent non-system tail that survived the last
 * compaction. New canonical messages are appended after that checkpoint. Current system
 * messages are always re-read from the canonical transcript so changed workspace instructions,
 * loaded skills, and recovery notes cannot go stale inside a saved checkpoint.
 */
export function contextMessagesForSession(session: ContextCompactionSession): ChatMessage[] {
  const checkpoint = session.contextCompaction;
  if (!checkpoint) {
    return session.messages;
  }

  const canonicalNonSystemMessages = session.messages.filter((message) => message.role !== "system");
  if (checkpoint.sourceNonSystemMessageCount > canonicalNonSystemMessages.length) {
    // The transcript was intentionally rewound (for example, retry-from-message). A checkpoint
    // that covers messages no longer in that branch must never reintroduce them.
    return session.messages;
  }

  const currentSystemMessages = session.messages.filter(
    (message) => message.role === "system" && !isCompactionMessage(message) && !isModelSummaryMessage(message)
  );
  const checkpointSummaryMessages = checkpoint.messages.filter((message) => isCompactionMessage(message) || isModelSummaryMessage(message));
  const checkpointNonSystemMessages = checkpoint.messages.filter((message) => message.role !== "system");
  const newNonSystemMessages = canonicalNonSystemMessages.slice(checkpoint.sourceNonSystemMessageCount);

  return [...currentSystemMessages, ...checkpointSummaryMessages, ...checkpointNonSystemMessages, ...newNonSystemMessages];
}

/**
 * Save a reduced context as a derived checkpoint while leaving `session.messages` byte-for-byte
 * intact. The checkpoint stores only its summary and reduced non-system tail; canonical system
 * instructions are re-projected by `contextMessagesForSession` each time.
 */
export function applyContextCompactionCheckpoint(
  session: ContextCompactionSession,
  result: ContextCompactionResult,
  source: "model" | "deterministic",
  now = new Date()
): void {
  if (!result.compacted) {
    return;
  }
  session.contextCompaction = {
    version: 1,
    source,
    compactedAt: now.toISOString(),
    compactedMessageCount: result.compactedMessageCount,
    sourceNonSystemMessageCount: session.messages.filter((message) => message.role !== "system").length,
    messages: result.messages.filter(
      (message) => message.role !== "system" || isCompactionMessage(message) || isModelSummaryMessage(message)
    )
  };
}

export function clearContextCompactionCheckpoint(session: ContextCompactionSession): void {
  delete session.contextCompaction;
}

export function compactSessionMessages(messages: ChatMessage[], options: CompactOptions = {}): ContextCompactionResult {
  const recentMessageCount = options.recentMessageCount ?? COMPACT_RECENT_MESSAGE_COUNT;
  const entryCharacterLimit = options.entryCharacterLimit ?? DEFAULT_ENTRY_LIMIT;
  const recentEntryCharacterLimit = options.recentEntryCharacterLimit;
  const preserveLatestUserMessage = options.preserveLatestUserMessage ?? false;
  const activeUserMessageCharacterLimit = options.activeUserMessageCharacterLimit ?? recentEntryCharacterLimit;
  const systemMessages = messages.filter(
    (message) => message.role === "system" && !isCompactionMessage(message) && !isModelSummaryMessage(message)
  );
  const previousCompactions = messages.filter((message) => isCompactionMessage(message) || isModelSummaryMessage(message));
  const nonSystemMessages = messages.filter((message) => message.role !== "system");

  if (!options.force && nonSystemMessages.length <= recentMessageCount) {
    return {
      messages,
      compacted: false,
      compactedMessageCount: 0,
      remainingMessageCount: nonSystemMessages.length
    };
  }

  const recentStart = Math.max(0, nonSystemMessages.length - recentMessageCount);
  const latestUserMessageIndex = preserveLatestUserMessage ? latestUserIndex(nonSystemMessages) : -1;
  const latestUserMessage = latestUserMessageIndex >= 0 ? nonSystemMessages[latestUserMessageIndex] : undefined;
  const pinnedLatestUser =
    latestUserMessage && latestUserMessageIndex < recentStart
      ? [toPinnedUserMessage(latestUserMessage, activeUserMessageCharacterLimit)]
      : [];
  const olderMessages = nonSystemMessages.filter((_message, index) => index < recentStart && index !== latestUserMessageIndex);
  const recentMessages = nonSystemMessages
    .slice(recentStart)
    .map((message, index) =>
      toPlainTranscriptMessage(
        message,
        recentStart + index === latestUserMessageIndex ? activeUserMessageCharacterLimit : recentEntryCharacterLimit,
        recentStart + index === latestUserMessageIndex && preserveLatestUserMessage
      )
    );
  const compactedAt = (options.now ?? new Date()).toISOString();
  const compactedMessage: ChatMessage = {
    role: "system",
    content: [
      COMPACTION_PREFIX,
      `Compacted at: ${compactedAt}`,
      `Compacted messages: ${olderMessages.length}`,
      // Textified tool exchanges below use a "Local tool request/result" transcript format;
      // without this warning, some models imitate that format in their replies instead of
      // making native tool calls, and the run ends without executing anything.
      'Lines like "Local tool request:" and "Local tool result" below are historical records, not a format to reply in. To use a tool, emit a native tool call; never write a tool invocation as plain text.',
      "Older transcript summary:",
      buildCompactionSummary([...previousCompactions, ...olderMessages], entryCharacterLimit)
    ].join("\n")
  };

  return {
    messages: [...systemMessages, compactedMessage, ...pinnedLatestUser, ...recentMessages],
    compacted: true,
    compactedMessageCount: olderMessages.length,
    remainingMessageCount: pinnedLatestUser.length + recentMessages.length
  };
}

export function compactMessagesForModelRequest(messages: ChatMessage[], options: ModelRequestCompactOptions = {}): ContextCompactionResult {
  const tokenLimit = options.tokenLimit ?? AUTO_COMPACT_REQUEST_TOKEN_LIMIT;
  const estimatedTokensBefore = estimateMessageTokens(messages);
  if (!options.force && estimatedTokensBefore <= tokenLimit) {
    return {
      messages,
      compacted: false,
      compactedMessageCount: 0,
      remainingMessageCount: messages.filter((message) => message.role !== "system").length,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore
    };
  }

  const compacted = compactSessionMessages(messages, {
    recentMessageCount: options.recentMessageCount ?? AUTO_COMPACT_REQUEST_RECENT_MESSAGE_COUNT,
    entryCharacterLimit: options.entryCharacterLimit ?? AUTO_COMPACT_REQUEST_ENTRY_CHARACTER_LIMIT,
    recentEntryCharacterLimit: options.recentEntryCharacterLimit ?? AUTO_COMPACT_REQUEST_RECENT_CHARACTER_LIMIT,
    activeUserMessageCharacterLimit: options.activeUserMessageCharacterLimit ?? AUTO_COMPACT_REQUEST_ACTIVE_USER_CHARACTER_LIMIT,
    preserveLatestUserMessage: options.preserveLatestUserMessage ?? true,
    force: true,
    now: options.now
  });
  return {
    ...compacted,
    estimatedTokensBefore,
    estimatedTokensAfter: estimateMessageTokens(compacted.messages)
  };
}

export function estimateMessageTokens(messages: ChatMessage[]) {
  const transcript = messages.map((message) => `${message.role}: ${transcriptContent(message)}`).join("\n\n");
  return Math.ceil(transcript.length / 4);
}

/**
 * The older, to-be-summarized slice of the conversation (everything but the base system messages and
 * the most recent `recentMessageCount` turns). Callers feed this to the model to produce a summary.
 */
export function messagesToSummarize(messages: ChatMessage[], recentMessageCount = COMPACT_RECENT_MESSAGE_COUNT): ChatMessage[] {
  // A prior summary (model-generated or deterministic) IS older context. If it is not fed back into
  // the summarizer, the second summary forgets everything the first one covered: applyModelSummary
  // rebuilds the kept set from base system messages + recent turns and drops the old summary, so
  // whatever only lived inside that summary vanishes. Carrying prior summaries forward here is the
  // model-path equivalent of compactSessionMessages folding previousCompactions into the new summary.
  const priorSummaries = messages.filter((message) => isModelSummaryMessage(message) || isCompactionMessage(message));
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  const recentStart = Math.max(0, nonSystemMessages.length - recentMessageCount);
  return [...priorSummaries, ...nonSystemMessages.slice(0, recentStart)];
}

/**
 * Replace the older conversation with a single model-generated summary system message, keeping the
 * base system prompt(s) and the most recent turns verbatim. Leading orphan tool results (whose
 * originating tool call fell into the summarized slice) are dropped to keep the tool protocol valid.
 */
export function applyModelSummary(
  messages: ChatMessage[],
  summary: string,
  options: { recentMessageCount?: number; now?: Date } = {}
): ContextCompactionResult {
  const recentMessageCount = options.recentMessageCount ?? COMPACT_RECENT_MESSAGE_COUNT;
  const systemMessages = messages.filter(
    (message) => message.role === "system" && !isCompactionMessage(message) && !isModelSummaryMessage(message)
  );
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  const recentStart = Math.max(0, nonSystemMessages.length - recentMessageCount);
  const olderCount = recentStart;
  let recentMessages = nonSystemMessages.slice(recentStart);
  let droppedOrphans = 0;
  while (recentMessages.length > 0 && recentMessages[0]?.role === "tool") {
    recentMessages = recentMessages.slice(1);
    droppedOrphans += 1;
  }

  const summarizedCount = olderCount + droppedOrphans;
  if (summarizedCount === 0) {
    return {
      messages,
      compacted: false,
      compactedMessageCount: 0,
      remainingMessageCount: nonSystemMessages.length
    };
  }

  const summaryMessage: ChatMessage = {
    role: "system",
    content: [
      MODEL_SUMMARY_PREFIX,
      `Summarized at: ${(options.now ?? new Date()).toISOString()}`,
      `Summarized messages: ${summarizedCount}`,
      "",
      summary.trim()
    ].join("\n")
  };

  return {
    messages: [...systemMessages, summaryMessage, ...recentMessages],
    compacted: true,
    compactedMessageCount: summarizedCount,
    remainingMessageCount: recentMessages.length
  };
}

/** Minimal shape of a session needed to re-anchor task-run message indexes after compaction. */
export type RemappableTaskRunSession = {
  messages: ChatMessage[];
  taskRuns?: Array<{ userMessageIndex: number; promptPreview: string }>;
};

/**
 * Re-anchor each task run's `userMessageIndex` after the transcript has been compacted or
 * summarized, given the pre-compaction `previousMessages`. Without this, manual compact/summarize
 * leave the indexes pointing at whatever now sits at the old slot — mis-anchoring run cards, making
 * retry delete the wrong runs, and skewing the plan/completion scan range. The in-run auto-summary
 * path already remaps by object identity; this is the shared equivalent for the paths that did not.
 *
 * Resolution order per run: (1) object identity — summary compaction keeps recent messages by
 * reference; (2) prompt-preview content match — deterministic compaction rebuilds recent messages as
 * new objects but keeps their text, so the anchor is still findable; (3) fall back to the
 * summary/compaction system message for a run whose user turn was folded entirely into the summary,
 * matching the auto-summary path so downstream retry (which re-validates role+content) rejects it
 * cleanly instead of acting on an unrelated message.
 */
export function remapTaskRunUserMessageIndexes(session: RemappableTaskRunSession, previousMessages: readonly ChatMessage[]): void {
  const runs = session.taskRuns;
  if (!runs?.length) {
    return;
  }
  const fallbackIndex = Math.max(
    0,
    session.messages.findIndex((message) => isModelSummaryMessage(message) || isCompactionMessage(message))
  );
  for (const run of runs) {
    const previous = previousMessages[run.userMessageIndex];
    let index = previous ? session.messages.indexOf(previous) : -1;
    if (index < 0) {
      index = session.messages.findIndex(
        (message) => message.role === "user" && taskRunMatchesUserMessage(run.promptPreview, message.content)
      );
    }
    run.userMessageIndex = index >= 0 ? index : fallbackIndex;
  }
}

function normalizePromptPreview(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Mirror of SessionStore's task-run/message matcher: a preview ending in "..." matches a message
 * whose normalized text starts with the (sufficiently long) prefix; otherwise it must match in full.
 */
function taskRunMatchesUserMessage(promptPreview: string, content: ChatMessage["content"]) {
  const preview = normalizePromptPreview(promptPreview);
  if (!preview) {
    return false;
  }
  const messageText = normalizePromptPreview(chatContentToText(content));
  if (preview.endsWith("...")) {
    const prefix = preview.slice(0, -3).trimEnd();
    return prefix.length >= 12 && messageText.startsWith(prefix);
  }
  return messageText === preview;
}

export function isModelSummaryMessage(message: ChatMessage) {
  return message.role === "system" && chatContentToText(message.content).startsWith(MODEL_SUMMARY_PREFIX);
}

export function isCompactionMessage(message: ChatMessage) {
  return message.role === "system" && chatContentToText(message.content).startsWith(COMPACTION_PREFIX);
}

function buildCompactionSummary(messages: ChatMessage[], entryCharacterLimit: number) {
  if (messages.length === 0) {
    return "- No older transcript content.";
  }

  return messages.map((message) => `- ${messageLabel(message)}: ${summarizeContent(message, entryCharacterLimit)}`).join("\n");
}

function summarizeContent(message: ChatMessage, entryCharacterLimit: number) {
  const content = transcriptContent(message).replace(/\s+/g, " ").trim();
  if (!content) {
    return "(empty)";
  }
  if (message.role === "tool") {
    return summarizeToolResultContent(message.name, content, entryCharacterLimit);
  }
  if (content.length <= entryCharacterLimit) {
    return content;
  }
  return `${content.slice(0, Math.max(0, entryCharacterLimit - 1)).trimEnd()}...`;
}

/**
 * Retention policy for older tool results, by tool. Re-derivable output collapses to a stub;
 * succeeded commands keep just their outcome head; failures keep the tail, where the error text
 * lives, on a larger budget — the freed stub space is what pays for it.
 */
function summarizeToolResultContent(toolName: string | undefined, content: string, entryCharacterLimit: number) {
  if (toolName && REDERIVABLE_RESULT_TOOLS.has(toolName)) {
    const headLimit = Math.min(REDERIVABLE_RESULT_HEAD_CHARS, entryCharacterLimit);
    if (content.length <= headLimit) {
      return content;
    }
    return `${content.slice(0, headLimit).trimEnd()}... [older output dropped: stale; re-run ${toolName} for current data]`;
  }

  const outcome = toolResultOutcome(toolName, content);
  if (outcome === "succeeded") {
    const headLimit = Math.min(SUCCEEDED_RESULT_HEAD_CHARS, entryCharacterLimit);
    if (content.length <= headLimit) {
      return content;
    }
    return `${content.slice(0, headLimit).trimEnd()}... [older output trimmed: ${toolName} succeeded]`;
  }
  if (outcome === "failed") {
    const headLimit = Math.min(SUCCEEDED_RESULT_HEAD_CHARS, entryCharacterLimit);
    const tailLimit = Math.max(entryCharacterLimit - headLimit, FAILED_RESULT_TAIL_CHARS);
    if (content.length <= headLimit + tailLimit) {
      return content;
    }
    return `${content.slice(0, headLimit).trimEnd()} ...[middle trimmed; failure detail below]... ${content.slice(-tailLimit).trimStart()}`;
  }

  if (content.length <= entryCharacterLimit) {
    return content;
  }
  return `${content.slice(0, Math.max(0, entryCharacterLimit - 1)).trimEnd()}...`;
}

/**
 * Classifies a run/browser_task result as succeeded or failed from markers in the result text
 * ("exitCode: N", "timedOut: true", `"success": false`). Anything unrecognizable returns
 * "unknown" and gets the default truncation — misclassifying a failure as a success would
 * silently discard the error the agent may still need.
 */
function toolResultOutcome(toolName: string | undefined, content: string): "succeeded" | "failed" | "unknown" {
  if (toolName === "run") {
    if (/\btimedOut: true\b/.test(content) || /\bsignal: \w+/.test(content)) {
      return "failed";
    }
    const exitCode = /\bexitCode: (-?\d+)\b/.exec(content);
    if (exitCode) {
      return exitCode[1] === "0" ? "succeeded" : "failed";
    }
    return "unknown";
  }
  if (toolName === "browser_task") {
    if (/"success"\s*:\s*true\b/.test(content)) {
      return "succeeded";
    }
    if (/"success"\s*:\s*false\b/.test(content)) {
      return "failed";
    }
    return "unknown";
  }
  return "unknown";
}

function messageLabel(message: ChatMessage) {
  if (isCompactionMessage(message) || isModelSummaryMessage(message)) {
    return "Prior compacted context";
  }
  if (message.role === "assistant") {
    return "Agent";
  }
  if (message.role === "tool") {
    return message.name ? `Tool ${message.name}` : "Tool";
  }
  return "User";
}

function latestUserIndex(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && isPinnableUserMessage(message)) {
      return index;
    }
  }
  return -1;
}

function isPinnableUserMessage(message: ChatMessage) {
  const content = chatContentToText(message.content).trimStart();
  return !content.startsWith("Local tool result");
}

function toPlainTranscriptMessage(message: ChatMessage, entryCharacterLimit?: number, preserveUserContent = false): ChatMessage {
  if (preserveUserContent && message.role === "user") {
    return toPinnedUserMessage(message, entryCharacterLimit);
  }

  const content = truncateTranscriptContent(transcriptContent(message), entryCharacterLimit);
  if (message.role === "tool") {
    return {
      role: "user",
      content
    };
  }

  if (message.toolCalls?.length) {
    return {
      role: message.role,
      content
    };
  }

  return {
    role: message.role,
    content
  };
}

function toPinnedUserMessage(message: ChatMessage, entryCharacterLimit?: number): ChatMessage {
  return {
    role: "user",
    content: truncateChatContent(message.content, entryCharacterLimit)
  };
}

function truncateChatContent(content: ChatContent, entryCharacterLimit: number | undefined): ChatContent {
  if (typeof content === "string") {
    return truncateTranscriptContent(content, entryCharacterLimit);
  }
  if (!entryCharacterLimit) {
    return content.map((part) => (part.type === "text" ? { ...part } : { ...part, image_url: { ...part.image_url } }));
  }

  let remainingTextCharacters = entryCharacterLimit;
  return content
    .map((part) => {
      if (part.type === "image_url") {
        return { ...part, image_url: { ...part.image_url } };
      }
      if (remainingTextCharacters <= 0) {
        return undefined;
      }
      if (part.text.length <= remainingTextCharacters) {
        remainingTextCharacters -= part.text.length;
        return { ...part };
      }
      const text = truncateTranscriptContent(part.text, remainingTextCharacters);
      remainingTextCharacters = 0;
      return text ? { ...part, text } : undefined;
    })
    .filter((part): part is ChatContentPart => Boolean(part));
}

function transcriptContent(message: ChatMessage) {
  if (message.role === "tool") {
    const label = message.name ? ` from ${message.name}` : "";
    const id = message.toolCallId ? ` (${message.toolCallId})` : "";
    return `Local tool result${label}${id}:\n${chatContentToText(message.content)}`;
  }

  if (!message.toolCalls?.length) {
    return chatContentToText(message.content);
  }

  const content = chatContentToText(message.content).trim();
  const toolRequests = message.toolCalls.map((call) => `- ${call.name}: ${formatToolArguments(call.arguments)}`).join("\n");
  return [content, `Local tool request${message.toolCalls.length === 1 ? "" : "s"}:\n${toolRequests}`].filter(Boolean).join("\n\n");
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

function truncateTranscriptContent(content: string, entryCharacterLimit: number | undefined) {
  if (!entryCharacterLimit || content.length <= entryCharacterLimit) {
    return content;
  }
  if (entryCharacterLimit <= 3) {
    return ".".repeat(Math.max(0, entryCharacterLimit));
  }
  return `${content.slice(0, Math.max(0, entryCharacterLimit - 3)).trimEnd()}...`;
}
