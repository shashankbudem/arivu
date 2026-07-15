import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_CHECKPOINT_FILE_BYTES = 10 * 1024 * 1024;

export type ChangeCheckpointEntry = {
  /** Absolute path of the file the run modified. */
  path: string;
  /** Whether the file existed before the run touched it. */
  existed: boolean;
  /** Original UTF-8 content when it existed and was small enough to capture; null otherwise. */
  content: string | null;
  /** True when the original content was too large to capture, so this path cannot be reverted. */
  skipped?: boolean;
};

/**
 * Captures the pre-run state of files a run modifies so its direct edits can be undone outside a
 * worktree. Only the first modification of each path is recorded, so reverting restores the exact
 * state from before the run started.
 */
export class ChangeCheckpoint {
  private readonly entries = new Map<string, ChangeCheckpointEntry>();

  constructor(entries: ChangeCheckpointEntry[] = []) {
    for (const entry of entries) {
      this.entries.set(entry.path, entry);
    }
  }

  get size() {
    return this.entries.size;
  }

  changedPaths(): string[] {
    return Array.from(this.entries.keys());
  }

  toJSON(): ChangeCheckpointEntry[] {
    return Array.from(this.entries.values());
  }

  /** Record a file's original state before it is modified. No-op if already recorded. */
  async record(absolutePath: string): Promise<void> {
    if (this.entries.has(absolutePath)) {
      return;
    }
    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      this.entries.set(absolutePath, { path: absolutePath, existed: false, content: null });
      return;
    }
    if (info.size > MAX_CHECKPOINT_FILE_BYTES) {
      this.entries.set(absolutePath, { path: absolutePath, existed: true, content: null, skipped: true });
      return;
    }
    const content = await readFile(absolutePath, "utf8").catch(() => null);
    this.entries.set(absolutePath, { path: absolutePath, existed: true, content, skipped: content === null });
  }

  /** Restore every recorded file to its original state. Returns the paths that were reverted. */
  async revert(): Promise<string[]> {
    const reverted: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.skipped) {
        continue;
      }
      if (!entry.existed) {
        await rm(entry.path, { force: true });
        reverted.push(entry.path);
        continue;
      }
      if (entry.content !== null) {
        await mkdir(path.dirname(entry.path), { recursive: true });
        await writeFile(entry.path, entry.content, "utf8");
        reverted.push(entry.path);
      }
    }
    return reverted;
  }
}
