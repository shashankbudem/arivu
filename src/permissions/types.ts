export type TrustMode = "ask" | "readonly" | "trusted";

export type ApprovalAction =
  | {
      type: "write";
      summary: string;
      path?: string;
      mode?: "create" | "replace";
      diff?: string;
      original?: string;
      content?: string;
      destructive?: boolean;
    }
  | {
      type: "shell";
      command: string;
      cwd?: string;
      destructive?: boolean;
    }
  | {
      type: "mcp";
      server: string;
      tool: string;
      arguments?: unknown;
      destructive?: boolean;
    }
  | {
      type: "browser";
      action: string;
      target: string;
      mode?: "visible" | "background";
      destructive?: boolean;
    };
