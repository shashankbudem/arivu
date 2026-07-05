import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createSkill, readSkill } from "../src/agent/skills.js";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";
import type { WorkspaceScopePolicyRules } from "../src/permissions/scopePolicy.js";
import type { BrowserToolController } from "../src/tools/browserControl.js";
import { DIRECT_EDIT_REVIEW_CHANGED_LINE_THRESHOLD } from "../src/tools/directEditReview.js";
import { createToolRegistry } from "../src/tools/registry.js";

describe("createToolRegistry", () => {
  it("includes current date/time and location tools", () => {
    const registry = createRegistry();
    const names = registry.schemas.map((schema) => schema.name);

    expect(names).toContain("current_datetime");
    expect(names).toContain("current_location");
    expect(names).toContain("mcp_list_tools");
    expect(names).toContain("mcp_call_tool");
  });

  it("registers browser tools only when a browser controller is provided", async () => {
    const withoutBrowser = createRegistry();
    expect(withoutBrowser.schemas.map((schema) => schema.name)).not.toContain("browser_open");

    const browser = createFakeBrowser();
    const withBrowser = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("trusted"),
      browser
    });
    const names = withBrowser.schemas.map((schema) => schema.name);

    expect(names).toContain("browser_open");
    expect(names).toContain("browser_snapshot");
    expect(names).toContain("browser_click");
    expect(names).toContain("browser_click_at");

    const result = JSON.parse(await withBrowser.execute("browser_open", { url: "localhost:5173" })) as Record<string, unknown>;
    expect(result.action).toBe("open");
    expect(result.mode).toBe("background");
    expect(result.url).toBe("http://localhost:5173/");

    const searchResult = JSON.parse(await withBrowser.execute("browser_open", { url: "service now developer portal" })) as Record<
      string,
      unknown
    >;
    expect(searchResult.url).toBe("https://www.google.com/search?q=service+now+developer+portal");

    const visibleResult = JSON.parse(await withBrowser.execute("browser_open", { url: "localhost:5173", mode: "visible" })) as Record<
      string,
      unknown
    >;
    expect(visibleResult.mode).toBe("visible");

    const followUpResult = JSON.parse(await withBrowser.execute("browser_snapshot", {})) as Record<string, unknown>;
    expect(followUpResult.mode).toBe("visible");

    const coordinateResult = JSON.parse(await withBrowser.execute("browser_click_at", { x: 24, y: 48 })) as Record<string, unknown>;
    expect(coordinateResult.action).toBe("click_at");
    expect(coordinateResult.mode).toBe("visible");
  });

  it("allows browser actions in readonly mode without prompting", async () => {
    const browser = createFakeBrowser();
    let prompted = false;
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("readonly", async () => {
        prompted = true;
        return false;
      }),
      browser
    });

    await expect(registry.execute("browser_open", { url: "https://example.com" })).resolves.toMatch(/"action": "open"/);
    await expect(registry.execute("browser_click", { target: "Sign in" })).resolves.toMatch(/"action": "click"/);
    await expect(registry.execute("browser_type", { target: "Search", text: "ServiceNow", submit: true })).resolves.toMatch(/"action": "type"/);
    expect(prompted).toBe(false);
  });

  it("honors workspace browser control overrides", async () => {
    const browser = createFakeBrowser();
    let prompted = false;
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager(
        "readonly",
        async () => {
          prompted = true;
          return false;
        },
        { browser_control: "deny" }
      ),
      browser
    });

    await expect(registry.execute("browser_open", { url: "https://example.com" })).resolves.toMatch(/workspace policy override/);
    expect(prompted).toBe(false);
  });

  it("rejects browser file URLs that escape the workspace through symlinks", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-browser-file-"));
    try {
      const workspace = path.join(tempDir, "workspace");
      const outside = path.join(tempDir, "outside");
      await mkdir(workspace);
      await mkdir(outside);
      await symlink(outside, path.join(workspace, "link"));
      const browser = createFakeBrowser();
      const registry = createToolRegistry({
        workspaceRoot: workspace,
        approvals: new ApprovalManager("trusted", async () => true),
        browser
      });

      const url = pathToFileURL(path.join(workspace, "link", "secret.txt")).toString();
      await expect(registry.execute("browser_open", { url })).resolves.toMatch(/symlink/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires approval before web search leaves the machine", async () => {
    let prompted = false;
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("readonly", async () => {
        prompted = true;
        return false;
      })
    });

    await expect(registry.execute("web_search", { query: "sensitive private query" })).resolves.toMatch(/denied network/);
    expect(prompted).toBe(true);
  });

  it("enforces workspace read policy overrides for repo read tools", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-read-policy-"));
    try {
      await writeFile(path.join(tempDir, "README.md"), "hello\n", "utf8");
      let prompted = false;
      const registry = createToolRegistry({
        workspaceRoot: tempDir,
        approvals: new ApprovalManager(
          "trusted",
          async () => {
            prompted = true;
            return false;
          },
          { read_repo: "deny" }
        )
      });

      await expect(registry.execute("list", { path: "." })).resolves.toMatch(/workspace policy override/);
      await expect(registry.execute("read", { path: "README.md" })).resolves.toMatch(/workspace policy override/);
      await expect(registry.execute("search", { query: "hello", path: "." })).resolves.toMatch(/workspace policy override/);
      await expect(registry.execute("git_status", {})).resolves.toMatch(/workspace policy override/);
      expect(prompted).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces workspace scope rules for paths, patch targets, and network destinations", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-scope-policy-"));
    try {
      await mkdir(path.join(tempDir, "secrets"));
      await writeFile(path.join(tempDir, "secrets", "token.txt"), "secret\n", "utf8");
      let prompted = false;
      const registry = createToolRegistry({
        workspaceRoot: tempDir,
        approvals: new ApprovalManager(
          "trusted",
          async () => {
            prompted = true;
            return true;
          },
          {},
          undefined,
          {
            blockedPathPrefixes: ["secrets"],
            allowedNetworkDomains: ["api.tavily.com"]
          }
        )
      });

      await expect(registry.execute("read", { path: "secrets/token.txt" })).resolves.toMatch(/workspace scope rule blocks path/);
      await expect(
        registry.execute("apply_patch", {
          diff: ["--- a/secrets/token.txt", "+++ b/secrets/token.txt", "@@ -1 +1 @@", "-secret", "+updated"].join("\n")
        })
      ).resolves.toMatch(/workspace scope rule blocks path/);
      await expect(registry.execute("web_search", { query: "current docs" })).resolves.toMatch(
        /workspace network allowlist blocks www\.bing\.com/
      );
      expect(prompted).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces MCP server scope rules while listing only allowed server tools", async () => {
    const scopePolicyRules = { allowedMcpServers: ["allowed"] };
    let prompts = 0;
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager(
        "trusted",
        async () => {
          prompts += 1;
          return true;
        },
        {},
        undefined,
        scopePolicyRules
      ),
      mcpServers: {
        allowed: {
          command: "definitely-not-started-allowed",
          args: [],
          env: {},
          disabled: false
        },
        blocked: {
          command: "definitely-not-started-blocked",
          args: [],
          env: {},
          disabled: false
        }
      },
      scopePolicyRules
    });

    const listResult = await registry.execute("mcp_list_tools", {});
    expect(prompts).toBe(1);
    expect(listResult).toContain('"server": "allowed"');
    expect(listResult).not.toContain('"server": "blocked"');

    await expect(registry.execute("mcp_call_tool", { server: "blocked", tool: "read", args: {} })).resolves.toMatch(
      /workspace MCP server allowlist blocks blocked/
    );
    expect(prompts).toBe(1);
  });

  it("enforces browser target-class scope rules for navigation and browser reads", async () => {
    const browser = createFakeBrowser();
    const scopePolicyRules: WorkspaceScopePolicyRules = { allowedBrowserTargetClasses: ["background", "local"] };
    let prompted = false;
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager(
        "trusted",
        async () => {
          prompted = true;
          return true;
        },
        {},
        undefined,
        scopePolicyRules
      ),
      browser,
      scopePolicyRules
    });

    await expect(registry.execute("browser_open", { url: "localhost:5173" })).resolves.toMatch(/"action": "open"/);
    await expect(registry.execute("browser_open", { url: "https://example.com" })).resolves.toMatch(
      /workspace browser target-class allowlist blocks public/
    );
    await expect(registry.execute("browser_screenshot", { mode: "visible" })).resolves.toMatch(
      /workspace browser target-class allowlist blocks visible/
    );
    expect(prompted).toBe(false);
  });

  it("can prompt before repo reads when workspace policy requires it", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-read-prompt-"));
    try {
      await writeFile(path.join(tempDir, "README.md"), "hello\n", "utf8");
      const prompts: string[] = [];
      const registry = createToolRegistry({
        workspaceRoot: tempDir,
        approvals: new ApprovalManager(
          "trusted",
          async (message) => {
            prompts.push(message);
            return true;
          },
          { read_repo: "prompt" }
        )
      });

      await expect(registry.execute("read", { path: "README.md" })).resolves.toBe("hello\n");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Repo read: read file");
      expect(prompts[0]).toContain("Path: README.md");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires review before large direct patches in trusted mode", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-large-patch-"));
    const lineCount = Math.ceil(DIRECT_EDIT_REVIEW_CHANGED_LINE_THRESHOLD / 2);
    const original = Array.from({ length: lineCount }, (_value, index) => `old-${index}`);
    const updated = Array.from({ length: lineCount }, (_value, index) => `new-${index}`);
    const diff = largeReplacementDiff("README.md", original, updated);
    const prompts: string[] = [];
    try {
      await writeFile(path.join(tempDir, "README.md"), `${original.join("\n")}\n`, "utf8");
      const registry = createToolRegistry({
        workspaceRoot: tempDir,
        approvals: new ApprovalManager("trusted", async (message) => {
          prompts.push(message);
          return true;
        })
      });

      await registry.execute("read", { path: "README.md" });
      await expect(registry.execute("apply_patch", { diff })).resolves.toContain("Applied patch");
      await expect(readFile(path.join(tempDir, "README.md"), "utf8")).resolves.toBe(`${updated.join("\n")}\n`);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Write review:");
      expect(prompts[0]).toContain("Large direct patch");
      expect(prompts[0]).toContain(`${lineCount * 2} changed lines`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("can skip large direct edit review when another execution boundary owns review", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-worktree-patch-"));
    const lineCount = Math.ceil(DIRECT_EDIT_REVIEW_CHANGED_LINE_THRESHOLD / 2);
    const original = Array.from({ length: lineCount }, (_value, index) => `old-${index}`);
    const updated = Array.from({ length: lineCount }, (_value, index) => `new-${index}`);
    const diff = largeReplacementDiff("README.md", original, updated);
    let prompted = false;
    try {
      await writeFile(path.join(tempDir, "README.md"), `${original.join("\n")}\n`, "utf8");
      const registry = createToolRegistry({
        workspaceRoot: tempDir,
        approvals: new ApprovalManager("trusted", async () => {
          prompted = true;
          return false;
        }),
        directEditReview: false
      });

      await registry.execute("read", { path: "README.md" });
      await expect(registry.execute("apply_patch", { diff })).resolves.toContain("Applied patch");
      await expect(readFile(path.join(tempDir, "README.md"), "utf8")).resolves.toBe(`${updated.join("\n")}\n`);
      expect(prompted).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires approval before listing configured MCP tools", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("ask", async () => false),
      mcpServers: {
        fake: {
          command: "definitely-not-started",
          args: [],
          env: {},
          disabled: false
        }
      }
    });

    await expect(registry.execute("mcp_list_tools", {})).resolves.toMatch(/denied mcp/);
  });

  it("records host execution profile metadata for shell commands", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("ask", async () => true)
    });

    const result = await registry.execute("run", { command: "printf profile-ok" });
    expect(result).toContain(`executionProfile: host\nexecutionIsolation: local host process\nworkingDirectory: ${process.cwd()}`);
    expect(result).toContain("commandRisk: low");
    expect(result).toContain("commandAnalysis: low risk - commands: printf");
    expect(result).toContain("exitCode: 0\nstdout:\nprofile-ok");
  });

  it("runs structured argv commands without shell parsing", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("ask", async () => true)
    });

    const result = await registry.execute("run", {
      argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", "argv-ok && echo shell-ran"]
    });
    expect(result).toContain("commandMode: argv");
    expect(result).toContain("commandRisk: low");
    expect(result).toContain("commandAnalysis: low risk - commands: node");
    expect(result).toContain("exitCode: 0\nstdout:\nargv-ok && echo shell-ran");
    expect(result).not.toContain("shell-ran\n");
  });

  it("records timeout metadata for commands that exceed their limit", async () => {
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("ask", async () => true)
    });

    const result = await registry.execute("run", {
      argv: [process.execPath, "-e", "process.stdout.write('start'); setTimeout(() => {}, 2000)"],
      timeoutMs: 1000
    });

    expect(result).toContain("commandMode: argv");
    expect(result).toContain("timeoutMs: 1000");
    expect(result).toContain("timedOut: true");
    expect(result).toContain("signal: SIGTERM");
    expect(result).toContain("stdout:\nstart");
    expect(result).not.toContain("exitCode:");
  });

  it("rejects unconfigured command execution profiles before approval", async () => {
    let prompted = false;
    const registry = createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("ask", async () => {
        prompted = true;
        return true;
      })
    });

    await expect(registry.execute("run", { command: "printf should-not-run", executionProfile: "sandbox" })).resolves.toContain(
      "sandbox execution is not configured yet"
    );
    expect(prompted).toBe(false);
  });

  it("previews large reads without marking the whole file safe to overwrite", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-large-read-"));
    try {
      const filePath = path.join(tempDir, "large.txt");
      await writeFile(filePath, "a".repeat(30_000), "utf8");
      const registry = createRegistry(tempDir);

      const readResult = await registry.execute("read", { path: "large.txt" });
      expect(readResult.length).toBeLessThan(21_000);
      expect(readResult).toContain("[truncated]");
      await expect(registry.execute("write_file", { path: "large.txt", content: "new", mode: "replace" })).resolves.toMatch(/has not been read/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("truncates broad search output before returning it to the transcript", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-search-"));
    try {
      await writeFile(path.join(tempDir, "matches.txt"), Array.from({ length: 5000 }, (_, index) => `needle ${index}`).join("\n"), "utf8");
      const registry = createRegistry(tempDir);

      const result = await registry.execute("search", { query: "needle", path: "." });
      expect(result.length).toBeLessThanOrEqual(60_012);
      expect(result).toContain("[truncated]");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports an empty MCP configuration without throwing", async () => {
    const registry = createRegistry();
    const result = await registry.execute("mcp_list_tools", {});

    expect(result).toBe("No MCP servers configured.");
  });

  it("returns current date/time from the system clock", async () => {
    const registry = createRegistry();
    const result = JSON.parse(await registry.execute("current_datetime", {})) as Record<string, unknown>;

    expect(result.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.localTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(result.utc).toEqual(expect.any(String));
    expect(result.timeZone).toEqual(expect.any(String));
    expect(result.utcOffset).toMatch(/^(?:[+-]\d{2}:\d{2}|GMT.*)$/);
  });

  it("returns timezone-level location without network or precise location lookup", async () => {
    const registry = createRegistry();
    const result = JSON.parse(await registry.execute("current_location", {})) as Record<string, unknown>;

    expect(result.timeZone).toEqual(expect.any(String));
    expect(result.source).toBe("system_timezone");
    expect(result.precision).toBe("timezone");
    expect(result.note).toContain("GPS, IP lookup, and network location were not used");
  });

  it("lists and reads global skills", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-skills-"));
    const previousSkillsHome = process.env.ARIVU_SKILLS_HOME;
    try {
      const skillsHome = path.join(tempDir, "global-skills");
      process.env.ARIVU_SKILLS_HOME = skillsHome;
      const skillDir = path.join(skillsHome, "fix-tests");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        "# Fix Tests\ndescription: Debug and fix failing tests.\n\nRun the focused test first.\n",
        "utf8"
      );

      const registry = createRegistry(tempDir);
      const result = await registry.execute("list_skills", {});
      const content = await registry.execute("read_skill", { name: "fix-tests" });

      expect(result).toContain("fix-tests: Debug and fix failing tests.");
      expect(result).toContain("fix-tests/SKILL.md");
      expect(content).toContain("Path: fix-tests/SKILL.md");
      expect(content).toContain("Run the focused test first.");
    } finally {
      if (previousSkillsHome === undefined) {
        delete process.env.ARIVU_SKILLS_HOME;
      } else {
        process.env.ARIVU_SKILLS_HOME = previousSkillsHome;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates global skills with normalized names and rejects duplicates", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-skills-create-"));
    const skillsHome = path.join(tempDir, "global-skills");
    try {
      const skill = await createSkill(
        {
          name: "Careful Reviews",
          description: "Use for careful code review.",
          instructions: "Read the relevant files before listing findings."
        },
        skillsHome
      );
      const content = await readSkill("careful-reviews", skillsHome);

      expect(skill.name).toBe("careful-reviews");
      expect(skill.path).toBe("careful-reviews/SKILL.md");
      expect(content.title).toBe("Careful Reviews");
      expect(content.description).toBe("Use for careful code review.");
      expect(content.content).toContain("Read the relevant files before listing findings.");
      await expect(
        createSkill(
          {
            name: "Careful Reviews",
            instructions: "Duplicate."
          },
          skillsHome
        )
      ).rejects.toThrow('Skill "careful-reviews" already exists.');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createRegistry(workspaceRoot = process.cwd()) {
  return createToolRegistry({
    workspaceRoot,
    approvals: new ApprovalManager("trusted")
  });
}

function largeReplacementDiff(filePath: string, original: string[], updated: string[]) {
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${original.length} +1,${updated.length} @@`,
    ...original.flatMap((line, index) => [`-${line}`, `+${updated[index] ?? ""}`]),
    ""
  ].join("\n");
}

function createFakeBrowser(): BrowserToolController {
  let activeMode: "visible" | "background" = "background";
  const state = () => ({
    paneOpen: activeMode === "visible",
    defaultMode: "background" as const,
    activeMode,
    visible: {
      id: "visible-tab-1",
      mode: "visible" as const,
      url: activeMode === "visible" ? "http://localhost:5173/" : "",
      title: "Fake visible browser",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      activeTabId: "visible-tab-1",
      tabs: [
        {
          id: "visible-tab-1",
          url: activeMode === "visible" ? "http://localhost:5173/" : "",
          title: "Fake visible browser",
          loading: false,
          canGoBack: false,
          canGoForward: false
        }
      ]
    },
    background: {
      id: "background",
      mode: "background" as const,
      url: activeMode === "background" ? "http://localhost:5173/" : "",
      title: "Fake background browser",
      loading: false,
      canGoBack: false,
      canGoForward: false
    }
  });
  return {
    getState() {
      return state();
    },
    async open(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        url: new URL(args.url).toString(),
        title: "Fake browser"
      };
    },
    async screenshot(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        screenshotPath: "/tmp/fake-browser.png"
      };
    },
    async snapshot(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        snapshot: { text: "Fake snapshot" }
      };
    },
    async console(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        logs: []
      };
    },
    async click(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        ok: true,
        target: args.target
      };
    },
    async clickAt(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        ok: true,
        x: args.x,
        y: args.y
      };
    },
    async type(args) {
      activeMode = args.mode ?? activeMode;
      return {
        mode: activeMode,
        ok: true,
        target: args.target,
        text: args.text
      };
    }
  };
}
