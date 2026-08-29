import { chatContentToText } from "../agent/content.js";
import type { AgentSession } from "../agent/types.js";
import type { NativeActivityItem, NativeTranscriptEntry } from "./nativeProtocol.js";

export const MAX_NATIVE_ACTIVITY_DETAIL = 40_000;

export function transcriptForSession(session?: AgentSession): NativeTranscriptEntry[] {
  const transcript: NativeTranscriptEntry[] = [];
  for (const message of session?.messages ?? []) {
    const text = chatContentToText(message.content);
    if (message.role === "user") {
      if (text.trim()) {
        transcript.push({ kind: "user", text, time: message.createdAt });
      }
      continue;
    }
    if (message.role === "assistant") {
      if (text.trim()) {
        transcript.push({ kind: "assistant", text, time: message.createdAt });
      }
      for (const call of message.toolCalls ?? []) {
        const detail = compactInlineActivityDetail(prettyJson(call.arguments));
        transcript.push({
          kind: "system",
          text: detail ? `◆ Running ${call.name}\n  ${detail}` : `◆ Running ${call.name}`,
          time: message.createdAt
        });
      }
      continue;
    }
    if (message.role === "tool") {
      const phase = inferToolResultPhase(text);
      const name = message.name ?? "tool";
      const detail = compactInlineActivityDetail(text);
      transcript.push({
        kind: phase === "failed" ? "error" : "system",
        text:
          phase === "failed"
            ? detail
              ? `Failed ${name}\n  ${detail}`
              : `Failed ${name}`
            : detail
              ? `✓ Completed ${name}\n  ${detail}`
              : `✓ Completed ${name}`,
        time: message.createdAt
      });
    }
  }
  return transcript;
}

export function activityForSession(session?: AgentSession): NativeActivityItem[] {
  type SavedActivity = {
    id: string;
    name: string;
    input?: string;
    result?: string;
    phase: NativeActivityItem["phase"];
  };
  const byId = new Map<string, SavedActivity>();
  const order: string[] = [];

  const findOrCreate = (id: string, name: string) => {
    const existing = byId.get(id);
    if (existing) {
      return existing;
    }
    const created: SavedActivity = { id, name, phase: "system" };
    byId.set(id, created);
    order.push(id);
    return created;
  };

  for (const message of session?.messages ?? []) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        const item = findOrCreate(call.id, call.name);
        item.name = call.name;
        item.input = prettyJson(call.arguments);
      }
    }
    if (message.role === "tool") {
      const id = message.toolCallId ?? `${message.name ?? "tool"}-${order.length}`;
      const result = chatContentToText(message.content);
      const item = findOrCreate(id, message.name ?? "tool");
      item.name = message.name ?? item.name;
      item.result = result;
      item.phase = inferToolResultPhase(result);
    }
  }

  return order.flatMap((id) => {
    const item = byId.get(id);
    if (!item) {
      return [];
    }
    return [
      {
        id: item.id,
        phase: item.phase,
        name: item.name,
        detail: truncateNativeActivityDetail(formatActivityDetail({ input: item.input, result: item.result }))
      }
    ];
  });
}

export function inferToolResultPhase(result: string): NativeActivityItem["phase"] {
  const normalized = result.trim();
  const failed =
    /^(?:(?:tool|browser|command|request|operation|task)\s+)?(?:error|failed|failure|timed out|denied|refused)\b/i.test(normalized) ||
    /\b(?:command|tool|request|operation|task|execution)\s+(?:failed|timed out|was denied|was refused)\b/i.test(normalized) ||
    /\bexit(?:ed)?(?: with)? (?:code|status) [1-9]\d*\b/i.test(normalized) ||
    /"(?:success|ok)"\s*:\s*false\b/i.test(normalized) ||
    /"error"\s*:\s*(?!"(?:\s*)"|null\b|false\b)/i.test(normalized);
  return failed ? "failed" : "completed";
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatActivityDetail({ input, progress, result }: { input?: string; progress?: string; result?: string }) {
  return [
    input?.trim() ? `Arguments\n${input.trim()}` : undefined,
    progress?.trim() ? `Latest progress\n${progress.trim()}` : undefined,
    result?.trim() ? `Result\n${result.trim()}` : undefined
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

export function truncateNativeActivityDetail(value: string, max = MAX_NATIVE_ACTIVITY_DETAIL) {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}

function compactInlineActivityDetail(value: string, max = 360) {
  const compact = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
