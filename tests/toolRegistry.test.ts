import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSkill, readSkill } from "../src/agent/skills.js";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";
import type { BrowserToolController } from "../src/tools/browserControl.js";
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

    const result = JSON.parse(await withBrowser.execute("browser_open", { url: "localhost:5173" })) as Record<string, unknown>;
    expect(result.action).toBe("open");
    expect(result.mode).toBe("background");
    expect(result.url).toBe("http://localhost:5173/");

    const visibleResult = JSON.parse(await withBrowser.execute("browser_open", { url: "localhost:5173", mode: "visible" })) as Record<
      string,
      unknown
    >;
    expect(visibleResult.mode).toBe("visible");
  });

  it("runs browser actions in readonly mode without approval prompts", async () => {
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

    const openResult = JSON.parse(await registry.execute("browser_open", { url: "https://example.com" })) as Record<string, unknown>;
    const clickResult = JSON.parse(await registry.execute("browser_click", { target: "Sign in" })) as Record<string, unknown>;
    const typeResult = JSON.parse(
      await registry.execute("browser_type", { target: "Search", text: "ServiceNow", submit: true })
    ) as Record<string, unknown>;

    expect(openResult.action).toBe("open");
    expect(clickResult.action).toBe("click");
    expect(typeResult.action).toBe("type");
    expect(prompted).toBe(false);
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

function createFakeBrowser(): BrowserToolController {
  return {
    async open(args) {
      return {
        mode: args.mode ?? "visible",
        url: new URL(args.url).toString(),
        title: "Fake browser"
      };
    },
    async screenshot(args) {
      return {
        mode: args.mode ?? "visible",
        screenshotPath: "/tmp/fake-browser.png"
      };
    },
    async snapshot(args) {
      return {
        mode: args.mode ?? "visible",
        snapshot: { text: "Fake snapshot" }
      };
    },
    async console(args) {
      return {
        mode: args.mode ?? "visible",
        logs: []
      };
    },
    async click(args) {
      return {
        mode: args.mode ?? "visible",
        ok: true,
        target: args.target
      };
    },
    async type(args) {
      return {
        mode: args.mode ?? "visible",
        ok: true,
        target: args.target,
        text: args.text
      };
    }
  };
}
