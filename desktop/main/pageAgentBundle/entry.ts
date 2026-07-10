import { PageAgentCore, tool } from "@page-agent/core";
import { PageController } from "@page-agent/page-controller";
import { Panel } from "@page-agent/ui";

declare global {
  interface Window {
    __ArivuPageAgentLib?: {
      PageAgentCore: typeof PageAgentCore;
      PageController: typeof PageController;
      Panel: typeof Panel;
      tool: typeof tool;
    };
  }
}

window.__ArivuPageAgentLib = { PageAgentCore, PageController, Panel, tool };
