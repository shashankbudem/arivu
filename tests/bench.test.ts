import { describe, expect, it } from "vitest";
import { runCodingScenario } from "../benchmarks/lib/codingRunner.js";
import { discoverScenarios } from "../benchmarks/lib/manifest.js";
import { startMockProvider } from "../benchmarks/lib/mockProvider.js";

/**
 * Bench smoke lane: proves the harness itself (spawn → env isolation → session parse → verify →
 * score) deterministically, with the LLM replaced by a scripted mock provider. Real-model runs live
 * outside CI (`npm run bench -- run <id>`); this test is what keeps the harness trustworthy forever.
 */

const FIXED_SUM_JS = `function sum(a, b) {
  return a + b;
}

function sumAll(values) {
  let total = 0;
  for (const value of values) {
    total = sum(total, value);
  }
  return total;
}

module.exports = { sum, sumAll };
`;

describe("benchmark harness", () => {
  it("runs the coding seed scenario end-to-end against a scripted provider", async () => {
    const scenario = (await discoverScenarios()).find((entry) => entry.manifest.id === "coding-fix-failing-test");
    expect(scenario).toBeDefined();

    const mock = await startMockProvider([
      // write_file refuses to replace a file the agent has not read, so the script reads first —
      // the same read-before-write discipline a real run exhibits.
      { toolCalls: [{ name: "read", arguments: { path: "sum.js" } }] },
      { toolCalls: [{ name: "write_file", arguments: { path: "sum.js", content: FIXED_SUM_JS, mode: "replace" } }] },
      { content: "Fixed the off-by-one bug in sum.js; node test.js now passes." }
    ]);

    try {
      const result = await runCodingScenario(scenario!, {
        model: "mock-model",
        baseUrl: mock.baseUrl,
        apiKey: "mock-key"
      });

      expect(result.error).toBeUndefined();
      expect(result.outcome).toBe("pass");
      expect(result.score).toBe(1);
      expect(result.metrics.exitCode).toBe(0);
      expect(result.model).toBe("mock-model");
      expect(result.metrics.toolCallCount).toBe(2);
      expect(result.metrics.toolErrorCount).toBe(0);
      expect(result.metrics.diff).toEqual({ files: 1, insertions: 1, deletions: 1 });
      expect(result.assertions.map((assertion) => assertion.passed)).toEqual([true, true]);
      expect(mock.requests.length).toBe(3);
      expect(result.sessionId).toBeTruthy();
    } finally {
      await mock.close();
    }
  }, 120_000);

  it("scores a wrong fix as fail with partial credit", async () => {
    const scenario = (await discoverScenarios()).find((entry) => entry.manifest.id === "coding-fix-failing-test");
    const mock = await startMockProvider([
      // Wrong move: the model "fixes" the test instead of the bug.
      { toolCalls: [{ name: "read", arguments: { path: "test.js" } }] },
      { toolCalls: [{ name: "write_file", arguments: { path: "test.js", content: "console.log('ok');\n", mode: "replace" } }] },
      { content: "Done." }
    ]);

    try {
      const result = await runCodingScenario(scenario!, {
        model: "mock-model",
        baseUrl: mock.baseUrl,
        apiKey: "mock-key"
      });

      expect(result.outcome).toBe("fail");
      // Gutting test.js makes `node test.js` exit 0, so exactly one assertion (test.js untouched) fails.
      expect(result.score).toBe(0.5);
      expect(result.assertions.find((assertion) => assertion.label === "test.js untouched")?.passed).toBe(false);
    } finally {
      await mock.close();
    }
  }, 120_000);
});
