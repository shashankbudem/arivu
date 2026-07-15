import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";
import { z } from "zod";
import type { ApprovalManager } from "../permissions/ApprovalManager.js";
import { analyzeArgvCommand, analyzeShellCommand } from "../permissions/destructive.js";
import { normalizeWorkspaceScopePolicyRules, type WorkspaceScopePolicyRules } from "../permissions/scopePolicy.js";
import type { AppConfig } from "../config.js";
import { resolveCommandExecutionProfile } from "../execution/profile.js";
import { discoverSkills, formatSkillList, readSkill } from "../agent/skills.js";
import type { ToolSchema } from "../agent/types.js";
import { ChangeCheckpoint } from "./changeCheckpoint.js";
import { reviewForFileWrite, reviewForPatch } from "./directEditReview.js";
import { FileStateTracker } from "./fileState.js";
import { callMcpTool, listMcpTools } from "./mcp.js";
import { applyUnifiedDiff, changedPathsFromDiff, summarizePatch } from "./patch.js";
import { assertRealPathInsideWorkspace, resolveSafeWorkspacePath } from "./pathSafety.js";
import { formatWebSearchResults, searchWeb } from "./webSearch.js";
import {
  formatBrowserToolResult,
  isLocalBrowserUrl,
  normalizeBrowserUrl,
  type BrowserMode,
  type BrowserTaskModelConfig,
  type BrowserToolController,
  type BrowserToolResult
} from "./browserControl.js";

type ToolContext = {
  workspaceRoot: string;
  approvals: ApprovalManager;
  tavilyApiKey?: string;
  mcpServers?: AppConfig["mcpServers"];
  scopePolicyRules?: WorkspaceScopePolicyRules;
  browser?: BrowserToolController;
  browserTaskModel?: BrowserTaskModelConfig;
  onBrowserTaskProgress?: (progress: { stepIndex: number; summary: string }) => void;
  directEditReview?: boolean;
  /** Aborts long-running commands and searches when the run is stopped. */
  signal?: AbortSignal;
  /** Captures pre-modification file state so a run's direct edits can be undone. */
  checkpoint?: ChangeCheckpoint;
};

type ToolDefinition = {
  schema: ToolSchema;
  execute(args: unknown): Promise<string>;
};

const MAX_TOOL_SEARCH_OUTPUT = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MIN_COMMAND_TIMEOUT_MS = 1_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
const DEFAULT_READ_LINE_LIMIT = 2_000;
const MAX_READ_LINE_LIMIT = 5_000;
const MAX_READ_OUTPUT_BYTES = 40_000;
const MAX_READ_LINE_LENGTH = 2_000;
const MAX_READABLE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_RUN_OUTPUT_CHARS = 30_000;
const DEFAULT_SEARCH_MAX_RESULTS = 200;
const MAX_SEARCH_MAX_RESULTS = 2_000;
const MAX_SEARCH_CONTEXT_LINES = 10;
const MAX_JS_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_JS_SEARCH_FILES = 5_000;
const MIN_DELEGATED_BROWSER_TASK_TIMEOUT_MS = 600_000;

// Low-level manual browser tools are temporarily disabled so the agent is steered toward the
// higher-level browser_task tool instead of driving snapshot/click/type rounds itself. Flip this
// back to true (and re-check the browser guidance in Agent.ts) to restore the manual toolset.
const MANUAL_BROWSER_TOOLS_ENABLED = false;
const MANUAL_BROWSER_TOOL_NAMES = [
  "browser_snapshot",
  "browser_click",
  "browser_click_at",
  "browser_type",
  "browser_scroll",
  "browser_select_option"
] as const;

export function createToolRegistry(context: ToolContext) {
  const state = new FileStateTracker();
  const tools = new Map<string, ToolDefinition>();
  const scopePolicyRules = normalizeWorkspaceScopePolicyRules(context.scopePolicyRules);
  const scopedMcpServers = mcpServersForScope(context.mcpServers, scopePolicyRules);
  const directEditReview = context.directEditReview ?? true;

  const register = (tool: ToolDefinition) => tools.set(tool.schema.name, tool);

  register({
    schema: {
      name: "list",
      description: "List files and directories inside the workspace.",
      parameters: objectSchema({
        path: { type: "string", description: "Workspace-relative path to list." }
      })
    },
    async execute(args) {
      const parsed = z.object({ path: z.string().default(".") }).parse(args);
      const target = await resolveSafeWorkspacePath(context.workspaceRoot, parsed.path);
      await context.approvals.require({ type: "read", summary: "list workspace path", path: parsed.path });
      const entries = await readdir(target, { withFileTypes: true });
      return entries
        .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
        .sort()
        .join("\n");
    }
  });

  register({
    schema: {
      name: "read",
      description:
        "Read a text file inside the workspace. Output is line-numbered. Use offset and limit to page through files larger than a single read.",
      parameters: objectSchema({
        path: { type: "string", description: "Workspace-relative file path." },
        offset: { type: "number", description: "1-based line number to start reading from. Defaults to 1." },
        limit: { type: "number", description: "Maximum number of lines to return, from 1 to 5000. Defaults to 2000." }
      })
    },
    async execute(args) {
      const parsed = z
        .object({
          path: z.string(),
          offset: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(MAX_READ_LINE_LIMIT).optional()
        })
        .parse(args);
      const target = await resolveSafeWorkspacePath(context.workspaceRoot, parsed.path);
      await context.approvals.require({ type: "read", summary: "read file", path: parsed.path });
      const content = await readFileLines(target, parsed.offset ?? 1, parsed.limit ?? DEFAULT_READ_LINE_LIMIT);
      // Only mark the file safe to overwrite when the agent read all of it from the top; a paged or
      // truncated read must not satisfy the read-before-write guard on the whole file.
      if (content.readEntireFile) {
        await state.remember(target);
      }
      return content.text;
    }
  });

  register({
    schema: {
      name: "edit",
      description:
        "Replace an exact string in an existing workspace file. Fails unless oldString matches exactly once, unless replaceAll is set. Read the file first.",
      parameters: objectSchema({
        path: { type: "string", description: "Workspace-relative file path." },
        oldString: { type: "string", description: "Exact text to replace. Include enough surrounding context to be unique." },
        newString: { type: "string", description: "Replacement text. Must differ from oldString." },
        replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring a single unique match." }
      })
    },
    async execute(args) {
      const parsed = z
        .object({
          path: z.string(),
          oldString: z.string(),
          newString: z.string(),
          replaceAll: z.boolean().default(false)
        })
        .parse(args);
      if (parsed.oldString === parsed.newString) {
        throw new Error("oldString and newString are identical; nothing to change.");
      }
      const target = await resolveSafeWorkspacePath(context.workspaceRoot, parsed.path);
      if (!(await exists(target))) {
        throw new Error(`Cannot edit ${parsed.path}; file does not exist. Use write_file to create it.`);
      }
      await state.assertUnchanged(target);
      const original = await readFile(target, "utf8");
      const occurrences = countOccurrences(original, parsed.oldString);
      if (occurrences === 0) {
        throw new Error(`oldString not found in ${parsed.path}.`);
      }
      if (occurrences > 1 && !parsed.replaceAll) {
        throw new Error(`oldString matches ${occurrences} times in ${parsed.path}; add more context or set replaceAll.`);
      }
      const updated = parsed.replaceAll
        ? original.split(parsed.oldString).join(parsed.newString)
        : original.replace(parsed.oldString, parsed.newString);
      const review = directEditReview ? reviewForFileWrite(updated) : { required: false, summary: "", reason: undefined };
      await context.approvals.require({
        type: "write",
        summary: `edit ${parsed.path}`,
        path: parsed.path,
        mode: "replace",
        original,
        content: updated,
        destructive: review.required,
        changeSummary: review.summary,
        reviewReason: review.reason
      });
      await context.checkpoint?.record(target);
      await writeFile(target, updated, "utf8");
      await state.remember(target);
      const replacedLabel = parsed.replaceAll ? `${occurrences} occurrence${occurrences === 1 ? "" : "s"}` : "1 occurrence";
      return `Edited ${parsed.path} (${replacedLabel}).`;
    }
  });

  register({
    schema: {
      name: "search",
      description:
        "Search workspace files for a regular expression. Uses ripgrep when available and falls back to a built-in scanner. Supports context lines, a glob file filter, and a result cap.",
      parameters: objectSchema({
        query: { type: "string", description: "Search pattern (regular expression)." },
        path: { type: "string", description: "Optional workspace-relative path." },
        glob: { type: "string", description: "Optional glob to include only matching files, e.g. *.ts or src/**/*.tsx." },
        contextLines: { type: "number", description: "Lines of context to show before and after each match, from 0 to 10." },
        maxResults: { type: "number", description: "Maximum matching lines to return, from 1 to 2000. Defaults to 200." },
        ignoreCase: { type: "boolean", description: "Case-insensitive search." }
      })
    },
    async execute(args) {
      const parsed = z
        .object({
          query: z.string().min(1),
          path: z.string().default("."),
          glob: z.string().trim().min(1).optional(),
          contextLines: z.number().int().min(0).max(MAX_SEARCH_CONTEXT_LINES).default(0),
          maxResults: z.number().int().min(1).max(MAX_SEARCH_MAX_RESULTS).default(DEFAULT_SEARCH_MAX_RESULTS),
          ignoreCase: z.boolean().default(false)
        })
        .parse(args);
      const target = await resolveSafeWorkspacePath(context.workspaceRoot, parsed.path);
      await context.approvals.require({ type: "read", summary: "search workspace", path: parsed.path, query: parsed.query });
      const output = await searchWorkspace(context, target, parsed);
      return truncateToolOutput(output || "No matches.", MAX_TOOL_SEARCH_OUTPUT);
    }
  });

  register({
    schema: {
      name: "web_search",
      description:
        "Search the public web for current information. Use concise, non-sensitive queries; do not include secrets, private code, or personal data.",
      parameters: objectSchema({
        query: { type: "string", description: "Public web search query." },
        maxResults: { type: "number", description: "Maximum results to return, from 1 to 10." }
      })
    },
    async execute(args) {
      const parsed = z
        .object({
          query: z.string().trim().min(1).max(300),
          maxResults: z.number().int().min(1).max(10).default(5)
        })
        .parse(args);
      await context.approvals.require({
        type: "network",
        summary: "web_search",
        destination: context.tavilyApiKey ? "https://api.tavily.com/search" : "https://www.bing.com/search",
        query: parsed.query,
        destructive: true
      });
      const results = await searchWeb(parsed.query, parsed.maxResults, { tavilyApiKey: context.tavilyApiKey });
      return formatWebSearchResults(parsed.query, results);
    }
  });

  const browser = context.browser;
  if (browser) {
    register({
      schema: {
        name: "browser_state",
        description:
          "Inspect Arivu browser state before answering questions about the current page, latest page, visible browser, tabs, or user-driven browser changes. Returns active mode, active visible tab id, visible tabs, background target, URLs, titles, loading state, and last snapshot/screenshot timestamps.",
        parameters: objectSchema({})
      },
      async execute() {
        const mode = browserActionMode(browser, undefined);
        await context.approvals.require({
          type: "browser",
          action: "state",
          target: "browser tabs",
          url: browserTargetUrl(browser, mode, undefined),
          mode,
          destructive: false
        });
        return formatBrowserToolResult("state", browser.getState() as unknown as BrowserToolResult);
      }
    });

    register({
      schema: {
        name: "browser_select_tab",
        description:
          "Select a visible Arivu browser tab by tabId. Use browser_state first to discover tab ids, then select the intended tab before browser_screenshot or browser_task.",
        parameters: objectSchema({
          tabId: { type: "string", description: "Visible browser tab id from browser_state." }
        })
      },
      async execute(args) {
        const parsed = z.object({ tabId: z.string().trim().min(1) }).parse(args);
        await context.approvals.require({
          type: "browser",
          action: "select tab",
          target: parsed.tabId,
          url: browserTargetUrl(browser, "visible", parsed.tabId),
          mode: "visible",
          destructive: false
        });
        return formatBrowserToolResult("select_tab", await browser.selectTab(parsed));
      }
    });

    register({
      schema: {
        name: "browser_open",
        description:
          "Open a URL or search text in Arivu's isolated browser. Defaults to hidden background mode; use visible mode only when the user explicitly asks to see a separate browser window. In visible mode, pass newTab to create a new browser tab or tabId to target an existing tab.",
        parameters: objectSchema({
          url: {
            type: "string",
            description:
              "URL or search text to open. localhost:5173 is normalized to http://localhost:5173; plain text becomes a Google search."
          },
          mode: {
            type: "string",
            enum: ["visible", "background"],
            description: "Optional browser mode. Defaults to hidden background mode."
          },
          tabId: { type: "string", description: "Optional visible browser tab id. Defaults to the active visible tab." },
          newTab: { type: "boolean", description: "Create and activate a new visible browser tab before opening the URL." }
        })
      },
      async execute(args) {
        const parsed = z
          .object({
            url: z.string().trim().min(1),
            mode: z.enum(["visible", "background"]).optional(),
            tabId: z.string().trim().min(1).optional(),
            newTab: z.boolean().default(false)
          })
          .parse(args);
        const url = await normalizeSafeBrowserToolUrl(context.workspaceRoot, normalizeBrowserUrl(parsed.url));
        const mode = parsed.mode ?? hiddenAgentBrowserMode();
        await context.approvals.require({
          type: "browser",
          action: "open",
          target: url,
          url,
          mode,
          destructive: !isLocalBrowserUrl(url)
        });
        return formatBrowserToolResult("open", await browser.open({ url, mode, tabId: parsed.tabId, newTab: parsed.newTab }));
      }
    });

    // Re-enabled after the oversized-visual-payload fix in browserController.inspectPage: the
    // element list is now serialized under a hard budget, so screenshot results can no longer
    // blow past the request auto-compaction threshold.
    register({
      schema: {
        name: "browser_screenshot",
        description:
          "Capture the current viewport of Arivu's isolated browser and save it to a PNG file. Also returns frame-aware visual metadata and CSS viewport coordinates. Defaults to the active browser mode.",
        parameters: objectSchema({
          mode: {
            type: "string",
            enum: ["visible", "background"],
            description: "Optional browser mode. Defaults to the active browser mode."
          },
          tabId: { type: "string", description: "Optional visible browser tab id. Defaults to the active visible tab." }
        })
      },
      async execute(args) {
        const parsed = z
          .object({
            mode: z.enum(["visible", "background"]).optional(),
            tabId: z.string().trim().min(1).optional()
          })
          .parse(args);
        const mode = browserActionMode(browser, parsed.mode);
        await context.approvals.require({
          type: "browser",
          action: "screenshot",
          target: "current browser page",
          url: browserTargetUrl(browser, mode, parsed.tabId),
          mode,
          destructive: false
        });
        return formatBrowserToolResult("screenshot", await browser.screenshot({ mode, tabId: parsed.tabId }));
      }
    });

    register({
      schema: {
        name: "browser_snapshot",
        description:
          "Read a compact frame-aware DOM, shadow DOM, text, and clickable-element snapshot from Arivu's isolated browser. Defaults to the active browser mode. Prefer this before clicking when inspecting page state.",
        parameters: objectSchema({
          mode: {
            type: "string",
            enum: ["visible", "background"],
            description: "Optional browser mode. Defaults to the active browser mode."
          },
          tabId: { type: "string", description: "Optional visible browser tab id. Defaults to the active visible tab." },
          maxLength: { type: "number", description: "Maximum snapshot text length, from 1000 to 20000." }
        })
      },
      async execute(args) {
        const parsed = z
          .object({
            mode: z.enum(["visible", "background"]).optional(),
            tabId: z.string().trim().min(1).optional(),
            maxLength: z.number().int().min(1000).max(20_000).default(12_000)
          })
          .parse(args);
        const mode = browserActionMode(browser, parsed.mode);
        await context.approvals.require({
          type: "browser",
          action: "snapshot",
          target: "current browser page",
          url: browserTargetUrl(browser, mode, parsed.tabId),
          mode,
          destructive: false
        });
        return formatBrowserToolResult("snapshot", await browser.snapshot({ ...parsed, mode }));
      }
    });

    register({
      schema: {
        name: "browser_console",
        description: "Read console logs and errors collected from Arivu's isolated browser. Defaults to the active browser mode.",
        parameters: objectSchema({
          mode: {
            type: "string",
            enum: ["visible", "background"],
            description: "Optional browser mode. Defaults to the active browser mode."
          },
          tabId: { type: "string", description: "Optional visible browser tab id. Defaults to the active visible tab." },
          levels: { type: "array", items: { type: "string" }, description: "Optional log levels such as error, warning, info, or debug." },
          limit: { type: "number", description: "Maximum logs to return, from 1 to 100." }
        })
      },
      async execute(args) {
        const parsed = z
          .object({
            mode: z.enum(["visible", "background"]).optional(),
            tabId: z.string().trim().min(1).optional(),
            levels: z.array(z.string()).optional(),
            limit: z.number().int().min(1).max(100).default(50)
          })
          .parse(args);
        const mode = browserActionMode(browser, parsed.mode);
        await context.approvals.require({
          type: "browser",
          action: "console",
          target: "current browser page",
          url: browserTargetUrl(browser, mode, parsed.tabId),
          mode,
          destructive: false
        });
        return formatBrowserToolResult("console", await browser.console({ ...parsed, mode }));
      }
    });

    register({
      schema: {
        name: "browser_click",
        description:
          "Click an element in Arivu's isolated browser by CSS selector, visible text, aria-label, title, or placeholder, or by the numeric index from browser_snapshot's elementsTree (preferred when available: exact targeting, no fuzzy re-match). Searches frames and open shadow roots. Defaults to the active browser mode.",
        parameters: objectSchema({
          target: { type: "string", description: "CSS selector or visible element text to click. Required unless index is given." },
          index: {
            type: "number",
            description: "Element index from browser_snapshot's elementsTree. Falls back to target if unavailable."
          },
          mode: {
            type: "string",
            enum: ["visible", "background"],
            description: "Optional browser mode. Defaults to the active browser mode."
          },
          tabId: { type: "string", description: "Optional visible browser tab id. Defaults to the active visible tab." }
        })
      },
      async execute(args) {
        const parsed = z
          .object({
            target: z.string().trim().min(1).optional(),
            index: z.number().int().min(0).optional(),
            mode: z.enum(["visible", "background"]).optional(),
            tabId: z.string().trim().min(1).optional()
          })
          .refine((value) => value.target !== undefined || value.index !== undefined, {
            message: "Provide either target or index."
          })
          .parse(args);
        const mode = browserActionMode(browser, parsed.mode);
        await context.approvals.require({
          type: "browser",
          action: "click",
          target: parsed.target ?? `index ${parsed.index}`,
          url: browserTargetUrl(browser, mode, parsed.tabId),
          mode,
          destructive: false
        });
        return formatBrowserToolResult("click", await browser.click({ ...parsed, mode }));
      }
    });

    register({
      schema: {
        name: "browser_click_at",
        description:
          "Click exact coordinates in Arivu's isolated browser when DOM selectors fail. Use CSS viewport coordinates from browser_snapshot/browser_screenshot visual elements, or image coordinates from the latest screenshot.",
        parameters: objectSchema({
          x: { type: "number", description: "X coordinate to click." },
          y: { type: "number", description: "Y coordinate to click." },
          mode: {
            type: "string",
            enum: ["visible", "background"],
            description: "Optional browser mode. Defaults to the active browser mode."
          },
          tabId: { type: "string", description: "Optional visible browser tab id. Defaults to the active visible tab." },
          coordinateSpace: {
            type: "string",
            enum: ["css", "image"],
            description: "Coordinate space. Use css for viewport coordinates, or image for pixels in the latest screenshot."
          }
        })
      },
      async execute(args) {
        const parsed = z
          .object({
            x: z.number().finite(),
            y: z.number().finite(),
            mode: z.enum(["visible", "background"]).optional(),
            tabId: z.string().trim().min(1).optional(),
            coordinateSpace: z.enum(["css", "image"]).default("css")
          })
          .parse(args);
        const mode = browserActionMode(browser, parsed.mode);
        await context.approvals.require({
          type: "browser",
          action: "click coordinates",
          target: `${parsed.coordinateSpace}:${parsed.x},${parsed.y}`,
          url: browserTargetUrl(browser, mode, parsed.tabId),
          mode,
          destructive: false
        });
        return formatBrowserToolResult("click_at", await browser.clickAt({ ...parsed, mode }));
      }
    });

    register({
      schema: {
        name: "browser_type",
        description:
          "Type text into an input, textarea, select, or editable element in Arivu's isolated browser by selector or label text, or by the numeric index from browser_snapshot's elementsTree (preferred when available). Searches frames and open shadow roots. Defaults to the active browser mode.",
        parameters: objectSchema({
          target: {
            type: "string",
            description: "CSS selector, label text, aria-label, title, or placeholder to type into. Required unless index is given."
          },
          index: {
            type: "number",
            description: "Element index from browser_snapshot's elementsTree. Falls back to target if unavailable."
          },
          text: { type: "string", description: "Text to enter." },
          mode: {
            type: "string",
            enum: ["visible", "background"],
            description: "Optional browser mode. Defaults to the active browser mode."
          },
          tabId: { type: "string", description: "Optional visible browser tab id. Defaults to the active visible tab." },
          submit: { type: "boolean", description: "Press Enter after typing." }
        })
      },
      async execute(args) {
        const parsed = z
          .object({
            target: z.string().trim().min(1).optional(),
            index: z.number().int().min(0).optional(),
            text: z.string(),
            mode: z.enum(["visible", "background"]).optional(),
            tabId: z.string().trim().min(1).optional(),
            submit: z.boolean().default(false)
          })
          .refine((value) => value.target !== undefined || value.index !== undefined, {
            message: "Provide either target or index."
          })
          .parse(args);
        const mode = browserActionMode(browser, parsed.mode);
        await context.approvals.require({
          type: "browser",
          action: parsed.submit ? "type and submit" : "type",
          target: parsed.target ?? `index ${parsed.index}`,
          url: browserTargetUrl(browser, mode, parsed.tabId),
          mode,
          destructive: Boolean(parsed.submit)
        });
        return formatBrowserToolResult("type", await browser.type({ ...parsed, mode }));
      }
    });

    register({
      schema: {
        name: "browser_scroll",
        description:
          "Scroll Arivu's isolated browser vertically or horizontally. Without index, scrolls the whole page; with index, scrolls the container at that element index (or its nearest scrollable ancestor).",
        parameters: objectSchema({
          direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction." },
          pixels: { type: "number", description: "Pixels to scroll for left/right, or an explicit vertical pixel amount." },
          numPages: {
            type: "number",
            description: "Vertical scroll amount in viewport pages (e.g. 1 = one full page). Ignored for left/right."
          },
          index: { type: "number", description: "Optional container element index to scroll instead of the whole page." },
          mode: {
            type: "string",
            enum: ["visible", "background"],
            description: "Optional browser mode. Defaults to the active browser mode."
          },
          tabId: { type: "string", description: "Optional visible browser tab id. Defaults to the active visible tab." }
        })
      },
      async execute(args) {
        const parsed = z
          .object({
            direction: z.enum(["up", "down", "left", "right"]),
            pixels: z.number().int().min(0).optional(),
            numPages: z.number().min(0).max(10).optional(),
            index: z.number().int().min(0).optional(),
            mode: z.enum(["visible", "background"]).optional(),
            tabId: z.string().trim().min(1).optional()
          })
          .parse(args);
        const mode = browserActionMode(browser, parsed.mode);
        await context.approvals.require({
          type: "browser",
          action: "scroll",
          target: parsed.index === undefined ? "page" : `index ${parsed.index}`,
          url: browserTargetUrl(browser, mode, parsed.tabId),
          mode,
          destructive: false
        });
        return formatBrowserToolResult("scroll", await browser.scroll({ ...parsed, mode }));
      }
    });

    register({
      schema: {
        name: "browser_select_option",
        description: "Select a dropdown option by element index (from browser_snapshot's elementsTree) and the option's visible text.",
        parameters: objectSchema({
          index: { type: "number", description: "Select element index from browser_snapshot's elementsTree." },
          optionText: { type: "string", description: "Visible text of the option to select." },
          mode: {
            type: "string",
            enum: ["visible", "background"],
            description: "Optional browser mode. Defaults to the active browser mode."
          },
          tabId: { type: "string", description: "Optional visible browser tab id. Defaults to the active visible tab." }
        })
      },
      async execute(args) {
        const parsed = z
          .object({
            index: z.number().int().min(0),
            optionText: z.string().trim().min(1),
            mode: z.enum(["visible", "background"]).optional(),
            tabId: z.string().trim().min(1).optional()
          })
          .parse(args);
        const mode = browserActionMode(browser, parsed.mode);
        await context.approvals.require({
          type: "browser",
          action: "select option",
          target: `index ${parsed.index}: ${parsed.optionText}`,
          url: browserTargetUrl(browser, mode, parsed.tabId),
          mode,
          destructive: false
        });
        return formatBrowserToolResult("select_option", await browser.selectOption({ ...parsed, mode }));
      }
    });

    register({
      schema: {
        name: "browser_task",
        description:
          "Use it when you need to click, scroll, type, select, or focus elements on the page (including inside same-origin iframes), or execute JavaScript (opt-in via allowJavaScript). Delegates to an autonomous in-page agent that observes and acts on Arivu's isolated browser until done, instead of you driving snapshot/click/type rounds yourself. Best for single-page or short navigation tasks; it cannot open OS file dialogs, follow links that open a new tab, or answer follow-up questions mid-task. The result carries the task's success flag, its data answer, a step-by-step trace of what the in-page agent did, the final url/title, and a snapshotAfter indexed page snapshot — read trace and snapshotAfter to confirm the outcome instead of firing a separate browser_screenshot, which you only need when you require the actual pixels. On failure, read the trace (and proxyDiagnostics) to see where it went wrong before re-running with a clearer instruction. Provider rate limits and rejected request parameters are already retried automatically inside the tool — never re-run to work around them — and stopReason \"infrastructure\" means the model endpoint itself is failing and retries are paused: report it to the user or switch the browser-task model instead of re-running.",
        parameters: objectSchema({
          instruction: { type: "string", description: "Natural-language description of the task to complete on the current page." },
          mode: {
            type: "string",
            enum: ["visible", "background"],
            description: "Optional browser mode. Defaults to the active browser mode."
          },
          tabId: { type: "string", description: "Optional visible browser tab id. Defaults to the active visible tab." },
          maxSteps: { type: "number", description: "Maximum number of agent loops, from 1 to 200. Defaults to 100." },
          timeoutMs: {
            type: "number",
            description:
              "Wall-clock ceiling in milliseconds, from 5000 to 14400000. Defaults to 4200000. Values below 600000 are raised to 600000 because the browser agent is deliberately rate-paced and provider calls can take minutes; fast tasks still return immediately when complete."
          },
          allowedDomains: {
            type: "array",
            items: { type: "string" },
            description: "Optional hostnames the task may navigate to. Defaults to the current page's own hostname."
          },
          allowJavaScript: {
            type: "boolean",
            description:
              "Allow the in-page agent to execute arbitrary JavaScript on the page. Off by default; only enable when click/scroll/type/select cannot accomplish the task."
          },
          allowSensitiveActions: {
            type: "boolean",
            description:
              "By default the in-page agent pauses when the page contains sensitive confirmation language (payment, order, account change). Set true ONLY after the user has explicitly confirmed the sensitive action in this conversation; never set it preemptively."
          }
        })
      },
      async execute(args) {
        const parsed = z
          .object({
            instruction: z.string().trim().min(1),
            mode: z.enum(["visible", "background"]).optional(),
            tabId: z.string().trim().min(1).optional(),
            maxSteps: optionalModelInteger(1, 200),
            timeoutMs: optionalModelInteger(5_000, 14_400_000),
            allowedDomains: z.array(z.string().trim().min(1)).optional(),
            allowJavaScript: z.boolean().optional(),
            allowSensitiveActions: z.boolean().optional()
          })
          .parse(args);
        if (!context.browserTaskModel) {
          throw new Error("browser_task has no model configured for this run.");
        }
        const mode = browserActionMode(browser, parsed.mode);
        if (mode === "visible" && parsed.tabId === "background") {
          throw new Error('browser_task cannot use tabId "background" in visible mode. Omit tabId to use the active visible tab.');
        }
        if (mode === "background" && parsed.tabId && parsed.tabId !== "background") {
          throw new Error("browser_task cannot target a visible tab id in background mode. Omit tabId or switch to visible mode.");
        }
        const timeoutMs = parsed.timeoutMs === undefined ? undefined : Math.max(parsed.timeoutMs, MIN_DELEGATED_BROWSER_TASK_TIMEOUT_MS);
        await context.approvals.require({
          type: "browser",
          action: "task",
          target: parsed.instruction,
          url: browserTargetUrl(browser, mode, parsed.tabId),
          mode,
          destructive: true
        });
        return formatBrowserToolResult(
          "task",
          await browser.task({
            ...parsed,
            timeoutMs,
            mode,
            modelConfig: context.browserTaskModel,
            signal: context.signal,
            onProgress: context.onBrowserTaskProgress
          })
        );
      }
    });

    if (!MANUAL_BROWSER_TOOLS_ENABLED) {
      for (const name of MANUAL_BROWSER_TOOL_NAMES) {
        tools.delete(name);
      }
    }
  }

  register({
    schema: {
      name: "current_datetime",
      description: "Get the current local date, time, timezone, UTC time, and UTC offset from the local system clock.",
      parameters: objectSchema({})
    },
    async execute() {
      return JSON.stringify(currentDateTime(), null, 2);
    }
  });

  register({
    schema: {
      name: "current_location",
      description:
        "Get approximate current location context from the local timezone only. Does not use GPS, IP lookup, or network location.",
      parameters: objectSchema({})
    },
    async execute() {
      return JSON.stringify(currentLocation(), null, 2);
    }
  });

  register({
    schema: {
      name: "list_skills",
      description: "List globally installed local skills.",
      parameters: objectSchema({})
    },
    async execute() {
      return formatSkillList(await discoverSkills());
    }
  });

  register({
    schema: {
      name: "read_skill",
      description: "Read the instructions for a globally installed local skill by name.",
      parameters: objectSchema({
        name: { type: "string", description: "Skill name, such as code-review or fix-tests." }
      })
    },
    async execute(args) {
      const parsed = z.object({ name: z.string().trim().min(1) }).parse(args);
      const skill = await readSkill(parsed.name);
      return [`# ${skill.title}`, `Path: ${skill.path}`, "", skill.content].join("\n");
    }
  });

  register({
    schema: {
      name: "mcp_list_tools",
      description: "List tools exposed by configured MCP servers.",
      parameters: objectSchema({})
    },
    async execute() {
      const enabledServers = enabledMcpServerNames(scopedMcpServers);
      if (enabledServers.length > 0) {
        await context.approvals.require({
          type: "mcp",
          server: enabledServers.length === 1 ? (enabledServers[0] ?? "*") : "*",
          servers: enabledServers,
          tool: "list_tools",
          destructive: true
        });
      }
      return listMcpTools(scopedMcpServers);
    }
  });

  register({
    schema: {
      name: "mcp_call_tool",
      description: "Call a tool on a configured MCP server.",
      parameters: objectSchema({
        server: { type: "string", description: "Configured MCP server name." },
        tool: { type: "string", description: "Tool name exposed by that server." },
        args: {
          type: "object",
          description: "Tool arguments as a JSON object.",
          additionalProperties: true
        }
      })
    },
    async execute(args) {
      const parsed = z
        .object({
          server: z.string().trim().min(1),
          tool: z.string().trim().min(1),
          args: z.record(z.unknown()).default({})
        })
        .parse(args);
      await context.approvals.require({
        type: "mcp",
        server: parsed.server,
        tool: parsed.tool,
        arguments: parsed.args,
        destructive: true
      });
      return callMcpTool(scopedMcpServers, parsed.server, parsed.tool, parsed.args);
    }
  });

  register({
    schema: {
      name: "apply_patch",
      description: "Apply a unified diff to files inside the workspace.",
      parameters: objectSchema({
        diff: { type: "string", description: "Unified diff." }
      })
    },
    async execute(args) {
      const parsed = z.object({ diff: z.string() }).parse(args);
      const summary = summarizePatch(parsed.diff);
      const review = directEditReview ? reviewForPatch(parsed.diff) : { required: false, summary: "", reason: undefined };
      await context.approvals.require({
        type: "write",
        summary,
        paths: changedPathsFromDiff(parsed.diff),
        diff: parsed.diff,
        destructive: review.required,
        changeSummary: review.summary,
        reviewReason: review.reason
      });
      if (context.checkpoint) {
        // Record every touched path up front so newly created files can also be undone.
        for (const changedPath of changedPathsFromDiff(parsed.diff)) {
          await context.checkpoint.record(await resolveSafeWorkspacePath(context.workspaceRoot, changedPath));
        }
      }
      await applyUnifiedDiff(
        parsed.diff,
        (requestedPath) => resolveSafeWorkspacePath(context.workspaceRoot, requestedPath),
        (target) => state.assertUnchanged(target)
      );
      return `Applied patch: ${summary}`;
    }
  });

  register({
    schema: {
      name: "write_file",
      description: "Create a new file or explicitly replace an existing file inside the workspace.",
      parameters: objectSchema({
        path: { type: "string", description: "Workspace-relative file path." },
        content: { type: "string", description: "Complete file contents." },
        mode: { type: "string", enum: ["create", "replace"], description: "Write mode." }
      })
    },
    async execute(args) {
      const parsed = z.object({ path: z.string(), content: z.string(), mode: z.enum(["create", "replace"]) }).parse(args);
      const target = await resolveSafeWorkspacePath(context.workspaceRoot, parsed.path);
      const existing = await exists(target);
      if (parsed.mode === "create" && existing) {
        throw new Error(`Refusing to create ${parsed.path}; file already exists.`);
      }
      if (parsed.mode === "replace" && !existing) {
        throw new Error(`Refusing to replace ${parsed.path}; file does not exist.`);
      }
      if (existing) {
        await state.assertUnchanged(target);
      }

      const original = existing ? await readFile(target, "utf8") : "";
      const review = directEditReview ? reviewForFileWrite(parsed.content) : { required: false, summary: "", reason: undefined };
      await context.approvals.require({
        type: "write",
        summary: `${parsed.mode} ${parsed.path}`,
        path: parsed.path,
        mode: parsed.mode,
        original,
        content: parsed.content,
        destructive: review.required,
        changeSummary: review.summary,
        reviewReason: review.reason
      });
      await context.checkpoint?.record(target);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, parsed.content, "utf8");
      if (existing) {
        await state.remember(target);
      }
      return `${parsed.mode === "create" ? "Created" : "Replaced"} ${parsed.path}`;
    }
  });

  register({
    schema: {
      name: "run",
      description:
        "Run a command in the workspace. Prefer argv for simple commands because it avoids shell parsing. Use command only when shell syntax is required. Commands currently execute on the local host process; container/sandbox profiles are explicit future execution-plane targets and return an unsupported-profile error until configured.",
      parameters: objectSchema({
        command: { type: "string", description: "Shell command string to run when shell syntax is required." },
        argv: {
          type: "array",
          items: { type: "string" },
          description:
            "Structured command vector. First item is the executable, remaining items are literal arguments. Preferred for tests, builds, and package commands."
        },
        executionProfile: {
          type: "string",
          enum: ["host", "container", "sandbox"],
          description: "Execution-plane profile. Use host today; container and sandbox are not configured yet."
        },
        timeoutMs: {
          type: "number",
          description: "Optional command timeout in milliseconds, from 1000 to 600000. Defaults to 120000."
        }
      })
    },
    async execute(args) {
      const parsed = z
        .object({
          command: z.string().trim().min(1).optional(),
          argv: z.array(z.string().trim().min(1)).min(1).optional(),
          executionProfile: z.enum(["host", "container", "sandbox"]).optional(),
          timeoutMs: z.number().int().min(MIN_COMMAND_TIMEOUT_MS).max(MAX_COMMAND_TIMEOUT_MS).default(DEFAULT_COMMAND_TIMEOUT_MS)
        })
        .parse(args);
      if (!parsed.command && !parsed.argv) {
        throw new Error("Provide command or argv.");
      }
      const executionProfile = resolveCommandExecutionProfile(parsed.executionProfile);
      if (!executionProfile.supported) {
        throw new Error(executionProfile.reason ?? `Unsupported execution profile: ${executionProfile.profile}`);
      }
      const commandMode = parsed.argv ? "argv" : "shell";
      const commandText = parsed.argv ? formatCommandVector(parsed.argv) : (parsed.command ?? "");
      const commandAnalysis = parsed.argv
        ? analyzeArgvCommand(parsed.argv[0] ?? "", parsed.argv.slice(1))
        : analyzeShellCommand(commandText);
      await context.approvals.require({
        type: "shell",
        command: commandText,
        commandMode,
        cwd: context.workspaceRoot,
        destructive: commandAnalysis.destructive,
        risk: commandAnalysis.risk,
        analysisSummary: commandAnalysis.summary,
        analysisReasons: commandAnalysis.reasons
      });
      const result = parsed.argv
        ? await execa(parsed.argv[0] ?? "", parsed.argv.slice(1), {
            cwd: context.workspaceRoot,
            shell: false,
            reject: false,
            timeout: parsed.timeoutMs,
            cancelSignal: context.signal
          })
        : await execa(commandText, {
            cwd: context.workspaceRoot,
            shell: true,
            reject: false,
            timeout: parsed.timeoutMs,
            cancelSignal: context.signal
          });
      const stdout = truncateCommandStream(String(result.stdout ?? ""));
      const stderr = truncateCommandStream(String(result.stderr ?? ""));
      return [
        `executionProfile: ${executionProfile.profile}`,
        `executionIsolation: ${executionProfile.isolation}`,
        `workingDirectory: ${context.workspaceRoot}`,
        `commandMode: ${commandMode}`,
        `timeoutMs: ${parsed.timeoutMs}`,
        result.timedOut ? "timedOut: true" : "",
        result.signal ? `signal: ${result.signal}` : "",
        `commandRisk: ${commandAnalysis.risk}`,
        `commandAnalysis: ${commandAnalysis.summary}`,
        result.exitCode === undefined ? "" : `exitCode: ${result.exitCode}`,
        stdout ? `stdout:\n${stdout}` : "",
        stderr ? `stderr:\n${stderr}` : ""
      ]
        .filter(Boolean)
        .join("\n");
    }
  });

  register({
    schema: {
      name: "git_status",
      description: "Show git branch and working tree status.",
      parameters: objectSchema({})
    },
    async execute() {
      await context.approvals.require({ type: "read", summary: "git status", path: "." });
      const branch = await execa("git", ["branch", "--show-current"], {
        cwd: context.workspaceRoot,
        reject: false,
        cancelSignal: context.signal
      });
      const status = await execa("git", ["status", "--short"], {
        cwd: context.workspaceRoot,
        reject: false,
        cancelSignal: context.signal
      });
      return [`branch: ${branch.stdout || "(none)"}`, status.stdout || "clean"].join("\n");
    }
  });

  return {
    schemas: Array.from(tools.values()).map((tool) => tool.schema),
    async execute(name: string, args: unknown) {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }
      try {
        return await tool.execute(args);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  };
}

function optionalModelInteger(minimum: number, maximum: number) {
  return z.preprocess((value) => {
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      return value;
    }
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : value;
  }, z.number().int().min(minimum).max(maximum).optional());
}

function objectSchema(properties: Record<string, unknown>) {
  return {
    type: "object",
    properties,
    additionalProperties: false
  };
}

function formatCommandVector(argv: string[]) {
  return argv.map(formatCommandPart).join(" ");
}

function formatCommandPart(value: string) {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : JSON.stringify(value);
}

function hiddenAgentBrowserMode(): BrowserMode {
  return "background";
}

function browserActionMode(browser: BrowserToolController, requestedMode: BrowserMode | undefined): BrowserMode {
  return requestedMode ?? browser.getState().activeMode ?? browser.getState().defaultMode ?? hiddenAgentBrowserMode();
}

function browserTargetUrl(browser: BrowserToolController, mode: BrowserMode, tabId: string | undefined) {
  const state = browser.getState();
  const target = mode === "visible" ? state.visible : state.background;
  const tab = tabId ? target.tabs?.find((entry) => entry.id === tabId) : undefined;
  return nonEmptyString(tab?.url) ?? nonEmptyString(target.url);
}

function nonEmptyString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFileLines(filePath: string, offset: number, limit: number) {
  const info = await stat(filePath);
  if (info.size > MAX_READABLE_FILE_BYTES) {
    throw new Error(
      `Refusing to read ${path.basename(filePath)}; it is ${formatByteSize(info.size)} (limit ${formatByteSize(
        MAX_READABLE_FILE_BYTES
      )}). Use search or run to inspect it.`
    );
  }

  const raw = await readFile(filePath, "utf8");
  if (raw.length === 0) {
    return { text: "(empty file)", readEntireFile: true };
  }

  const lines = raw.split("\n");
  // A trailing newline yields a final empty element; drop it so line counts match the file.
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  const totalLines = lines.length;
  const startIndex = Math.min(offset - 1, totalLines);
  const requestedEnd = Math.min(startIndex + limit, totalLines);

  const numberWidth = String(requestedEnd).length;
  const out: string[] = [];
  let bytes = 0;
  let endIndex = startIndex;
  let byteTruncated = false;
  let lineTruncated = false;
  for (let index = startIndex; index < requestedEnd; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = truncateLine(rawLine);
    if (line !== rawLine) {
      lineTruncated = true;
    }
    const rendered = `${String(index + 1).padStart(numberWidth)}\t${line}`;
    const renderedBytes = Buffer.byteLength(rendered, "utf8") + 1;
    if (bytes + renderedBytes > MAX_READ_OUTPUT_BYTES && out.length > 0) {
      byteTruncated = true;
      break;
    }
    out.push(rendered);
    bytes += renderedBytes;
    endIndex = index + 1;
  }

  // Only a complete, untruncated read from the top counts as "seen the whole file" for the
  // read-before-write guard.
  const readEntireFile = startIndex === 0 && endIndex === totalLines && !byteTruncated && !lineTruncated;
  const notes: string[] = [];
  if (startIndex > 0) {
    notes.push(`Showing lines ${startIndex + 1}-${endIndex} of ${totalLines}.`);
  } else if (endIndex < totalLines) {
    notes.push(`Showing lines 1-${endIndex} of ${totalLines}; use offset ${endIndex + 1} to continue.`);
  }
  if (byteTruncated && endIndex < requestedEnd) {
    notes.push("Output truncated at the byte limit; narrow the range with offset and limit.");
  }
  if (lineTruncated) {
    notes.push("One or more long lines were truncated.");
  }

  const body = out.join("\n");
  return {
    text: notes.length > 0 ? `${body}\n[${notes.join(" ")}]` : body,
    readEntireFile
  };
}

function truncateLine(line: string) {
  return line.length <= MAX_READ_LINE_LENGTH ? line : `${line.slice(0, MAX_READ_LINE_LENGTH)}… [line truncated]`;
}

function countOccurrences(haystack: string, needle: string) {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function truncateCommandStream(value: string) {
  if (value.length <= MAX_RUN_OUTPUT_CHARS) {
    return value;
  }
  const headSize = Math.floor(MAX_RUN_OUTPUT_CHARS * 0.6);
  const tailSize = MAX_RUN_OUTPUT_CHARS - headSize;
  const omitted = value.length - MAX_RUN_OUTPUT_CHARS;
  return `${value.slice(0, headSize)}\n… [${omitted} characters truncated] …\n${value.slice(value.length - tailSize)}`;
}

function formatByteSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KB`;
  }
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

type SearchOptions = {
  query: string;
  glob?: string;
  contextLines: number;
  maxResults: number;
  ignoreCase: boolean;
};

async function searchWorkspace(context: ToolContext, target: string, options: SearchOptions) {
  const ripgrep = await runRipgrepSearch(context, target, options);
  if (ripgrep !== undefined) {
    return ripgrep;
  }
  return runJsSearch(target, options);
}

async function runRipgrepSearch(context: ToolContext, target: string, options: SearchOptions): Promise<string | undefined> {
  const args = ["--line-number", "--hidden", "--glob", "!.git", "--max-count", String(options.maxResults)];
  if (options.ignoreCase) {
    args.push("--ignore-case");
  }
  if (options.contextLines > 0) {
    args.push("--context", String(options.contextLines));
  }
  if (options.glob) {
    args.push("--glob", options.glob);
  }
  args.push("--regexp", options.query, target);
  try {
    const result = await execa("rg", args, {
      cwd: context.workspaceRoot,
      reject: false,
      cancelSignal: context.signal,
      maxBuffer: MAX_TOOL_SEARCH_OUTPUT * 4
    });
    // exitCode 1 means "no matches" for ripgrep; treat that as an empty (successful) result.
    if (result.exitCode === 0) {
      return result.stdout || "No matches.";
    }
    if (result.exitCode === 1 && !result.stderr) {
      return "No matches.";
    }
    return undefined;
  } catch {
    // ripgrep is not installed or failed to spawn; fall back to the built-in scanner.
    return undefined;
  }
}

async function runJsSearch(target: string, options: SearchOptions): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(options.query, options.ignoreCase ? "i" : "");
  } catch (error) {
    return `Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`;
  }
  const globRegex = options.glob ? globToRegExp(options.glob) : undefined;
  const rootInfo = await stat(target).catch(() => undefined);
  const files: string[] = [];
  if (rootInfo?.isFile()) {
    files.push(target);
  } else if (rootInfo?.isDirectory()) {
    await collectSearchFiles(target, files);
  } else {
    return `Path not found: ${target}`;
  }

  const matches: string[] = [];
  let matchCount = 0;
  for (const file of files) {
    if (matchCount >= options.maxResults) {
      break;
    }
    if (globRegex && !globRegex.test(path.relative(target, file) || path.basename(file))) {
      continue;
    }
    const info = await stat(file).catch(() => undefined);
    if (!info || info.size > MAX_JS_SEARCH_FILE_BYTES) {
      continue;
    }
    const content = await readFile(file, "utf8").catch(() => undefined);
    if (content === undefined || content.includes("\u0000")) {
      continue;
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length && matchCount < options.maxResults; index += 1) {
      const line = lines[index] ?? "";
      regex.lastIndex = 0;
      if (!regex.test(line)) {
        continue;
      }
      matchCount += 1;
      const label = path.relative(target, file) || path.basename(file);
      if (options.contextLines > 0) {
        const from = Math.max(0, index - options.contextLines);
        const to = Math.min(lines.length - 1, index + options.contextLines);
        for (let ctx = from; ctx <= to; ctx += 1) {
          const separator = ctx === index ? ":" : "-";
          matches.push(`${label}${separator}${ctx + 1}${separator}${truncateLine(lines[ctx] ?? "")}`);
        }
        matches.push("--");
      } else {
        matches.push(`${label}:${index + 1}:${truncateLine(line)}`);
      }
    }
  }

  if (matches.length === 0) {
    return "No matches.";
  }
  const trailer = matchCount >= options.maxResults ? `\n[stopped at ${options.maxResults} matches]` : "";
  return `${matches.join("\n")}${trailer}`;
}

async function collectSearchFiles(dir: string, out: string[]) {
  if (out.length >= MAX_JS_SEARCH_FILES) {
    return;
  }
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= MAX_JS_SEARCH_FILES) {
      return;
    }
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSearchFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*";
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else if (".+^${}()|[]\\".includes(char ?? "")) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
  }
  return new RegExp(`(^|/)${pattern}$`);
}

function truncateToolOutput(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[truncated]`;
}

async function normalizeSafeBrowserToolUrl(workspaceRoot: string, rawUrl: string) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "file:") {
    return rawUrl;
  }

  const filePath = fileURLToPath(parsed);
  await assertRealPathInsideWorkspace(workspaceRoot, filePath, rawUrl);
  return pathToFileURL(path.resolve(filePath)).toString();
}

function enabledMcpServerNames(servers: AppConfig["mcpServers"] | undefined) {
  return Object.entries(servers ?? {})
    .filter(([, server]) => !server.disabled)
    .map(([name]) => name);
}

function mcpServersForScope(servers: AppConfig["mcpServers"] | undefined, scopePolicyRules: WorkspaceScopePolicyRules) {
  const allowed = scopePolicyRules.allowedMcpServers;
  if (!allowed?.length || allowed.includes("*")) {
    return servers;
  }
  const allowedSet = new Set(allowed);
  return Object.fromEntries(Object.entries(servers ?? {}).filter(([name]) => allowedSet.has(name)));
}

function currentDateTime(now = new Date()) {
  const options = Intl.DateTimeFormat().resolvedOptions();
  const timeZone = options.timeZone || "UTC";

  return {
    localDate: formatDatePart(now, timeZone),
    localTime: formatTimePart(now, timeZone),
    timeZone,
    utcOffset: timeZoneOffset(now, timeZone),
    utc: now.toISOString(),
    locale: options.locale
  };
}

function currentLocation() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const zoneParts = timeZone.split("/");
  const city = zoneParts.length > 1 ? (zoneParts.at(-1)?.replace(/_/g, " ") ?? null) : null;
  const region = zoneParts.length > 1 ? (zoneParts[0]?.replace(/_/g, " ") ?? null) : null;
  const country = countryForTimeZone(timeZone);

  return {
    city,
    region,
    country,
    timeZone,
    source: "system_timezone",
    precision: "timezone",
    confidence: country ? 0.45 : 0.25,
    note: "Approximate location context only; GPS, IP lookup, and network location were not used."
  };
}

function formatDatePart(date: Date, timeZone: string) {
  const parts = dateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatTimePart(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  return `${partValue(parts, "hour")}:${partValue(parts, "minute")}:${partValue(parts, "second")}`;
}

function dateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return {
    year: partValue(parts, "year"),
    month: partValue(parts, "month"),
    day: partValue(parts, "day")
  };
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function timeZoneOffset(date: Date, timeZone: string) {
  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset"
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  if (!offsetName || offsetName === "GMT") {
    return "+00:00";
  }

  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(offsetName);
  if (!match) {
    return offsetName;
  }

  const [, sign, rawHour, rawMinute] = match;
  return `${sign}${rawHour.padStart(2, "0")}:${rawMinute ?? "00"}`;
}

function countryForTimeZone(timeZone: string) {
  const exact: Record<string, string | null> = {
    "Asia/Kolkata": "India",
    "Asia/Calcutta": "India",
    "Europe/London": "United Kingdom",
    "Europe/Paris": "France",
    "America/New_York": "United States",
    "America/Chicago": "United States",
    "America/Denver": "United States",
    "America/Los_Angeles": "United States",
    "America/Phoenix": "United States",
    "America/Toronto": "Canada",
    "America/Vancouver": "Canada",
    "Australia/Sydney": "Australia",
    "Australia/Melbourne": "Australia",
    "Asia/Tokyo": "Japan",
    "Asia/Shanghai": "China",
    "Asia/Singapore": "Singapore",
    UTC: null
  };

  return exact[timeZone] ?? null;
}
