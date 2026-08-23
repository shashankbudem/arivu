import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appDataDir } from "../../src/config.js";
import type { BrowserSessionSnapshot } from "./browserTypes.js";

const BROWSER_SESSION_FILE = "browser-session.json";

export class BrowserSessionPersistence {
  private didAttemptRestore = false;
  private restoring = false;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;

  readOnce(): BrowserSessionSnapshot | undefined {
    if (this.didAttemptRestore || !this.enabled()) {
      return undefined;
    }
    this.didAttemptRestore = true;
    try {
      const snapshot = JSON.parse(readFileSync(this.filePath(), "utf8")) as BrowserSessionSnapshot;
      return snapshot.version === 1 && Array.isArray(snapshot.tabs) ? snapshot : undefined;
    } catch {
      return undefined;
    }
  }

  whileRestoring<T>(restore: () => T): T {
    this.restoring = true;
    try {
      return restore();
    } finally {
      this.restoring = false;
    }
  }

  schedule(snapshot: () => BrowserSessionSnapshot) {
    if (!this.didAttemptRestore || this.restoring || !this.enabled()) {
      return;
    }
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.write(snapshot());
    }, 300);
  }

  persistNow(snapshot: () => BrowserSessionSnapshot) {
    if (!this.didAttemptRestore || !this.enabled()) {
      return;
    }
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    this.write(snapshot());
  }

  private write(snapshot: BrowserSessionSnapshot) {
    try {
      mkdirSync(appDataDir(), { recursive: true });
      writeFileSync(this.filePath(), JSON.stringify(snapshot), "utf8");
    } catch {
      // Session restoration is best-effort and must not block browser navigation.
    }
  }

  private filePath() {
    return path.join(appDataDir(), BROWSER_SESSION_FILE);
  }

  private enabled() {
    return process.env.ARIVU_BROWSER_SMOKE !== "1" && process.env.ARIVU_DESKTOP_SMOKE !== "1";
  }
}
