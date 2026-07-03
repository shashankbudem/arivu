import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type FilePatch = {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
};

type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
};

export function summarizePatch(diff: string): string {
  const patches = parseUnifiedDiff(diff);
  return patches.map((patch) => `${cleanPatchPath(patch.newPath)} (${patch.hunks.length} hunks)`).join(", ");
}

export function changedPathsFromDiff(diff: string): string[] {
  return parseUnifiedDiff(diff).map((patch) => cleanPatchPath(patch.newPath));
}

export async function applyUnifiedDiff(
  diff: string,
  resolvePath: (path: string) => string | Promise<string>,
  beforeWrite: (path: string) => Promise<void>
) {
  const patches = parseUnifiedDiff(diff);
  if (patches.length === 0) {
    throw new Error("Patch did not contain any file changes.");
  }

  for (const patch of patches) {
    const target = await resolvePath(cleanPatchPath(patch.newPath));
    const exists = await existsFile(target);
    if (exists) {
      await beforeWrite(target);
    }
    const original = exists ? await readFile(target, "utf8") : "";
    const updated = applyPatchToText(original, patch);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, updated, "utf8");
  }
}

export function parseUnifiedDiff(diff: string): FilePatch[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const patches: FilePatch[] = [];
  let current: FilePatch | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("--- ")) {
      const oldPath = line.slice(4).trim();
      const next = lines[index + 1];
      if (!next?.startsWith("+++ ")) {
        throw new Error("Invalid unified diff: expected +++ line after --- line.");
      }
      current = { oldPath, newPath: next.slice(4).trim(), hunks: [] };
      patches.push(current);
      index += 1;
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (!current) {
        throw new Error("Invalid unified diff: hunk found before file header.");
      }
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) {
        throw new Error(`Invalid hunk header: ${line}`);
      }
      const hunk: Hunk = {
        oldStart: Number(match[1]),
        oldCount: Number(match[2] ?? "1"),
        newStart: Number(match[3]),
        newCount: Number(match[4] ?? "1"),
        lines: []
      };
      current.hunks.push(hunk);
      for (index += 1; index < lines.length; index += 1) {
        const hunkLine = lines[index];
        if (hunkLine.startsWith("--- ") || hunkLine.startsWith("@@ ")) {
          index -= 1;
          break;
        }
        if (hunkLine === "\\ No newline at end of file") {
          continue;
        }
        if (/^[ +\-]/.test(hunkLine)) {
          hunk.lines.push(hunkLine);
          continue;
        }
        if (hunkLine === "" && index === lines.length - 1) {
          break;
        }
        throw new Error(`Invalid hunk line: ${hunkLine}`);
      }
    }
  }

  return patches;
}

function applyPatchToText(original: string, patch: FilePatch): string {
  const hasFinalNewline = original.endsWith("\n");
  const source = original.length > 0 ? original.replace(/\n$/, "").split("\n") : [];
  const output: string[] = [];
  let cursor = 0;

  for (const hunk of patch.hunks) {
    const hunkStart = Math.max(hunk.oldStart - 1, 0);
    output.push(...source.slice(cursor, hunkStart));
    cursor = hunkStart;

    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        if (source[cursor] !== text) {
          throw new Error(`Patch context mismatch in ${patch.newPath}.`);
        }
        output.push(text);
        cursor += 1;
      } else if (marker === "-") {
        if (source[cursor] !== text) {
          throw new Error(`Patch removal mismatch in ${patch.newPath}.`);
        }
        cursor += 1;
      } else if (marker === "+") {
        output.push(text);
      }
    }
  }

  output.push(...source.slice(cursor));
  return `${output.join("\n")}${hasFinalNewline || output.length > 0 ? "\n" : ""}`;
}

function cleanPatchPath(filePath: string) {
  return filePath.replace(/^(a|b)\//, "");
}

async function existsFile(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
