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
    }
  | {
      // Reading the machine's screen or driving its mouse and keyboard, which reaches every running
      // app rather than only the workspace. Kept separate from "browser" (Arivu's own isolated
      // browser) and from "shell" (which would file it under run_command) so the capability policy
      // can govern it on its own terms.
      type: "screen";
      /**
       * A closed set rather than a free string: the prompt copy for reading the screen and for
       * injecting input has to differ, and an exhaustive switch is what keeps a new action from
       * silently inheriting the wrong wording.
       */
      action: "capture" | "click" | "type" | "key" | "scroll";
      target: string;
      /** Where a capture lands, so the approval and the audit name the resulting file. */
      output?: string;
      destructive?: boolean;
      /**
       * Risk analysis from the calling tool, carried the same way the "shell" variant carries it.
       * Without these the prompt can state what will happen but not why it was flagged, which is
       * the entire value of screening typed text and key combinations before the user decides.
       */
      risk?: "low" | "medium" | "high";
      analysisSummary?: string;
      analysisReasons?: string[];
    };
