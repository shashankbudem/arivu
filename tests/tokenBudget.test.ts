import { describe, expect, it } from "vitest";
import { estimateTokenCount, truncateTextToTokenBudget, TRUNCATION_NOTICE } from "../desktop/renderer/src/tokenBudget.js";

describe("token budget helper", () => {
  it("estimates tokens for prose, punctuation, and newlines", () => {
    expect(estimateTokenCount("hello world")).toBeGreaterThan(0);
    expect(estimateTokenCount("hello, world!\nnext line")).toBeGreaterThan(estimateTokenCount("hello world"));
  });

  it("keeps text that fits inside the token budget", () => {
    const result = truncateTextToTokenBudget("small paste", 100);

    expect(result.text).toBe("small paste");
    expect(result.truncated).toBe(false);
  });

  it("truncates text that exceeds the token budget", () => {
    const result = truncateTextToTokenBudget("a ".repeat(200), 20);

    expect(result.text).toContain(TRUNCATION_NOTICE.trim());
    expect(result.truncated).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(25);
  });
});
