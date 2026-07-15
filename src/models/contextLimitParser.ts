/**
 * Context-limit error contracts observed on real OpenAI-compatible endpoints (captured live from
 * NVIDIA NIM). Providers agree on neither wording nor status code, so this is a table rather than a
 * single regex. Each pattern's capture group is the model's maximum context, in tokens.
 *
 * Shared by two callers: the catalog probe (src/models/probe.ts), and the agent's context-length
 * retry path, which learns the real window for free whenever a live request overflows.
 */
export const CONTEXT_LIMIT_PATTERNS: RegExp[] = [
  // 400, vLLM-style: "This model's maximum context length is 524288 tokens and your request has 9 input tokens"
  /maximum context length is (\d+)\s*tokens/i,
  // 500: "Input value error: prompt is [[440009]] long while only 4096 is supported"
  /prompt is \[\[\d+\]\] long while only (\d+) is supported/i,
  // 422, pydantic-style: "body -> max_tokens Input should be less than or equal to 4096"
  /max_tokens[\s\S]{0,40}?less than or equal to (\d+)/i
];

/**
 * Extracts a model's context limit from a provider error message, or undefined when no known
 * contract matches. Never guesses: an unrecognized contract must leave the window unknown rather
 * than infer a number.
 */
export function parseContextLimit(message: string): number | undefined {
  for (const pattern of CONTEXT_LIMIT_PATTERNS) {
    const match = pattern.exec(message);
    if (match) {
      const tokens = Number(match[1]);
      if (Number.isFinite(tokens) && tokens > 0) {
        return tokens;
      }
    }
  }
  return undefined;
}
