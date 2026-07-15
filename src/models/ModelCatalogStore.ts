import { appendFile, chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { appDataDir } from "../config.js";
import { CatalogEventSchema, emptyCatalog, ModelCatalogSchema, type CatalogEvent, type ModelCatalog } from "./modelCatalogSchema.js";

/**
 * Persists the model catalog. Mirrors SessionStore's proven conventions: injectable root, 0700 dir /
 * 0600 files, temp-file + rename for atomicity, zod validation on load.
 *
 * Concurrency invariant: only the scheduled CLI (`arivu models sync`) writes; the desktop/CLI agent
 * only reads. `rename()` is atomic, so a reader never observes a partial file. If the app ever needs
 * to write, this needs a lockfile.
 *
 * Failure policy: `load()` NEVER throws. It sits on the agent's construction path, so a corrupt or
 * oversized catalog must degrade to "no catalog" (which falls back to today's behavior), not break
 * startup.
 */

const CATALOG_FILE = "model-catalog.json";
const EVENTS_FILE = "model-catalog-events.jsonl";
/** Mirrors MAX_SESSION_LIST_FILE_BYTES in SessionStore. */
const MAX_CATALOG_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS_FILE_BYTES = 5 * 1024 * 1024;
/** Tombstones older than this are pruned so the file stays bounded. */
export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export class ModelCatalogStore {
  private saveCounter = 0;
  private pendingWrite: Promise<unknown> = Promise.resolve();
  private cache?: { catalog: ModelCatalog; mtimeMs: number };

  constructor(private readonly root: string = appDataDir()) {}

  get catalogPath() {
    return path.join(this.root, CATALOG_FILE);
  }

  get eventsPath() {
    return path.join(this.root, EVENTS_FILE);
  }

  /**
   * Reads the catalog, memoized against the file's mtime so the four agent-construction sites cost
   * one small parse per catalog change rather than one per agent. Returns an empty catalog on any
   * problem (missing, corrupt, oversized) — callers treat that as "unknown" and degrade.
   */
  async load(): Promise<ModelCatalog> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(this.catalogPath);
    } catch {
      return emptyCatalog();
    }
    if (this.cache && this.cache.mtimeMs === info.mtimeMs) {
      return this.cache.catalog;
    }
    if (info.size > MAX_CATALOG_FILE_BYTES) {
      console.warn(
        `[ModelCatalogStore] Ignoring "${CATALOG_FILE}": ${info.size} bytes exceeds the ${MAX_CATALOG_FILE_BYTES}-byte cap. The file is intact on disk.`
      );
      return emptyCatalog();
    }
    try {
      const parsed = ModelCatalogSchema.safeParse(JSON.parse(await readFile(this.catalogPath, "utf8")));
      if (!parsed.success) {
        console.warn(`[ModelCatalogStore] Ignoring "${CATALOG_FILE}": ${parsed.error.issues[0]?.message ?? "schema mismatch"}.`);
        return emptyCatalog();
      }
      this.cache = { catalog: parsed.data, mtimeMs: info.mtimeMs };
      return parsed.data;
    } catch (error) {
      console.warn(`[ModelCatalogStore] Ignoring "${CATALOG_FILE}": ${error instanceof Error ? error.message : String(error)}.`);
      return emptyCatalog();
    }
  }

  async save(catalog: ModelCatalog): Promise<void> {
    const next = this.pendingWrite.catch(() => undefined).then(() => this.writeCatalog(catalog));
    this.pendingWrite = next;
    await next;
  }

  private async writeCatalog(catalog: ModelCatalog) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.writeDurableAtomic(this.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    this.cache = undefined;
  }

  /** Appends change events. O_APPEND writes of a single small line are atomic on POSIX. */
  async appendEvents(events: CatalogEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.rotateEventsIfNeeded();
    const lines = events.map((event) => `${JSON.stringify(event)}\n`).join("");
    await appendFile(this.eventsPath, lines, { encoding: "utf8", mode: 0o600 });
  }

  async readEvents(limit = 100): Promise<CatalogEvent[]> {
    try {
      const raw = await readFile(this.eventsPath, "utf8");
      const parsed = raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return CatalogEventSchema.safeParse(JSON.parse(line));
          } catch {
            return undefined;
          }
        })
        .filter((result): result is { success: true; data: CatalogEvent } => Boolean(result?.success))
        .map((result) => result.data);
      return parsed.slice(-limit).reverse();
    } catch {
      return [];
    }
  }

  private async rotateEventsIfNeeded() {
    try {
      const info = await stat(this.eventsPath);
      if (info.size > MAX_EVENTS_FILE_BYTES) {
        await rename(this.eventsPath, `${this.eventsPath}.1`);
      }
    } catch {
      // No events file yet, or rotation failed — appending is still safe.
    }
  }

  private async writeDurableAtomic(file: string, contents: string) {
    const tmp = `${file}.${process.pid}.${(this.saveCounter += 1)}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tmp, "w", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tmp, file);
      await chmod(file, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(tmp, { force: true });
      throw error;
    }
  }
}

/** Drops tombstones whose removal is older than the retention window, keeping the file bounded. */
export function pruneTombstones(catalog: ModelCatalog, now: Date = new Date()): ModelCatalog {
  const cutoff = now.getTime() - TOMBSTONE_RETENTION_MS;
  const providers: ModelCatalog["providers"] = {};
  for (const [key, provider] of Object.entries(catalog.providers)) {
    const models: CatalogProviderModels = {};
    for (const [id, model] of Object.entries(provider.models)) {
      if (model.removedAt && Date.parse(model.removedAt) < cutoff) {
        continue;
      }
      models[id] = model;
    }
    providers[key] = { ...provider, models };
  }
  return { ...catalog, providers };
}

type CatalogProviderModels = ModelCatalog["providers"][string]["models"];
