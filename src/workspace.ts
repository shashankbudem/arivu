import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

export type WorkspaceInfo = {
  root: string;
  gitBranch?: string;
  dirty: boolean;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  packageName?: string;
};

export async function detectWorkspace(cwd: string): Promise<WorkspaceInfo> {
  const root = await gitRoot(cwd);
  const [branch, status, packageJson] = await Promise.all([
    gitBranch(root),
    gitStatus(root),
    readPackageJson(root)
  ]);

  return {
    root,
    gitBranch: branch,
    dirty: status.trim().length > 0,
    packageManager: await detectPackageManager(root),
    packageName: packageJson?.name
  };
}

export async function gitRoot(cwd: string): Promise<string> {
  try {
    const result = await execa("git", ["rev-parse", "--show-toplevel"], { cwd });
    return result.stdout.trim();
  } catch {
    return path.resolve(cwd);
  }
}

async function gitBranch(cwd: string) {
  try {
    const result = await execa("git", ["branch", "--show-current"], { cwd });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function gitStatus(cwd: string) {
  try {
    const result = await execa("git", ["status", "--short"], { cwd });
    return result.stdout;
  } catch {
    return "";
  }
}

async function detectPackageManager(root: string): Promise<WorkspaceInfo["packageManager"]> {
  const locks = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"]
  ] as const;

  for (const [file, manager] of locks) {
    try {
      await readFile(path.join(root, file));
      return manager;
    } catch {
      // Keep checking.
    }
  }
  return undefined;
}

async function readPackageJson(root: string): Promise<{ name?: string } | undefined> {
  try {
    return JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { name?: string };
  } catch {
    return undefined;
  }
}

