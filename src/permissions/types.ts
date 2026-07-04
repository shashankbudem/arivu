export type TrustMode = "ask" | "readonly" | "trusted";
export type BrowserTargetClass = "background" | "visible" | "local" | "file" | "public";

export type ApprovalAction =
  | {
      type: "read";
      summary: string;
      path?: string;
      query?: string;
      destructive?: boolean;
    }
  | {
      type: "write";
      summary: string;
      path?: string;
      mode?: "create" | "replace";
      paths?: string[];
      diff?: string;
      original?: string;
      content?: string;
      changeSummary?: string;
      reviewReason?: string;
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
      servers?: string[];
      tool: string;
      arguments?: unknown;
      destructive?: boolean;
    }
  | {
      type: "network";
      summary: string;
      destination?: string;
      query?: string;
      destructive?: boolean;
    }
  | {
      type: "browser";
      action: string;
      target: string;
      url?: string;
      mode?: "visible" | "background";
      targetClasses?: BrowserTargetClass[];
      destructive?: boolean;
    };
