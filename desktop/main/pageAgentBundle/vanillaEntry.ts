// Separate bundle entry for the vanilla page-agent BENCHMARK baseline (not part of the Arivu
// product build). Identical to entry.ts EXCEPT it also exposes `z` (zod/v4), needed to construct
// the one added custom tool (navigate) via PageAgentCore's own documented `customTools` / `tool()`
// extension point -- the library's own mechanism for adding capabilities, not a hack.
import { PageAgentCore, tool } from "@page-agent/core";
import { PageController } from "@page-agent/page-controller";
import { Panel } from "@page-agent/ui";
import * as z from "zod/v4";

declare global {
  interface Window {
    __VanillaPageAgentLib?: {
      PageAgentCore: typeof PageAgentCore;
      PageController: typeof PageController;
      Panel: typeof Panel;
      tool: typeof tool;
      z: typeof z;
    };
  }
}

window.__VanillaPageAgentLib = { PageAgentCore, PageController, Panel, tool, z };
