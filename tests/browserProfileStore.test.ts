import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, "")
  }
}));

import { BrowserProfileStore } from "../desktop/main/browserProfileStore.js";

describe("BrowserProfileStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "arivu-browser-profile-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("encrypts saved passwords and resolves them only for the matching origin", async () => {
    const filePath = path.join(tempDir, "profile.json");
    const store = new BrowserProfileStore(filePath);

    store.addCredential({ origin: "example.com/login", username: "user@example.com", password: "top-secret" });

    expect(store.credentialSummaries()).toMatchObject([{ origin: "https://example.com", username: "user@example.com" }]);
    expect(store.credentialForUrl("https://example.com/account")).toEqual({ username: "user@example.com", password: "top-secret" });
    expect(store.credentialForUrl("https://other.example.com")).toBeUndefined();
    const persisted = await readFile(filePath, "utf8");
    expect(persisted).not.toContain("top-secret");
    expect(persisted).toContain(Buffer.from("encrypted:top-secret").toString("base64"));
  });

  it("imports Chrome-style password CSV and Arivu JSON profile data", async () => {
    const store = new BrowserProfileStore(path.join(tempDir, "profile.json"));
    const csvPath = path.join(tempDir, "passwords.csv");
    await writeFile(csvPath, 'name,url,username,password\nExample,https://example.com,user,"p,ass"\n', "utf8");

    const csvImport = store.importFile(csvPath);

    expect(csvImport.credentials).toEqual([{ origin: "https://example.com", username: "user", password: "p,ass", label: "Example" }]);

    const jsonPath = path.join(tempDir, "profile-export.json");
    await writeFile(
      jsonPath,
      JSON.stringify({
        autofillProfiles: [{ label: "Work", fullName: "Arivu User", email: "user@example.com" }],
        cookies: [{ domain: ".example.com", name: "session", value: "cookie-value", secure: true }]
      }),
      "utf8"
    );

    const jsonImport = store.importFile(jsonPath);

    expect(store.autofillProfiles()).toMatchObject([{ label: "Work", fullName: "Arivu User" }]);
    expect(jsonImport.cookies).toMatchObject([{ domain: ".example.com", name: "session", value: "cookie-value" }]);
  });

  it("persists unpacked extension paths and supports removal", () => {
    const filePath = path.join(tempDir, "profile.json");
    const extensionPath = path.join(tempDir, "extension");
    const store = new BrowserProfileStore(filePath);

    store.addExtensionPath(extensionPath);
    expect(new BrowserProfileStore(filePath).extensionPaths()).toEqual([extensionPath]);

    store.removeExtensionPath(extensionPath);
    expect(new BrowserProfileStore(filePath).extensionPaths()).toEqual([]);
  });
});
