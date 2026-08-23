export type NativeEntryKind = "user" | "assistant" | "system" | "error" | "command";

export type NativeTranscriptEntry = {
  kind: NativeEntryKind;
  text: string;
  time?: string;
};

export type NativeActivityPhase = "running" | "completed" | "failed" | "system";

export type NativeShellOutputStream = "stdout" | "stderr";

export type NativeActivityItem = {
  id: string;
  phase: NativeActivityPhase;
  name: string;
  detail?: string;
};

export type NativeCommandSpec = {
  command: string;
  usage: string;
  title: string;
  description: string;
  aliases?: string[];
  takes_args?: boolean;
  args_required?: boolean;
};

export type NativeInitData = {
  project_name: string;
  cwd: string;
  root: string;
  branch?: string;
  dirty: boolean;
  model: string;
  trust: string;
  session_id?: string;
  context_used?: number;
  context_total?: number;
  transcript: NativeTranscriptEntry[];
  activity: NativeActivityItem[];
  commands: NativeCommandSpec[];
};

export type NativeElicitationQuestion = {
  id: string;
  type: "select" | "multiselect" | "text" | "url" | "number" | "images" | "files";
  label: string;
  description?: string;
  required?: boolean;
  options?: Array<{ value: string; label?: string; description?: string }>;
  allow_other?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  min_count?: number;
  max_count?: number;
};

export type NativeElicitationAnswer = {
  id: string;
  value?: string | string[] | number;
  skipped?: boolean;
};

export type NativeServerEvent =
  | { type: "init" | "reset"; data: NativeInitData }
  | { type: "commit"; entry: NativeTranscriptEntry }
  | { type: "run_started"; status?: string }
  | { type: "assistant_delta"; delta: string }
  | { type: "shell_started"; command: string }
  | { type: "shell_output"; stream: NativeShellOutputStream; delta: string }
  | {
      type: "shell_completed";
      command: string;
      output: string;
      exit_code?: number | null;
      signal?: string | null;
      elapsed_ms: number;
      stopped?: boolean;
      output_truncated?: boolean;
    }
  | { type: "shell_failed"; command: string; message: string; elapsed_ms: number }
  | { type: "activity"; item: NativeActivityItem }
  | {
      type: "run_completed";
      output?: string;
      session_id?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    }
  | { type: "run_stopped"; message?: string }
  | { type: "run_failed"; message: string }
  | { type: "status"; message: string; busy?: boolean; queue_len?: number; context_used?: number }
  | { type: "approval"; id: string; title?: string; message: string; risky?: boolean }
  | { type: "elicitation"; id: string; title?: string; reason?: string; questions: NativeElicitationQuestion[] }
  | { type: "modal"; title: string; body: string }
  | {
      type: "session_picker";
      title?: string;
      sessions: Array<{ id: string; label: string; description?: string }>;
    }
  | {
      type: "model_picker";
      title?: string;
      current_model: string;
      endpoint_label?: string;
      models: Array<{ id: string; label: string; description?: string }>;
      notice?: string;
    }
  | { type: "toggle_activity" | "clear" | "quit" };

export type NativeClientEvent =
  | { type: "hello"; token: string }
  | { type: "submit"; value: string }
  | { type: "stop" | "quit" }
  | { type: "approval_response"; id: string; approved: boolean }
  | { type: "elicitation_response"; id: string; status: "answered" | "declined"; answers?: NativeElicitationAnswer[] }
  | { type: "resume_session"; id: string }
  | { type: "select_model"; id: string };

/** Strictly validates untrusted NDJSON received from the native process. */
export function parseNativeClientEvent(value: unknown): NativeClientEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string") return undefined;
  if (event.type === "hello") return typeof event.token === "string" ? { type: "hello", token: event.token } : undefined;
  if (event.type === "submit") return typeof event.value === "string" ? { type: "submit", value: event.value } : undefined;
  if (event.type === "stop" || event.type === "quit") return { type: event.type };
  if (event.type === "approval_response")
    return typeof event.id === "string" && typeof event.approved === "boolean"
      ? { type: "approval_response", id: event.id, approved: event.approved }
      : undefined;
  if (event.type === "resume_session" || event.type === "select_model")
    return typeof event.id === "string" ? { type: event.type, id: event.id } : undefined;
  if (event.type === "elicitation_response") {
    if (typeof event.id !== "string" || (event.status !== "answered" && event.status !== "declined")) return undefined;
    if (event.answers === undefined) return { type: "elicitation_response", id: event.id, status: event.status };
    if (!Array.isArray(event.answers)) return undefined;
    const answers: NativeElicitationAnswer[] = [];
    for (const answer of event.answers) {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) return undefined;
      const item = answer as Record<string, unknown>;
      if (typeof item.id !== "string" || (item.skipped !== undefined && typeof item.skipped !== "boolean")) return undefined;
      const validValue =
        item.value === undefined ||
        typeof item.value === "string" ||
        typeof item.value === "number" ||
        (Array.isArray(item.value) && item.value.every((entry) => typeof entry === "string"));
      if (!validValue) return undefined;
      answers.push({
        id: item.id,
        ...(item.value !== undefined ? { value: item.value as NativeElicitationAnswer["value"] } : {}),
        ...(item.skipped !== undefined ? { skipped: item.skipped as boolean } : {})
      });
    }
    return { type: "elicitation_response", id: event.id, status: event.status, answers };
  }
  return undefined;
}
