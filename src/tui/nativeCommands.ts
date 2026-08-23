import type { NativeCommandSpec } from "./nativeProtocol.js";

export const NATIVE_TUI_COMMANDS: NativeCommandSpec[] = [
  {
    command: "/help",
    usage: "/help",
    title: "Keyboard shortcuts",
    description: "Open the keyboard and slash-command reference.",
    aliases: []
  },
  {
    command: "/model",
    usage: "/model [model-id]",
    title: "Switch model",
    description: "Choose a model for this session, or switch directly by model ID.",
    aliases: [],
    takes_args: true
  },
  {
    command: "/status",
    usage: "/status",
    title: "Session status",
    description: "Show workspace, model, trust, session, and token information.",
    aliases: []
  },
  {
    command: "/diff",
    usage: "/diff",
    title: "Review changes",
    description: "Summarize staged, unstaged, and untracked files.",
    aliases: []
  },
  {
    command: "/activity",
    usage: "/activity",
    title: "Tool activity",
    description: "Open complete tool arguments, progress, and results.",
    aliases: ["/tools"]
  },
  {
    command: "/continue",
    usage: "/continue",
    title: "Continue session",
    description: "Resume the current saved session without adding a prompt.",
    aliases: []
  },
  {
    command: "/compact",
    usage: "/compact [recent]",
    title: "Compact context",
    description: "Compact working context while preserving the full transcript.",
    aliases: [],
    takes_args: true
  },
  {
    command: "/summarize",
    usage: "/summarize",
    title: "Summarize context",
    description: "Use the model to summarize older working context.",
    aliases: []
  },
  {
    command: "/sessions",
    usage: "/sessions [limit] [filters]",
    title: "List sessions",
    description: "List or filter saved sessions; Ctrl+S opens the picker.",
    aliases: [],
    takes_args: true
  },
  {
    command: "/resume",
    usage: "/resume <session-id>",
    title: "Resume session",
    description: "Resume a saved session by its complete id.",
    aliases: [],
    takes_args: true,
    args_required: true
  },
  {
    command: "/clear",
    usage: "/clear",
    title: "Clear terminal",
    description: "Clear the visible terminal while preserving saved history.",
    aliases: []
  },
  {
    command: "/exit",
    usage: "/exit",
    title: "Quit Arivu",
    description: "Close the terminal interface.",
    aliases: ["/quit"]
  }
];

export const NATIVE_TUI_HELP = [
  "Essentials",
  "  Enter          send a prompt; while running, queue it",
  "  ! <command>    run a local shell command in the current directory",
  "  Shift+Enter    insert a newline",
  "  Esc            close a menu or stop the active turn",
  "  Ctrl+C         clear draft, stop turn, then arm quit",
  "  Ctrl+Q         press twice to quit",
  "",
  "Prompt",
  "  Ctrl+A / E     move to start / end",
  "  Ctrl+W         delete the previous word",
  "  Up / Down      prompt history",
  "  Ctrl+P         open slash commands",
  "  /              search slash commands as you type",
  "  Tab            accept the selected slash command",
  "",
  "Visibility",
  "  Ctrl+G         open complete tool activity",
  "  Ctrl+S         open the saved-session picker",
  "  Ctrl+L         clear visible terminal output",
  "  PgUp / PgDown  move through an open activity panel",
  "",
  "Slash commands",
  ...NATIVE_TUI_COMMANDS.map((command) => `  ${command.usage.padEnd(31)} ${command.description}`)
].join("\n");
