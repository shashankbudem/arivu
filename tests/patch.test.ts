import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyUnifiedDiff, summarizePatch } from "../src/tools/patch.js";

let tempDir: string;

describe("patch tool", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-patch-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("summarizes file changes", () => {
    expect(
      summarizePatch(`--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
`)
    ).toBe("a.txt (1 hunks)");
  });

  it("applies a valid unified diff", async () => {
    const file = path.join(tempDir, "a.txt");
    await writeFile(file, "old\n", "utf8");

    await applyUnifiedDiff(
      `--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
`,
      (requested) => path.join(tempDir, requested),
      async () => {}
    );

    await expect(readFile(file, "utf8")).resolves.toBe("new\n");
  });

  it("rejects mismatched context", async () => {
    const file = path.join(tempDir, "a.txt");
    await writeFile(file, "different\n", "utf8");

    await expect(
      applyUnifiedDiff(
        `--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
`,
        (requested) => path.join(tempDir, requested),
        async () => {}
      )
    ).rejects.toThrow(/mismatch/);
  });
});

