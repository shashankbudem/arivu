export type ShellCommandRisk = "low" | "medium" | "high";

export type ShellCommandAnalysis = {
  risk: ShellCommandRisk;
  destructive: boolean;
  reasons: string[];
  commandHeads: string[];
  hasControlOperator: boolean;
  hasPipe: boolean;
  hasRedirect: boolean;
  summary: string;
};

type ShellToken = {
  kind: "word" | "operator";
  value: string;
};

const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[^\s]*[rR][^\s]*|-rf|-fr)\b/, reason: "recursive remove" },
  { pattern: /\bgit\s+reset\b/, reason: "git reset" },
  { pattern: /\bgit\s+clean\b/, reason: "git clean" },
  { pattern: /\bgit\s+checkout\s+(-f|--force)\b/, reason: "forced git checkout" },
  { pattern: /\bchmod\s+(-R|--recursive)\b/, reason: "recursive chmod" },
  { pattern: /\bchown\s+(-R|--recursive)\b/, reason: "recursive chown" },
  { pattern: /\bdiskutil\s+erase/i, reason: "disk erase" },
  { pattern: /\bmkfs\b/, reason: "filesystem formatting" },
  { pattern: /\bdd\s+.*\bof=\/dev\//, reason: "raw device write" },
  { pattern: />\s*\/(etc|bin|sbin|usr|System|Library|var)\b/, reason: "redirect to system path" },
  { pattern: /\b(curl|wget)\b.+\|\s*(sh|bash|zsh|python|ruby|perl|node)\b/, reason: "download piped to interpreter" }
];

const MEDIUM_RISK_HEADS = new Map<string, string>([
  ["sudo", "privileged command"],
  ["su", "privileged command"],
  ["curl", "network command"],
  ["wget", "network command"],
  ["ssh", "remote command"],
  ["scp", "remote copy"],
  ["rsync", "file sync"]
]);

const MEDIUM_RISK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|rm|update|upgrade|link|ci)\b/, reason: "package mutation" },
  { pattern: /\b(pip|pip3|brew)\s+(install|uninstall|upgrade|update)\b/, reason: "package mutation" },
  { pattern: /\bgit\s+(push|commit|merge|rebase|pull|checkout|switch|restore)\b/, reason: "git mutation possible" }
];

const COMMAND_PREFIXES = new Set(["command", "builtin", "env", "nohup", "time", "sudo"]);
const CONTROL_OPERATORS = new Set(["&&", "||", ";"]);
const PIPE_OPERATORS = new Set(["|"]);
const REDIRECT_OPERATORS = new Set([">", ">>", "<", "<<", "2>", "2>>", "&>", ">&"]);

export function analyzeShellCommand(command: string): ShellCommandAnalysis {
  const tokens = tokenizeShell(command);
  const commandHeads = commandHeadsFromTokens(tokens);
  const hasControlOperator = tokens.some((token) => token.kind === "operator" && CONTROL_OPERATORS.has(token.value));
  const hasPipe = tokens.some((token) => token.kind === "operator" && PIPE_OPERATORS.has(token.value));
  const hasRedirect = tokens.some((token) => token.kind === "operator" && REDIRECT_OPERATORS.has(token.value));
  const highRiskReasons = HIGH_RISK_PATTERNS.filter(({ pattern }) => pattern.test(command)).map(({ reason }) => reason);
  const mediumPatternReasons = MEDIUM_RISK_PATTERNS.filter(({ pattern }) => pattern.test(command)).map(({ reason }) => reason);
  const mediumReasons = [
    hasControlOperator ? "multiple shell commands" : undefined,
    hasPipe ? "shell pipeline" : undefined,
    hasRedirect ? "shell redirection" : undefined,
    ...mediumPatternReasons,
    ...commandHeads.map((head) => MEDIUM_RISK_HEADS.get(head)).filter((reason): reason is string => Boolean(reason))
  ];
  const reasons = uniqueStrings([...highRiskReasons, ...mediumReasons.filter((reason): reason is string => Boolean(reason))]);
  const risk: ShellCommandRisk = highRiskReasons.length > 0 ? "high" : reasons.length > 0 ? "medium" : "low";

  return {
    risk,
    destructive: risk === "high",
    reasons,
    commandHeads,
    hasControlOperator,
    hasPipe,
    hasRedirect,
    summary: shellCommandSummary(risk, reasons, commandHeads)
  };
}

export function isDestructiveCommand(command: string) {
  return analyzeShellCommand(command).destructive;
}

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const pushWord = () => {
    if (current) {
      tokens.push({ kind: "word", value: current });
      current = "";
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    const next = command[index + 1] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      pushWord();
      continue;
    }
    const operator = shellOperatorAt(command, index);
    if (operator) {
      pushWord();
      tokens.push({ kind: "operator", value: operator });
      index += operator.length - 1;
      continue;
    }
    if (char === "2" && (next === ">" || (next === ">" && command[index + 2] === ">"))) {
      pushWord();
      const operator = command[index + 2] === ">" ? "2>>" : "2>";
      tokens.push({ kind: "operator", value: operator });
      index += operator.length - 1;
      continue;
    }
    current += char;
  }
  pushWord();
  return tokens;
}

function shellOperatorAt(command: string, index: number) {
  for (const operator of ["&&", "||", ">>", "<<", "&>", ">&", ";", "|", ">", "<"]) {
    if (command.startsWith(operator, index)) {
      return operator;
    }
  }
  return undefined;
}

function commandHeadsFromTokens(tokens: ShellToken[]) {
  const heads: string[] = [];
  let expectingCommand = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token.kind === "operator") {
      if (CONTROL_OPERATORS.has(token.value) || PIPE_OPERATORS.has(token.value)) {
        expectingCommand = true;
      }
      continue;
    }
    if (!expectingCommand) {
      continue;
    }
    if (isEnvAssignment(token.value)) {
      continue;
    }
    const head = normalizeCommandHead(token.value);
    if (!head) {
      continue;
    }
    heads.push(head);
    if (COMMAND_PREFIXES.has(head)) {
      continue;
    }
    expectingCommand = false;
  }
  return uniqueStrings(heads);
}

function normalizeCommandHead(value: string) {
  const basename = value.split("/").filter(Boolean).at(-1) ?? value;
  return basename.trim().toLowerCase();
}

function isEnvAssignment(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function shellCommandSummary(risk: ShellCommandRisk, reasons: string[], commandHeads: string[]) {
  const parts = [
    `${risk} risk`,
    commandHeads.length > 0 ? `commands: ${commandHeads.join(", ")}` : undefined,
    reasons.length > 0 ? `signals: ${reasons.join("; ")}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.join(" - ");
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
