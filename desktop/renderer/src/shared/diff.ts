export function splitLines(value: string) {
  if (!value) {
    return [];
  }
  return value.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

export function cleanDiffPath(value: string) {
  return value.replace(/^(a|b)\//, "");
}

export type DiffLine = {
  kind: "add" | "delete" | "context" | "meta";
  oldNumber?: number;
  newNumber?: number;
  text: string;
};

export type DiffPreview = {
  title: string;
  lines: DiffLine[];
};

export function parseUnifiedDiffPreview(diff: string): DiffPreview {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const preview: DiffPreview = { title: "patch", lines: [] };
  let oldNumber = 0;
  let newNumber = 0;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      preview.title = cleanDiffPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNumber = Number(match?.[1] ?? 0);
      newNumber = Number(match?.[2] ?? 0);
      preview.lines.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      preview.lines.push({ kind: "add", newNumber, text: line.slice(1) });
      newNumber += 1;
      continue;
    }
    if (line.startsWith("-")) {
      preview.lines.push({ kind: "delete", oldNumber, text: line.slice(1) });
      oldNumber += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      preview.lines.push({ kind: "context", oldNumber, newNumber, text: line.slice(1) });
      oldNumber += 1;
      newNumber += 1;
    }
  }

  return preview;
}
