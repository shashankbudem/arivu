import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

export type WorkspaceScaffoldOptions = {
  initGit?: boolean;
  npmPackage?: boolean;
  typescript?: boolean;
};

export function normalizeScaffoldOptions(options: WorkspaceScaffoldOptions): Required<WorkspaceScaffoldOptions> {
  return {
    initGit: Boolean(options.initGit),
    npmPackage: Boolean(options.npmPackage),
    typescript: Boolean(options.typescript)
  };
}

export async function scaffoldWorkspace(workspacePath: string, options: Required<WorkspaceScaffoldOptions>) {
  if (options.initGit) {
    const result = await execa("git", ["init"], {
      cwd: workspacePath,
      reject: false
    });
    if (result.exitCode !== 0) {
      throw new Error(`git init failed: ${result.stderr || result.stdout || "unknown error"}`);
    }
  }

  if (options.npmPackage) {
    await writeFileIfMissing(
      path.join(workspacePath, "package.json"),
      `${JSON.stringify(packageJson(workspacePath, options.typescript), null, 2)}\n`
    );
  }

  if (options.typescript) {
    await writeFileIfMissing(
      path.join(workspacePath, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            outDir: "dist"
          },
          include: ["src"]
        },
        null,
        2
      )}\n`
    );
    await mkdir(path.join(workspacePath, "src"), { recursive: true });
    await writeFileIfMissing(
      path.join(workspacePath, "src", "index.ts"),
      'export function main() {\n  console.log("Hello from Arivu.");\n}\n\nmain();\n'
    );
  }

  if (options.npmPackage || options.typescript) {
    await writeFileIfMissing(path.join(workspacePath, ".gitignore"), "node_modules\ndist\n.env\n");
  }
}

function packageJson(workspacePath: string, typescript: boolean) {
  return {
    name: packageNameFromPath(workspacePath),
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: typescript
      ? {
          dev: "tsx src/index.ts",
          build: "tsc -p tsconfig.json"
        }
      : {
          test: 'echo "No tests configured."'
        },
    ...(typescript
      ? {
          devDependencies: {
            tsx: "^4.19.2",
            typescript: "^5.7.2"
          }
        }
      : {})
  };
}

function packageNameFromPath(workspacePath: string) {
  return (
    path
      .basename(workspacePath)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "arivu-workspace"
  );
}

async function writeFileIfMissing(filePath: string, content: string) {
  try {
    await access(filePath);
    return;
  } catch {
    await writeFile(filePath, content, "utf8");
  }
}
