/**
 * `ask` and `trusted` are retained as stable persisted values for Manual and Auto.
 * `bypass` is intentionally explicit: it never opens an approval prompt.
 */
export type TrustMode = "ask" | "readonly" | "trusted" | "bypass";
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
      commandMode?: "shell" | "argv";
      cwd?: string;
      destructive?: boolean;
      risk?: "low" | "medium" | "high";
      analysisSummary?: string;
      analysisReasons?: string[];
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
