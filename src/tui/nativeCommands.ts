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
    command: "/runs",
    usage: "/runs",
    title: "Task-run evidence",
    description: "Review persisted task status, tools, approvals, artifacts, verification, and checkpoints.",
    aliases: ["/evidence"]
  },
  {
    command: "/undo",
    usage: "/undo <task-run-id>",
    title: "Undo task run",
    description: "Revert direct-workspace files captured before an eligible task run.",
    aliases: [],
    takes_args: true,
    args_required: true
  },
  {
    command: "/steer",
    usage: "/steer <queued-prompt-id>",
    title: "Steer current run",
    description: "Apply a durable queued prompt at the next safe model boundary.",
    aliases: [],
    takes_args: true,
    args_required: true
  },
  {
    command: "/queue",
    usage: "/queue retry",
    title: "Retry queued prompts",
    description: "Deliberately retry queued prompts after a startup failure.",
    aliases: [],
    takes_args: true,
    args_required: true
  },
  {
    command: "/attach",
    usage: "/attach <file|image> <workspace-path>",
    title: "Attach context",
    description: "Attach a bounded workspace text file or image to the next prompt.",
    aliases: [],
    takes_args: true,
    args_required: true
  },
  {
    command: "/plan",
    usage: "/plan [approve|revise|cancel|run <run>]",
    title: "Plan approval",
    description: "Arm/review a plan, or run an approved plan in a new managed worktree.",
    aliases: [],
    takes_args: true
  },
  {
    command: "/loop",
    usage: "/loop [1-10|stop]",
    title: "Bounded agent loop",
    description: "Arm the next prompt for bounded iterations, or stop the current loop.",
    aliases: [],
    takes_args: true
  },
  {
    command: "/worktree",
    usage: "/worktree [run|replay|status|preview|merge|sync|continue|abort|discard|cleanup|prepare_pr|create_pr|refresh_pr|checks <run>]",
    title: "Managed task worktree",
    description: "Arm isolated worktree execution or review its lifecycle actions.",
    aliases: [],
    takes_args: true
  },
  {
    command: "/attachments",
    usage: "/attachments [list|clear|remove <number>]",
    title: "Manage attachments",
    description: "List, remove, or clear pending prompt attachments.",
    aliases: [],
    takes_args: true
  },
  {
    command: "/activity",
    usage: "/activity",
    title: "Tool activity",
    description: "Open complete tool arguments, progress, and results.",
    aliases: []
  },
  {
    command: "/tools",
    usage: "/tools [list|enable|disable <tool>]",
    title: "Tool availability",
    description: "Review or persist which agent tools are enabled for future TUI turns.",
    aliases: [],
    takes_args: true
  },
  {
    command: "/integrations",
    usage: "/integrations [list|install|enable|disable|reject|remove <id>]",
    title: "MCP integrations",
    description: "Review proposals and manage disabled-by-default MCP integrations.",
    aliases: ["/mcp"],
    takes_args: true
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
    command: "/new",
    usage: "/new",
    title: "New session",
    description: "Start a fresh session in the current workspace.",
    aliases: []
  },
  {
    command: "/rename",
    usage: "/rename <title>",
    title: "Rename session",
    description: "Set the active session title.",
    aliases: [],
    takes_args: true,
    args_required: true
  },
  {
    command: "/pin",
    usage: "/pin",
    title: "Pin session",
    description: "Toggle whether the active session is pinned.",
    aliases: []
  },
  {
    command: "/delete",
    usage: "/delete",
    title: "Delete session",
    description: "Delete the active saved session and start a new one.",
    aliases: []
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
