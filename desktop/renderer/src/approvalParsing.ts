export type SideBySideRow = {
  kind: "add" | "delete" | "context" | "change" | "meta";
  oldNumber?: number;
  newNumber?: number;
  left?: string;
  right?: string;
  label?: string;
};

export type SideBySideDiff = {
  title: string;
  rows: SideBySideRow[];
};

export type ApprovalView =
  | {
      type: "shell";
      destructive: boolean;
      mode?: "shell" | "argv";
      command: string;
      cwd?: string;
      executable: string;
      rest: string;
      warnings: string[];
    }
  | {
      type: "write";
      destructive: boolean;
      summary: string;
      diff?: SideBySideDiff;
    }
  | {
      type: "browser";
      destructive: boolean;
      action: string;
      target: string;
      mode?: BrowserMode;
    }
  | {
      type: "network";
      destructive: boolean;
      summary: string;
      destination?: string;
      query?: string;
    }
  | {
      type: "unknown";
      message: string;
    };

// Build the approval view directly from the structured request the main process now sends, so the UI
// no longer depends on parsing the human-readable text (which stays as a fallback).
export function approvalViewFromRequest(request: ApprovalPromptRequest): ApprovalView | undefined {
  switch (request.actionType) {
    case "write":
      return {
        type: "write",
        destructive: request.risky,
        summary: request.changePreview?.summary ?? request.changePreview?.title ?? request.summary,
        diff: sideBySideFromChangePreview(request.changePreview)
      };
    case "shell": {
      const command = request.scope?.value ?? request.summary;
      const [executable, ...rest] = tokenizeCommand(command);
      return {
        type: "shell",
        destructive: request.risky,
        mode: request.scope?.detail === "argv" || request.scope?.detail === "shell" ? request.scope.detail : undefined,
        command,
        cwd: undefined,
        executable: executable ?? command,
        rest: rest.join(" "),
        warnings: detectCommandWarnings(command)
      };
    }
    case "network":
      return {
        type: "network",
        destructive: request.risky,
        summary: request.summary,
        destination: request.scope?.value,
        query: request.scope?.kind === "query" ? request.scope.value : request.scope?.detail
      };
    case "browser":
      return {
        type: "browser",
        destructive: request.risky,
        action: request.summary,
        target: request.scope?.value ?? "",
        mode: undefined
      };
    default:
      // read / mcp: the text view is simple and robust; let the caller fall back to it.
      return undefined;
  }
}

function sideBySideFromChangePreview(preview: ApprovalPromptRequest["changePreview"]): SideBySideDiff | undefined {
  if (!preview) {
    return undefined;
  }
  if (preview.diff) {
    return parseUnifiedSideBySide(preview.diff);
  }
  if (preview.content !== undefined || preview.original !== undefined) {
    return buildTextSideBySide(preview.path ?? preview.title ?? "write_file", preview.original ?? "", preview.content ?? "");
  }
  return undefined;
}

export function parseApprovalMessage(message: string): ApprovalView {
  const shellMatch = /^(Destructive shell command|Shell command|Destructive structured command|Structured command):[ \t]*/m.exec(message);
  if (shellMatch) {
    const command = extractShellCommand(message, shellMatch);
    const cwd = /^Working directory:\s*(.*)$/m.exec(message)?.[1]?.trim();
    const mode = commandModeFromApprovalLabel(shellMatch[1]) ?? commandModeFromMessage(message);
    const [executable, ...rest] = tokenizeCommand(command);
    return {
      type: "shell",
      destructive: shellMatch[1].startsWith("Destructive"),
      mode,
      command,
      cwd,
      executable: executable ?? command,
      rest: rest.join(" "),
      warnings: detectCommandWarnings(command)
    };
  }

  const writeMatch = /^(Destructive write|Write):\s*(.*)$/m.exec(message);
  if (writeMatch) {
    return {
      type: "write",
      destructive: writeMatch[1].startsWith("Destructive"),
      summary: writeMatch[2].trim(),
      diff: parseApprovalDiff(message)
    };
  }

  const browserMatch = /^(Browser action|Browser read):\s*(.*)$/m.exec(message);
  if (browserMatch) {
    const mode = /^Mode:\s*(visible|background)$/m.exec(message)?.[1] as BrowserMode | undefined;
    return {
      type: "browser",
      destructive: browserMatch[1] === "Browser action",
      action: browserMatch[2].trim(),
      target: /^Target:\s*(.*)$/m.exec(message)?.[1]?.trim() ?? "",
      mode
    };
  }

  const networkMatch = /^(Network request|Network read):\s*(.*)$/m.exec(message);
  if (networkMatch) {
    return {
      type: "network",
      destructive: networkMatch[1] === "Network request",
      summary: networkMatch[2].trim(),
      destination: /^Destination:\s*(.*)$/m.exec(message)?.[1]?.trim(),
      query: /^Query:\s*([\s\S]*)$/m.exec(message)?.[1]?.trim()
    };
  }

  return { type: "unknown", message };
}

function parseApprovalDiff(message: string): SideBySideDiff | undefined {
  const diffIndex = message.indexOf("\nDiff:\n");
  if (diffIndex >= 0) {
    return parseUnifiedSideBySide(message.slice(diffIndex + "\nDiff:\n".length));
  }

  const originalIndex = message.indexOf("\nOriginal:\n");
  const proposedIndex = message.lastIndexOf("\nProposed:\n");
  if (originalIndex < 0 || proposedIndex < 0 || proposedIndex < originalIndex) {
    return undefined;
  }

  const filePath = /^Path:\s*(.*)$/m.exec(message)?.[1]?.trim() ?? "write_file";
  const original = message.slice(originalIndex + "\nOriginal:\n".length, proposedIndex);
  const proposed = message.slice(proposedIndex + "\nProposed:\n".length);
  return buildTextSideBySide(filePath, original, proposed);
}

function parseUnifiedSideBySide(diff: string): SideBySideDiff {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const result: SideBySideDiff = { title: "patch", rows: [] };
  let oldNumber = 0;
  let newNumber = 0;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      result.title = cleanDiffPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNumber = Number(match?.[1] ?? 0);
      newNumber = Number(match?.[2] ?? 0);
      result.rows.push({ kind: "meta", label: line });
      continue;
    }
    if (line.startsWith("+")) {
      result.rows.push({ kind: "add", newNumber, right: line.slice(1) });
      newNumber += 1;
      continue;
    }
    if (line.startsWith("-")) {
      result.rows.push({ kind: "delete", oldNumber, left: line.slice(1) });
      oldNumber += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      const text = line.slice(1);
      result.rows.push({ kind: "context", oldNumber, newNumber, left: text, right: text });
      oldNumber += 1;
      newNumber += 1;
    }
  }

  return result;
}

function buildTextSideBySide(title: string, original: string, proposed: string): SideBySideDiff {
  const originalLines = splitLines(original);
  const proposedLines = splitLines(proposed);
  const count = Math.max(originalLines.length, proposedLines.length);
  const rows: SideBySideRow[] = [];

  for (let index = 0; index < count; index += 1) {
    const left = originalLines[index];
    const right = proposedLines[index];
    if (left === right) {
      rows.push({ kind: "context", oldNumber: index + 1, newNumber: index + 1, left, right });
    } else if (left === undefined) {
      rows.push({ kind: "add", newNumber: index + 1, right });
    } else if (right === undefined) {
      rows.push({ kind: "delete", oldNumber: index + 1, left });
    } else {
      rows.push({ kind: "change", oldNumber: index + 1, newNumber: index + 1, left, right });
    }
  }

  return { title, rows };
}

function tokenizeCommand(command: string) {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
}

function extractShellCommand(message: string, shellMatch: RegExpExecArray) {
  const commandStart = shellMatch.index + shellMatch[0].length;
  const markerIndexes = ["\nCommand mode:", "\nCommand analysis:", "\nWorking directory:"]
    .map((marker) => message.indexOf(marker, commandStart))
    .filter((index) => index >= 0);
  const commandEnd = markerIndexes.length > 0 ? Math.min(...markerIndexes) : message.length;
  return message.slice(commandStart, commandEnd).trim();
}

function commandModeFromApprovalLabel(label: string | undefined): "shell" | "argv" | undefined {
  if (!label) {
    return undefined;
  }
  return label.toLowerCase().includes("structured") ? "argv" : label.toLowerCase().includes("shell") ? "shell" : undefined;
}

function commandModeFromMessage(message: string): "shell" | "argv" | undefined {
  const mode = /^Command mode:\s*(shell|argv)$/m.exec(message)?.[1];
  return mode === "shell" || mode === "argv" ? mode : undefined;
}

function detectCommandWarnings(command: string) {
  const checks: Array<[RegExp, string]> = [
    [/\brm\s+(-[^\s]*[rR][^\s]*|-rf|-fr)\b/, "rm -rf"],
    [/\bsudo\b/, "sudo"],
    [/\b--force\b|\s-f(\s|$)/, "--force"],
    [/(^|[^>])>\s*[^&]|\b2>\s*/, "redirect"]
  ];
  return checks.filter(([pattern]) => pattern.test(command)).map(([, label]) => label);
}

function splitLines(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

function cleanDiffPath(value: string) {
  return value.replace(/^(a|b)\//, "");
}
