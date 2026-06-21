import type { TrustMode } from "../permissions/types.js";
import type { ChatContent } from "./content.js";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type ChatMessage = {
  role: ChatRole;
  content: ChatContent;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
};

export type ToolSchema = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools: ToolSchema[];
};

export type ChatResponse = {
  message: ChatMessage;
};

export type ChatStreamEvent =
  | {
      type: "content_delta";
      delta: string;
    }
  | {
      type: "tool_call_delta";
      index: number;
      id: string;
      name: string;
      argumentsDelta: string;
      argumentsText: string;
    };

export type ChatStreamHandler = (event: ChatStreamEvent) => void | Promise<void>;

export interface ChatClient {
  complete(request: ChatRequest): Promise<ChatResponse>;
  stream?(request: ChatRequest, onEvent?: ChatStreamHandler): Promise<ChatResponse>;
}

export type AgentRunEvent =
  | {
      type: "assistant_delta";
      delta: string;
    }
  | {
      type: "tool_call_delta";
      toolCallId: string;
      index: number;
      name: string;
      argumentsDelta: string;
      argumentsText: string;
    }
  | {
      type: "tool_call";
      call: ToolCall;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      result: string;
    };

export type AgentRunOptions = {
  onEvent?: (event: AgentRunEvent) => void | Promise<void>;
  skillNames?: string[];
  promptAlreadyInSession?: boolean;
};

export type AgentLoopStatus = "running" | "stopping" | "completed" | "stopped" | "blocked" | "failed" | "max_iterations";

export type AgentLoopState = {
  status: AgentLoopStatus;
  goal: string;
  iteration: number;
  maxIterations: number;
  startedAt: string;
  updatedAt: string;
  stopRequested?: boolean;
  lastDecision?: "continue" | "done" | "blocked";
};

export type AgentSession = {
  id: string;
  cwd: string;
  projectRoot?: string | null;
  trustMode: TrustMode;
  model?: string;
  baseUrl?: string;
  modelMode?: "manual" | "auto";
  selectedModel?: string;
  selectedProviderId?: string;
  selectedProviderName?: string;
  modelSelectionReason?: string;
  agentLoop?: AgentLoopState;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
};
