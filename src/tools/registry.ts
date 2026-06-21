import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { ApprovalManager } from "../permissions/ApprovalManager.js";
import { isDestructiveCommand } from "../permissions/destructive.js";
import type { AppConfig } from "../config.js";
import { discoverSkills, formatSkillList, readSkill } from "../agent/skills.js";
import type { ToolSchema } from "../agent/types.js";
import { FileStateTracker } from "./fileState.js";
import { callMcpTool, listMcpTools } from "./mcp.js";
import { applyUnifiedDiff, summarizePatch } from "./patch.js";
import { resolveWorkspacePath } from "./pathSafety.js";
import { formatWebSearchResults, searchWeb } from "./webSearch.js";
import {
  formatBrowserToolResult,
  isLocalBrowserUrl,
  normalizeBrowserUrl,
  type BrowserMode,
  type BrowserToolController
} from "./browserControl.js";

type ToolContext = {
  workspaceRoot: string;
  approvals: ApprovalManager;
  tavilyApiKey?: string;
  mcpServers?: AppConfig["mcpServers"];
  browser?: BrowserToolController;
};

type ToolDefinition = {
  schema: ToolSchema;
  execute(args: unknown): Promise<string>;
};

export function createToolRegistry(context: ToolContext) {
  const state = new FileStateTracker();
  const tools = new Map<string, ToolDefinition>();

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
      const target = resolveWorkspacePath(context.workspaceRoot, parsed.path);
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
      description: "Read a text file inside the workspace.",
      parameters: objectSchema({
        path: { type: "string", description: "Workspace-relative file path." }
      })
    },
    async execute(args) {
      const parsed = z.object({ path: z.string() }).parse(args);
      const target = resolveWorkspacePath(context.workspaceRoot, parsed.path);
      const content = await readFile(target, "utf8");
      await state.remember(target);
      return content.length > 20_000 ? `${content.slice(0, 20_000)}\n[truncated]` : content;
    }
  });

  register({
    schema: {
      name: "search",
      description: "Search workspace files with ripgrep.",
      parameters: objectSchema({
        query: { type: "string", description: "Search pattern." },
        path: { type: "string", description: "Optional workspace-relative path." }
      })
    },
    async execute(args) {
      const parsed = z.object({ query: z.string(), path: z.string().default(".") }).parse(args);
      const target = resolveWorkspacePath(context.workspaceRoot, parsed.path);
      try {
        const result = await execa("rg", ["--line-number", "--hidden", "--glob", "!.git", parsed.query, target], {
          cwd: context.workspaceRoot,
          reject: false
        });
        return result.stdout || result.stderr || "No matches.";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
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
      const results = await searchWeb(parsed.query, parsed.maxResults, { tavilyApiKey: context.tavilyApiKey });
      return formatWebSearchResults(parsed.query, results);
    }
  });

  const browser = context.browser;
  if (browser) {
    register({
      schema: {
        name: "browser_open",
        description:
          "Open a URL in Arivu's isolated browser. Defaults to hidden background mode; use visible mode only when the user explicitly asks to see a separate browser window. In visible mode, pass newTab to create a new browser tab or tabId to target an existing tab.",
        parameters: objectSchema({
          url: { type: "string", description: "URL to open. localhost:5173 is accepted and normalized to http://localhost:5173." },
          mode: { type: "string", enum: ["visible", "background"], description: "Optional browser mode. Defaults to hidden background mode." },
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
        const url = normalizeBrowserUrl(parsed.url);
        const mode = parsed.mode ?? hiddenAgentBrowserMode();
        await context.approvals.require({
          type: "browser",
          action: "open",
          target: url,
          mode,
          destructive: !isLocalBrowserUrl(url)
        });
        return formatBrowserToolResult("open", await browser.open({ url, mode, tabId: parsed.tabId, newTab: parsed.newTab }));
      }
    });

    register({
      schema: {
        name: "browser_screenshot",
        description:
          "Capture the current viewport of Arivu's isolated browser and save it to a PNG file. Also returns frame-aware visual metadata and CSS viewport coordinates that can be used with browser_click_at. Defaults to the active browser mode.",
        parameters: objectSchema({
          mode: { type: "string", enum: ["visible", "background"], description: "Optional browser mode. Defaults to the active browser mode." },
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
        return formatBrowserToolResult("screenshot", await browser.screenshot({ mode: parsed.mode, tabId: parsed.tabId }));
      }
    });

    register({
      schema: {
        name: "browser_snapshot",
        description:
          "Read a compact frame-aware DOM, shadow DOM, text, and clickable-element snapshot from Arivu's isolated browser. Defaults to the active browser mode. Prefer this before clicking when inspecting page state.",
        parameters: objectSchema({
          mode: { type: "string", enum: ["visible", "background"], description: "Optional browser mode. Defaults to the active browser mode." },
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
        return formatBrowserToolResult("snapshot", await browser.snapshot(parsed));
      }
    });

    register({
      schema: {
        name: "browser_console",
        description: "Read console logs and errors collected from Arivu's isolated browser. Defaults to the active browser mode.",
        parameters: objectSchema({
          mode: { type: "string", enum: ["visible", "background"], description: "Optional browser mode. Defaults to the active browser mode." },
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
        return formatBrowserToolResult("console", await browser.console(parsed));
      }
    });

    register({
      schema: {
        name: "browser_click",
        description:
          "Click an element in Arivu's isolated browser by CSS selector, visible text, aria-label, title, or placeholder. Searches frames and open shadow roots. Defaults to the active browser mode.",
        parameters: objectSchema({
          target: { type: "string", description: "CSS selector or visible element text to click." },
          mode: { type: "string", enum: ["visible", "background"], description: "Optional browser mode. Defaults to the active browser mode." },
          tabId: { type: "string", description: "Optional visible browser tab id. Defaults to the active visible tab." }
        })
      },
      async execute(args) {
        const parsed = z
          .object({
            target: z.string().trim().min(1),
            mode: z.enum(["visible", "background"]).optional(),
            tabId: z.string().trim().min(1).optional()
          })
          .parse(args);
        const mode = browserActionMode(browser, parsed.mode);
        await context.approvals.require({
          type: "browser",
          action: "click",
          target: parsed.target,
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
          mode: { type: "string", enum: ["visible", "background"], description: "Optional browser mode. Defaults to the active browser mode." },
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
          "Type text into an input, textarea, select, or editable element in Arivu's isolated browser by selector or label text. Searches frames and open shadow roots. Defaults to the active browser mode.",
        parameters: objectSchema({
          target: { type: "string", description: "CSS selector, label text, aria-label, title, or placeholder to type into." },
          text: { type: "string", description: "Text to enter." },
          mode: { type: "string", enum: ["visible", "background"], description: "Optional browser mode. Defaults to the active browser mode." },
          tabId: { type: "string", description: "Optional visible browser tab id. Defaults to the active visible tab." },
          submit: { type: "boolean", description: "Press Enter after typing." }
        })
      },
      async execute(args) {
        const parsed = z
          .object({
            target: z.string().trim().min(1),
            text: z.string(),
            mode: z.enum(["visible", "background"]).optional(),
            tabId: z.string().trim().min(1).optional(),
            submit: z.boolean().default(false)
          })
          .parse(args);
        const mode = browserActionMode(browser, parsed.mode);
        await context.approvals.require({
          type: "browser",
          action: parsed.submit ? "type and submit" : "type",
          target: parsed.target,
          mode,
          destructive: Boolean(parsed.submit)
        });
        return formatBrowserToolResult("type", await browser.type({ ...parsed, mode }));
      }
    });
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
      return listMcpTools(context.mcpServers);
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
      return callMcpTool(context.mcpServers, parsed.server, parsed.tool, parsed.args);
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
      await context.approvals.require({ type: "write", summary, diff: parsed.diff });
      await applyUnifiedDiff(
        parsed.diff,
        (requestedPath) => resolveWorkspacePath(context.workspaceRoot, requestedPath),
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
      const target = resolveWorkspacePath(context.workspaceRoot, parsed.path);
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
      await context.approvals.require({
        type: "write",
        summary: `${parsed.mode} ${parsed.path}`,
        path: parsed.path,
        mode: parsed.mode,
        original,
        content: parsed.content
      });
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
      description: "Run a shell command in the workspace.",
      parameters: objectSchema({
        command: { type: "string", description: "Shell command to run." }
      })
    },
    async execute(args) {
      const parsed = z.object({ command: z.string() }).parse(args);
      await context.approvals.require({
        type: "shell",
        command: parsed.command,
        cwd: context.workspaceRoot,
        destructive: isDestructiveCommand(parsed.command)
      });
      const result = await execa(parsed.command, {
        cwd: context.workspaceRoot,
        shell: true,
        reject: false,
        timeout: 120_000
      });
      return [
        `exitCode: ${result.exitCode}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : ""
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
      const branch = await execa("git", ["branch", "--show-current"], {
        cwd: context.workspaceRoot,
        reject: false
      });
      const status = await execa("git", ["status", "--short"], {
        cwd: context.workspaceRoot,
        reject: false
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

function objectSchema(properties: Record<string, unknown>) {
  return {
    type: "object",
    properties,
    additionalProperties: false
  };
}

function hiddenAgentBrowserMode(): BrowserMode {
  return "background";
}

function browserActionMode(browser: BrowserToolController, requestedMode: BrowserMode | undefined): BrowserMode {
  return requestedMode ?? browser.getState().activeMode ?? browser.getState().defaultMode ?? hiddenAgentBrowserMode();
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
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
  const city = zoneParts.length > 1 ? zoneParts.at(-1)?.replace(/_/g, " ") ?? null : null;
  const region = zoneParts.length > 1 ? zoneParts[0]?.replace(/_/g, " ") ?? null : null;
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
    "UTC": null
  };

  return exact[timeZone] ?? null;
}
