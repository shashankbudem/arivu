import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appDataDir, appEnv } from "../config.js";
import type { ChatMessage } from "./types.js";

const SKILLS_DIR = "skills";

export type SkillSummary = {
  name: string;
  title: string;
  description: string;
  path: string;
};

export type SkillReadResult = SkillSummary & {
  content: string;
};

export type CreateSkillInput = {
  name: string;
  description?: string;
  instructions: string;
};

export function globalSkillsDir() {
  return appEnv("SKILLS_HOME") || path.join(appDataDir(), SKILLS_DIR);
}

export async function discoverSkills(root = globalSkillsDir()): Promise<SkillSummary[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const skills = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        return readSkillFile(root, path.join(root, entry.name, "SKILL.md"), entry.name);
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        return readSkillFile(root, path.join(root, entry.name), entry.name.replace(/\.md$/i, ""));
      }
      return undefined;
    })
  );

  return skills.filter((skill): skill is SkillSummary => Boolean(skill)).sort((left, right) => left.name.localeCompare(right.name));
}

export async function readSkill(name: string, root = globalSkillsDir()): Promise<SkillReadResult> {
  const normalized = slugify(name);
  const candidates = [
    path.join(root, normalized, "SKILL.md"),
    path.join(root, `${normalized}.md`)
  ];

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, "utf8");
      return {
        ...parseSkill(content, normalized),
        path: toSkillPath(root, filePath),
        content
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Unknown skill: ${name}`);
}

export async function createSkill(input: CreateSkillInput, root = globalSkillsDir()): Promise<SkillSummary> {
  const title = input.name.trim();
  const name = slugify(title);
  const description = input.description?.trim() ?? "";
  const instructions = input.instructions.trim();
  if (!title) {
    throw new Error("Skill name is required.");
  }
  if (!instructions) {
    throw new Error("Skill instructions are required.");
  }
  try {
    await readSkill(name, root);
    throw new Error(`Skill "${name}" already exists.`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Unknown skill:")) {
      throw error;
    }
  }

  const skillDir = path.join(root, name);
  const skillPath = path.join(skillDir, "SKILL.md");
  const content = skillMarkdown({
    title,
    description,
    instructions
  });

  await mkdir(skillDir, { recursive: true });
  try {
    await writeFile(skillPath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`Skill "${name}" already exists.`);
    }
    throw error;
  }

  return {
    ...parseSkill(content, name),
    path: toSkillPath(root, skillPath)
  };
}

export function skillsSystemMessage(skills: SkillSummary[]): ChatMessage | undefined {
  if (skills.length === 0) {
    return undefined;
  }

  return {
    role: "system",
    content: [
      "Global local skills are available.",
      "Skills are stored globally, not inside the active workspace.",
      "If the user names one with $skill-name, or the task clearly matches a skill description, call read_skill before acting and follow its instructions.",
      "Available skills:",
      formatSkillList(skills)
    ].join("\n")
  };
}

export function formatSkillList(skills: SkillSummary[]): string {
  if (skills.length === 0) {
    return `No global skills found. Add Markdown skills under ${globalSkillsDir()}/<name>/SKILL.md.`;
  }

  return skills.map((skill) => `- ${skill.name}: ${skill.description || skill.title} (${skill.path})`).join("\n");
}

async function readSkillFile(root: string, filePath: string, fallbackName: string): Promise<SkillSummary | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = parseSkill(content, fallbackName);
    return {
      ...parsed,
      path: toSkillPath(root, filePath)
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function parseSkill(content: string, fallbackName: string): Omit<SkillSummary, "path"> {
  const lines = content.split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim();
  const descriptionLine = lines.find((line) => /^description\s*:/i.test(line));
  const description = descriptionLine
    ? descriptionLine.replace(/^description\s*:/i, "").trim()
    : firstParagraph(lines.filter((line) => !/^#\s+/.test(line)));
  const name = slugify(fallbackName);

  return {
    name,
    title: heading || fallbackName,
    description
  };
}

function skillMarkdown({
  title,
  description,
  instructions
}: {
  title: string;
  description: string;
  instructions: string;
}) {
  const lines = [`# ${title}`];
  if (description) {
    lines.push("", `description: ${description}`);
  }
  lines.push("", instructions, "");
  return lines.join("\n");
}

function firstParagraph(lines: string[]) {
  const paragraph: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed && paragraph.length > 0) {
      break;
    }
    if (trimmed) {
      paragraph.push(trimmed);
    }
  }
  return paragraph.join(" ");
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "skill";
}

function toSkillPath(root: string, filePath: string) {
  return path.relative(root, filePath).split(path.sep).join("/");
}
