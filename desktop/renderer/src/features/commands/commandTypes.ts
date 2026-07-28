export type SlashCommandId =
  "compact" | "summarize" | "session" | "tools" | "skills" | "files" | "browser" | "browsermodel" | "plan" | "loop" | "worktree";

export type SlashCommandDefinition = {
  id: SlashCommandId;
  command: string;
  title: string;
  description: string;
  keywords: string[];
};

export type SlashCommandEntry = SlashCommandDefinition & {
  detail?: string;
  disabledReason?: string;
};

export type CommandOutputRow = {
  label: string;
  value: string;
};

export type CommandOutput = {
  title: string;
  subtitle?: string;
  rows: CommandOutputRow[];
};
