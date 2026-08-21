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
    }
  | {
      // Reading the machine's screen, which shows every running app rather than only the workspace.
      // Kept separate from "browser" (Arivu's own isolated browser) and from "shell" (which would
      // file the capture under run_command) so the capability policy can govern it on its own terms.
      type: "screen";
      action: string;
      target: string;
      /** Where the capture lands, so the approval and the audit name the resulting file. */
      output?: string;
      destructive?: boolean;
    };
