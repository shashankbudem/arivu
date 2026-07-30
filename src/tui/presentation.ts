export type TuiLogLine = {
  kind: "user" | "assistant" | "system" | "error";
  text: string;
  time: Date;
  sequence: number;
};

export type TuiActivityLine = {
  kind: "call" | "result" | "system" | "error";
  title: string;
  detail?: string;
  time: Date;
  sequence: number;
};

export type TuiPaletteCommand = {
  command: string;
  title: string;
  description: string;
  shortcut?: string;
};

export type TuiPromptState = {
  value: string;
  cursor: number;
};

export type TuiPromptKey = {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
};

export type TuiPromptEditResult = TuiPromptState & {
  handled: boolean;
  submitted?: string;
};

export const TUI_PALETTE_COMMANDS: TuiPaletteCommand[] = [
  {
    command: "/help",
    title: "Keyboard shortcuts",
    description: "Open the complete keyboard reference.",
    shortcut: "Ctrl+X"
  },
  {
    command: "/sessions --pick",
    title: "Resume session",
    description: "Open the interactive saved-session picker.",
    shortcut: "Ctrl+S"
  },
  {
    command: "/activity",
    title: "Toggle activity",
    description: "Show or hide expanded tool arguments and results.",
    shortcut: "Ctrl+G"
  },
  {
    command: "/status",
    title: "Session status",
    description: "Show workspace, model, trust, and token information."
  },
  {
    command: "/diff",
    title: "Review changes",
    description: "Summarize staged, unstaged, and untracked files."
  },
  {
    command: "/continue",
    title: "Continue session",
    description: "Resume the current session without adding a prompt."
  },
  {
    command: "/compact",
    title: "Compact context",
    description: "Compact working context while preserving the transcript."
  },
  {
    command: "/summarize",
    title: "Summarize context",
    description: "Ask the model to summarize older working context."
  },
  {
    command: "/clear",
    title: "Clear visible transcript",
    description: "Clear only the current terminal view, not saved history."
  },
  {
    command: "/exit",
    title: "Quit Arivu",
    description: "Close the terminal interface."
  }
];

export const TUI_SHORTCUT_HELP = [
  "{bold}{cyan-fg}Essentials{/cyan-fg}{/bold}",
  "Enter       send a prompt; while running, queue it",
  "Esc         stop the active turn and preserve the draft",
  "Ctrl+C      clear a draft, stop a run, then arm quit",
  "Ctrl+Q      press twice to quit",
  "",
  "{bold}{cyan-fg}Navigation{/cyan-fg}{/bold}",
  "Tab         switch between prompt and scrollback",
  "PageUp/Down scroll the focused pane",
  "Ctrl+Home   jump to the top",
  "Ctrl+End    follow the latest entry",
  "Mouse wheel scroll; click a pane to focus it",
  "",
  "{bold}{cyan-fg}Panels and commands{/cyan-fg}{/bold}",
  "Ctrl+P      open the searchable command palette",
  "Ctrl+X      open this shortcut reference",
  "Ctrl+S      open the saved-session picker",
  "Ctrl+G      toggle expanded tool activity",
  "Shift+PgUp/Down scroll the activity drawer",
  "",
  "{gray-fg}Type / in the prompt to run Arivu slash commands.{/gray-fg}"
].join("\n");

export function escapeBlessedTags(value: string) {
  return value.replace(/[{}]/g, (character) => (character === "{" ? "{open}" : "{close}"));
}

export function formatTuiTokenCount(tokens: number) {
  const safe = Math.max(0, Math.round(tokens));
  if (safe < 1_000) {
    return String(safe);
  }
  if (safe < 10_000) {
    return `${(safe / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  if (safe < 1_000_000) {
    return `${Math.round(safe / 1_000)}K`;
  }
  if (safe < 10_000_000) {
    return `${(safe / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `${Math.round(safe / 1_000_000)}M`;
}

export function formatTuiContextUsage(usedTokens: number | undefined, totalTokens: number | undefined) {
  if (!totalTokens || totalTokens <= 0) {
    return usedTokens === undefined ? "context —" : `${formatTuiTokenCount(usedTokens)} tokens`;
  }
  return `${formatTuiTokenCount(usedTokens ?? 0)} / ${formatTuiTokenCount(totalTokens)}`;
}

export function editTuiPrompt(state: TuiPromptState, character: string | undefined, key: TuiPromptKey): TuiPromptEditResult {
  const characters = Array.from(state.value);
  const cursor = Math.max(0, Math.min(state.cursor, characters.length));
  const unchanged = (): TuiPromptEditResult => ({ value: state.value, cursor, handled: false });
  const changed = (nextCharacters: string[], nextCursor: number): TuiPromptEditResult => ({
    value: nextCharacters.join(""),
    cursor: nextCursor,
    handled: true
  });

  if (key.name === "enter" || key.name === "return") {
    return { value: "", cursor: 0, handled: true, submitted: state.value };
  }
  if (key.ctrl && key.name === "a") {
    return { value: state.value, cursor: 0, handled: true };
  }
  if (key.ctrl && key.name === "e") {
    return { value: state.value, cursor: characters.length, handled: true };
  }
  if (key.ctrl && key.name === "u") {
    return changed(characters.slice(cursor), 0);
  }
  if (key.ctrl && key.name === "w") {
    let wordStart = cursor;
    while (wordStart > 0 && /\s/.test(characters[wordStart - 1] ?? "")) {
      wordStart -= 1;
    }
    while (wordStart > 0 && !/\s/.test(characters[wordStart - 1] ?? "")) {
      wordStart -= 1;
    }
    return changed([...characters.slice(0, wordStart), ...characters.slice(cursor)], wordStart);
  }
  if (key.ctrl || key.meta) {
    return unchanged();
  }
  if (key.name === "left") {
    return { value: state.value, cursor: Math.max(0, cursor - 1), handled: true };
  }
  if (key.name === "right") {
    return { value: state.value, cursor: Math.min(characters.length, cursor + 1), handled: true };
  }
  if (key.name === "home") {
    return { value: state.value, cursor: 0, handled: true };
  }
  if (key.name === "end") {
    return { value: state.value, cursor: characters.length, handled: true };
  }
  if (key.name === "backspace") {
    if (cursor === 0) {
      return { value: state.value, cursor, handled: true };
    }
    return changed([...characters.slice(0, cursor - 1), ...characters.slice(cursor)], cursor - 1);
  }
  if (key.name === "delete") {
    if (cursor >= characters.length) {
      return { value: state.value, cursor, handled: true };
    }
    return changed([...characters.slice(0, cursor), ...characters.slice(cursor + 1)], cursor);
  }

  const printable = Array.from(character ?? "").filter((value) => {
    const codePoint = value.codePointAt(0);
    return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
  });
  if (printable.length === 0) {
    return unchanged();
  }
  return changed([...characters.slice(0, cursor), ...printable, ...characters.slice(cursor)], cursor + printable.length);
}

export function formatTuiPromptDraft(state: TuiPromptState, maxWidth: number, focused: boolean) {
  const characters = Array.from(state.value);
  const cursor = Math.max(0, Math.min(state.cursor, characters.length));
  const available = Math.max(4, Math.floor(maxWidth) - (focused ? 1 : 0));
  let start = Math.max(0, cursor - Math.floor(available * 0.72));
  const end = Math.min(characters.length, start + available);
  if (end - start < available) {
    start = Math.max(0, end - available);
  }

  const visible = characters.slice(start, end);
  if (start > 0 && visible.length > 0) {
    visible[0] = "…";
  }
  if (end < characters.length && visible.length > 0) {
    visible[visible.length - 1] = "…";
  }

  const localCursor = Math.max(0, Math.min(cursor - start, visible.length));
  const before = escapeBlessedTags(visible.slice(0, localCursor).join(""));
  const after = escapeBlessedTags(visible.slice(localCursor).join(""));
  if (!focused) {
    return `${before}${after}`;
  }
  return `${before}{bold}{cyan-fg}│{/cyan-fg}{/bold}${after}`;
}

export function formatTuiAlignedLine(left: string, right: string | undefined, width: number) {
  if (!right) {
    return left;
  }
  const available = Math.max(1, width - visibleTuiWidth(left) - visibleTuiWidth(right));
  return `${left}${" ".repeat(available)}${right}`;
}

export function filterTuiPaletteCommands(query: string, commands = TUI_PALETTE_COMMANDS) {
  const normalized = query.trim().toLowerCase().replace(/^\//, "");
  if (!normalized) {
    return commands;
  }
  return commands.filter((entry) =>
    [entry.command, entry.title, entry.description, entry.shortcut]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalized))
  );
}

export function formatTuiPaletteItems(commands: TuiPaletteCommand[]) {
  const labelWidth = Math.min(30, Math.max(12, ...commands.map((entry) => entry.command.length)));
  return commands.map((entry) => {
    const command = entry.command.padEnd(labelWidth);
    const shortcut = entry.shortcut ? `  {gray-fg}${escapeBlessedTags(entry.shortcut)}{/gray-fg}` : "";
    return `{cyan-fg}${escapeBlessedTags(command)}{/cyan-fg}  ${escapeBlessedTags(entry.title)}${shortcut}`;
  });
}

export function formatTuiTranscript(log: TuiLogLine[], activity: TuiActivityLine[], width: number, maxEntries = 160) {
  const entries = [
    ...log.map((line) => ({ type: "message" as const, sequence: line.sequence, line })),
    ...activity
      .filter((line) => !(line.kind === "system" && line.title === "workspace"))
      .map((line) => ({ type: "activity" as const, sequence: line.sequence, line }))
  ]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-maxEntries);

  if (entries.length === 0) {
    return "{gray-fg}Start by describing what you want to build.{/gray-fg}";
  }

  return entries
    .map((entry) => (entry.type === "message" ? formatTranscriptMessage(entry.line, width) : formatInlineActivity(entry.line)))
    .join("\n\n");
}

export function formatTuiActivityDrawer(activity: TuiActivityLine[], maxEntries = 100) {
  if (activity.length === 0) {
    return "{gray-fg}No tool activity yet.{/gray-fg}";
  }
  return activity
    .slice(-maxEntries)
    .map((line) => {
      const icon =
        line.kind === "call"
          ? "{yellow-fg}◇{/yellow-fg}"
          : line.kind === "result"
            ? "{green-fg}✓{/green-fg}"
            : line.kind === "error"
              ? "{red-fg}×{/red-fg}"
              : "{gray-fg}•{/gray-fg}";
      const detail = line.detail ? `\n{gray-fg}${escapeBlessedTags(truncateMultiline(line.detail, 1_800))}{/gray-fg}` : "";
      return `${icon} {bold}${escapeBlessedTags(humanizeToolName(line.title))}{/bold} {gray-fg}${formatTuiTime(line.time)}{/gray-fg}${detail}`;
    })
    .join("\n\n");
}

export function resolveTuiActivityDrawerWidth(screenWidth: number) {
  if (screenWidth < 90) {
    return "92%";
  }
  if (screenWidth < 140) {
    return "48%";
  }
  return "38%";
}

export function summarizeTuiActivityDetail(detail: string | undefined, max = 150) {
  if (!detail) {
    return "";
  }
  const compact = detail
    .replace(/\s+/g, " ")
    .replace(/^\{|\}$/g, "")
    .trim();
  if (compact.length <= max) {
    return compact;
  }
  return `${compact.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function formatTranscriptMessage(line: TuiLogLine, width: number) {
  const time = `{gray-fg}${formatTuiTime(line.time)}{/gray-fg}`;
  if (line.kind === "user") {
    const text = escapeBlessedTags(line.text);
    const usableWidth = Math.max(20, width - 8);
    const firstLine = text.split("\n", 1)[0] ?? "";
    const timeSuffix = firstLine.length + 12 < usableWidth ? `  ${time}` : "";
    return `{#252525-bg}{bold}{cyan-fg}❯{/cyan-fg}{/bold} ${text}${timeSuffix}{/}`;
  }
  if (line.kind === "assistant") {
    return `{cyan-fg}◆{/cyan-fg} {bold}Arivu{/bold}  ${time}\n${formatBlessedMarkdown(line.text)}`;
  }
  if (line.kind === "error") {
    return `{red-fg}× Error{/red-fg}  ${time}\n{red-fg}${escapeBlessedTags(line.text)}{/red-fg}`;
  }
  return `{gray-fg}• ${escapeBlessedTags(line.text)}  ${formatTuiTime(line.time)}{/gray-fg}`;
}

function formatInlineActivity(line: TuiActivityLine) {
  const label = escapeBlessedTags(humanizeToolName(line.title));
  const summary = summarizeTuiActivityDetail(line.detail);
  const detail = summary ? `  {gray-fg}${escapeBlessedTags(summary)}{/gray-fg}` : "";
  if (line.kind === "call") {
    return `{yellow-fg}◇{/yellow-fg} {bold}${label}{/bold}${detail}`;
  }
  if (line.kind === "result") {
    return `{green-fg}✓{/green-fg} {bold}${label}{/bold}${detail}`;
  }
  if (line.kind === "error") {
    return `{red-fg}×{/red-fg} {bold}${label}{/bold}${detail}`;
  }
  return `{gray-fg}• ${label}${detail}{/gray-fg}`;
}

function formatBlessedMarkdown(value: string) {
  return value
    .split("\n")
    .map((rawLine) => {
      const heading = /^(#{1,6})\s+(.+)$/.exec(rawLine);
      if (heading) {
        return `{bold}{blue-fg}${formatInlineMarkdown(heading[2] ?? "")}{/blue-fg}{/bold}`;
      }
      const bullet = /^(\s*)[-*]\s+(.+)$/.exec(rawLine);
      if (bullet) {
        return `${escapeBlessedTags(bullet[1] ?? "")}{cyan-fg}•{/cyan-fg} ${formatInlineMarkdown(bullet[2] ?? "")}`;
      }
      return formatInlineMarkdown(rawLine);
    })
    .join("\n");
}

function formatInlineMarkdown(value: string) {
  return escapeBlessedTags(value)
    .replace(/\*\*([^*\n]+)\*\*/g, "{bold}$1{/bold}")
    .replace(/`([^`\n]+)`/g, "{#9cdcfe-fg}$1{/}");
}

function humanizeToolName(value: string) {
  const normalized = value.trim().toLowerCase();
  const exact: Record<string, string> = {
    apply_patch: "Edit",
    browser_task: "Browser",
    execute_command: "Run",
    run_command: "Run",
    shell: "Run",
    read_file: "Read",
    write_file: "Write",
    web_search: "Search"
  };
  if (exact[normalized]) {
    return exact[normalized];
  }
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

function visibleTuiWidth(value: string) {
  return value.replace(/\{\/?[\w,;!#-]*}/g, "").length;
}

function formatTuiTime(date: Date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function truncateMultiline(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}
