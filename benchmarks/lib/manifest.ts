import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioManifestSchema, type Scenario } from "./types.js";

export const benchmarksRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = path.resolve(benchmarksRoot, "..");
export const scenariosRoot = path.join(benchmarksRoot, "scenarios");
export const resultsRoot = path.join(benchmarksRoot, "results");

/** Loads and validates every scenarios/<id>/scenario.json. Throws on any invalid manifest — a broken
 *  scenario should fail `bench list`, not silently vanish from `bench run all`. */
export async function discoverScenarios(): Promise<Scenario[]> {
  let entries: string[];
  try {
    entries = (await readdir(scenariosRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  const scenarios: Scenario[] = [];
  for (const name of entries) {
    const dir = path.join(scenariosRoot, name);
    const manifestPath = path.join(dir, "scenario.json");
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch {
      continue; // A directory without a manifest is scratch space, not a scenario.
    }
    const parsed = ScenarioManifestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Invalid scenario manifest ${manifestPath}: ${issue?.path.join(".")}: ${issue?.message}`);
    }
    if (parsed.data.id !== name) {
      throw new Error(`Scenario id "${parsed.data.id}" must match its directory name "${name}" (${manifestPath}).`);
    }
    if (parsed.data.kind === "coding" && !parsed.data.workspace) {
      throw new Error(`Scenario "${name}" is kind=coding but has no "workspace" block.`);
    }
    if (parsed.data.kind === "browser" && !parsed.data.browser) {
      throw new Error(`Scenario "${name}" is kind=browser but has no "browser" block.`);
    }
    scenarios.push({ manifest: parsed.data, dir });
  }
  return scenarios;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
