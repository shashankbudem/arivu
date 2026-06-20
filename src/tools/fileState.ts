import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

export class FileStateTracker {
  private readonly hashes = new Map<string, string>();

  async remember(path: string) {
    this.hashes.set(path, await hashFile(path));
  }

  async assertUnchanged(path: string) {
    const known = this.hashes.get(path);
    if (!known) {
      throw new Error(`Refusing to overwrite ${path}; file has not been read by the agent.`);
    }
    const current = await hashFile(path);
    if (current !== known) {
      throw new Error(`Refusing to overwrite ${path}; file changed since the agent last read it.`);
    }
  }
}

async function hashFile(path: string) {
  const data = await readFile(path);
  return crypto.createHash("sha256").update(data).digest("hex");
}

