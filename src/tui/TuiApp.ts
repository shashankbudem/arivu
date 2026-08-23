import type { AgentSession } from "../agent/types.js";
import type { AppConfig } from "../config.js";
import { NativeTuiBackend } from "./NativeTuiBackend.js";

export * from "./commands.js";

type TuiAppOptions = {
  config: AppConfig;
  cwd: string;
  session?: AgentSession;
};

/**
 * Starts Arivu's native Ratatui interface.
 *
 * The Rust process owns terminal input and rendering. NativeTuiBackend keeps
 * Arivu's existing TypeScript model, tool, browser, approval, session, and
 * context runtime behind a typed loopback protocol.
 */
export class TuiApp {
  constructor(private readonly options: TuiAppOptions) {}

  async run() {
    await new NativeTuiBackend(this.options).run();
  }
}
