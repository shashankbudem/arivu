const destructivePatterns = [
  /\brm\s+(-[^\s]*r[^\s]*|-rf|-fr)\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+checkout\s+(-f|--force)\b/,
  /\bchmod\s+(-R|--recursive)\b/,
  /\bchown\s+(-R|--recursive)\b/,
  /\bdiskutil\s+erase/i,
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\/dev\//,
  />\s*\/(etc|bin|sbin|usr|System|Library|var)\b/
];

export function isDestructiveCommand(command: string) {
  return destructivePatterns.some((pattern) => pattern.test(command));
}

