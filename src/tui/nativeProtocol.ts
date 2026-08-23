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
  | { type: "resume_session"; id: string }
  | { type: "select_model"; id: string };
