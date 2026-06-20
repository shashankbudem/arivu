import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { appDataDir } from "../config.js";
import type { AgentSession } from "../agent/types.js";

const TextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string()
});

const ImagePartSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(["auto", "low", "high"]).optional()
  }),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional()
});

const ContentSchema = z.union([z.string(), z.array(z.union([TextPartSchema, ImagePartSchema]))]);

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: ContentSchema,
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.unknown()
      })
    )
    .optional()
});

const SessionSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  projectRoot: z.string().nullable().optional(),
  trustMode: z.enum(["ask", "readonly", "trusted"]),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  modelMode: z.enum(["manual", "auto"]).optional(),
  selectedModel: z.string().optional(),
  selectedProviderId: z.string().optional(),
  selectedProviderName: z.string().optional(),
  modelSelectionReason: z.string().optional(),
  messages: z.array(MessageSchema),
  createdAt: z.string(),
  updatedAt: z.string()
});

export class SessionStore {
  constructor(private readonly root = path.join(appDataDir(), "sessions")) {}

  async save(session: AgentSession) {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.fileFor(session.id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }

  async load(id: string): Promise<AgentSession> {
    const raw = await readFile(this.fileFor(id), "utf8");
    return SessionSchema.parse(JSON.parse(raw)) as AgentSession;
  }

  async delete(id: string) {
    await unlink(this.fileFor(id));
  }

  async list(): Promise<AgentSession[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          const raw = await readFile(path.join(this.root, entry), "utf8");
          return SessionSchema.parse(JSON.parse(raw)) as AgentSession;
        })
    );

    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private fileFor(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error("Invalid session id.");
    }
    return path.join(this.root, `${id}.json`);
  }
}
