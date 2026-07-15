import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

export type BrowserCredentialSummary = {
  id: string;
  origin: string;
  username: string;
  label?: string;
};

export type BrowserAutofillProfile = {
  id: string;
  label: string;
  fullName?: string;
  email?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
};

export type BrowserImportedCookie = {
  url?: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
};

export type BrowserProfileImport = {
  credentials: Array<{ origin: string; username: string; password: string; label?: string }>;
  autofillProfiles: Array<Omit<BrowserAutofillProfile, "id">>;
  cookies: BrowserImportedCookie[];
};

type StoredCredential = BrowserCredentialSummary & {
  encryptedPassword: string;
};

type BrowserProfileSnapshot = {
  version: 1;
  credentials: StoredCredential[];
  autofillProfiles: BrowserAutofillProfile[];
  extensionPaths: string[];
};

const EMPTY_SNAPSHOT: BrowserProfileSnapshot = {
  version: 1,
  credentials: [],
  autofillProfiles: [],
  extensionPaths: []
};

export class BrowserProfileStore {
  private snapshot: BrowserProfileSnapshot = structuredClone(EMPTY_SNAPSHOT);

  constructor(private readonly filePath: string) {
    this.load();
  }

  credentialSummaries(): BrowserCredentialSummary[] {
    return this.snapshot.credentials.map(({ encryptedPassword: _password, ...summary }) => summary);
  }

  autofillProfiles(): BrowserAutofillProfile[] {
    return this.snapshot.autofillProfiles.map((profile) => ({ ...profile }));
  }

  extensionPaths(): string[] {
    return [...this.snapshot.extensionPaths];
  }

  addCredential(input: { origin: string; username: string; password: string; label?: string }): BrowserCredentialSummary {
    const origin = normalizeOrigin(input.origin);
    if (!input.username.trim() || !input.password) {
      throw new Error("A username and password are required.");
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this computer.");
    }
    const existing = this.snapshot.credentials.find(
      (credential) => credential.origin === origin && credential.username === input.username.trim()
    );
    const credential: StoredCredential = {
      id: existing?.id ?? randomUUID(),
      origin,
      username: input.username.trim(),
      label: input.label?.trim() || undefined,
      encryptedPassword: safeStorage.encryptString(input.password).toString("base64")
    };
    if (existing) {
      Object.assign(existing, credential);
    } else {
      this.snapshot.credentials.push(credential);
    }
    this.persist();
    const { encryptedPassword: _password, ...summary } = credential;
    return summary;
  }

  removeCredential(id: string) {
    this.snapshot.credentials = this.snapshot.credentials.filter((credential) => credential.id !== id);
    this.persist();
  }

  credentialForUrl(rawUrl: string): { username: string; password: string } | undefined {
    let origin: string;
    try {
      origin = new URL(rawUrl).origin;
    } catch {
      return undefined;
    }
    const credential = this.snapshot.credentials.find((entry) => entry.origin === origin);
    if (!credential || !safeStorage.isEncryptionAvailable()) {
      return undefined;
    }
    return {
      username: credential.username,
      password: safeStorage.decryptString(Buffer.from(credential.encryptedPassword, "base64"))
    };
  }

  addAutofillProfile(input: Omit<BrowserAutofillProfile, "id">): BrowserAutofillProfile {
    if (!input.label.trim()) {
      throw new Error("An autofill profile name is required.");
    }
    const profile: BrowserAutofillProfile = {
      id: randomUUID(),
      ...cleanAutofillProfile(input),
      label: input.label.trim()
    };
    this.snapshot.autofillProfiles.push(profile);
    this.persist();
    return { ...profile };
  }

  removeAutofillProfile(id: string) {
    this.snapshot.autofillProfiles = this.snapshot.autofillProfiles.filter((profile) => profile.id !== id);
    this.persist();
  }

  addExtensionPath(extensionPath: string) {
    const resolved = path.resolve(extensionPath);
    if (!this.snapshot.extensionPaths.includes(resolved)) {
      this.snapshot.extensionPaths.push(resolved);
      this.persist();
    }
  }

  removeExtensionPath(extensionPath: string) {
    const resolved = path.resolve(extensionPath);
    this.snapshot.extensionPaths = this.snapshot.extensionPaths.filter((entry) => entry !== resolved);
    this.persist();
  }

  importFile(filePath: string): BrowserProfileImport {
    const text = readFileSync(filePath, "utf8");
    const imported = filePath.toLowerCase().endsWith(".csv") ? parsePasswordCsv(text) : parseProfileJson(text);
    for (const credential of imported.credentials) {
      this.addCredential(credential);
    }
    for (const profile of imported.autofillProfiles) {
      this.addAutofillProfile(profile);
    }
    return imported;
  }

  private load() {
    if (!existsSync(this.filePath)) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<BrowserProfileSnapshot>;
      if (parsed.version !== 1) {
        return;
      }
      this.snapshot = {
        version: 1,
        credentials: Array.isArray(parsed.credentials) ? parsed.credentials.filter(validStoredCredential) : [],
        autofillProfiles: Array.isArray(parsed.autofillProfiles) ? parsed.autofillProfiles.filter(validAutofillProfile) : [],
        extensionPaths: Array.isArray(parsed.extensionPaths)
          ? parsed.extensionPaths.filter((entry): entry is string => typeof entry === "string")
          : []
      };
    } catch {
      this.snapshot = structuredClone(EMPTY_SNAPSHOT);
    }
  }

  private persist() {
    writeFileSync(this.filePath, JSON.stringify(this.snapshot, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}

function parseProfileJson(text: string): BrowserProfileImport {
  const value = JSON.parse(text) as Record<string, unknown>;
  const rawCredentials = arrayValue(value.credentials ?? value.passwords);
  const rawProfiles = arrayValue(value.autofillProfiles ?? value.autofill);
  const rawCookies = arrayValue(value.cookies);
  return {
    credentials: rawCredentials.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const origin = stringValue(entry.origin ?? entry.url);
      const username = stringValue(entry.username ?? entry.username_value);
      const password = stringValue(entry.password ?? entry.password_value);
      if (!origin || !username || !password) return [];
      return [{ origin, username, password, label: stringValue(entry.label ?? entry.name) || undefined }];
    }),
    autofillProfiles: rawProfiles.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const label = stringValue(entry.label ?? entry.name);
      if (!label) return [];
      return [
        cleanAutofillProfile({
          label,
          fullName: stringValue(entry.fullName ?? entry.full_name),
          email: stringValue(entry.email),
          phone: stringValue(entry.phone),
          addressLine1: stringValue(entry.addressLine1 ?? entry.address_line_1),
          addressLine2: stringValue(entry.addressLine2 ?? entry.address_line_2),
          city: stringValue(entry.city),
          region: stringValue(entry.region ?? entry.state),
          postalCode: stringValue(entry.postalCode ?? entry.postal_code),
          country: stringValue(entry.country)
        })
      ];
    }),
    cookies: rawCookies.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const name = stringValue(entry.name);
      const cookieValue = stringValue(entry.value);
      if (!name) return [];
      return [
        {
          url: stringValue(entry.url) || undefined,
          name,
          value: cookieValue,
          domain: stringValue(entry.domain) || undefined,
          path: stringValue(entry.path) || undefined,
          secure: booleanValue(entry.secure),
          httpOnly: booleanValue(entry.httpOnly ?? entry.http_only),
          expirationDate: numberValue(entry.expirationDate ?? entry.expiration_date),
          sameSite: sameSiteValue(entry.sameSite ?? entry.same_site)
        }
      ];
    })
  };
}

function parsePasswordCsv(text: string): BrowserProfileImport {
  const [header = [], ...rows] = parseCsv(text);
  const keys = header.map((value) => value.trim().toLowerCase());
  const index = (names: string[]) => keys.findIndex((key) => names.includes(key));
  const urlIndex = index(["url", "origin", "website"]);
  const usernameIndex = index(["username", "username_value", "login"]);
  const passwordIndex = index(["password", "password_value"]);
  const nameIndex = index(["name", "label"]);
  if (urlIndex < 0 || usernameIndex < 0 || passwordIndex < 0) {
    throw new Error("Password CSV must contain URL, username, and password columns.");
  }
  return {
    credentials: rows.flatMap((row) => {
      const origin = row[urlIndex]?.trim();
      const username = row[usernameIndex]?.trim();
      const password = row[passwordIndex] ?? "";
      if (!origin || !username || !password) return [];
      return [{ origin, username, password, label: row[nameIndex]?.trim() || undefined }];
    }),
    autofillProfiles: [],
    cookies: []
  };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function normalizeOrigin(rawValue: string) {
  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(rawValue.trim()) ? rawValue.trim() : `https://${rawValue.trim()}`;
  const parsed = new URL(withProtocol);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Credentials can only be saved for HTTP or HTTPS websites.");
  }
  return parsed.origin;
}

function cleanAutofillProfile<T extends Omit<BrowserAutofillProfile, "id">>(profile: T): T {
  return Object.fromEntries(
    Object.entries(profile).map(([key, value]) => [key, typeof value === "string" ? value.trim() || undefined : value])
  ) as T;
}

function validStoredCredential(value: unknown): value is StoredCredential {
  return isRecord(value) && [value.id, value.origin, value.username, value.encryptedPassword].every((entry) => typeof entry === "string");
}

function validAutofillProfile(value: unknown): value is BrowserAutofillProfile {
  return isRecord(value) && typeof value.id === "string" && typeof value.label === "string";
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sameSiteValue(value: unknown): BrowserImportedCookie["sameSite"] {
  return value === "unspecified" || value === "no_restriction" || value === "lax" || value === "strict" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
