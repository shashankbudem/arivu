import { PageAgentCore, tool } from "@page-agent/core";
import { PageController } from "@page-agent/page-controller";
import * as z from "zod/v4";

declare global {
  interface Window {
    __ArivuPageAgentLib?: {
      PageAgentCore: typeof PageAgentCore;
      PageController: typeof PageController;
      tool: typeof tool;
      // Needed to construct the search_web customTools entry (browserTaskSupervisor.ts's
      // injectedTaskScript) via PageAgentCore's own documented customTools/tool() extension
      // point -- inputSchema requires a real zod schema, not a plain JSON schema.
      z: typeof z;
    };
  }
}

// No Panel export: the on-page activity indicator is now the supervisor-driven presence chip
// (pageAgentInPageSnippets.ts), upserted into the tab's top frame directly rather than built
// from this per-frame agent bundle -- see browserTaskSupervisor.ts's updatePresenceChip.
window.__ArivuPageAgentLib = { PageAgentCore, PageController, tool, z };
