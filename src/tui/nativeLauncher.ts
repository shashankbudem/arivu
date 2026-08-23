import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeClientEvent, NativeServerEvent } from "./nativeProtocol.js";

type NativeTuiProcessOptions = {
  cwd: string;
  onMessage: (event: Exclude<NativeClientEvent, { type: "hello" }>) => void | Promise<void>;
  onDisconnect?: () => void;
};

export class NativeTuiProcess {
  private server?: net.Server;
  private child?: ChildProcess;
  private socket?: Socket;
  private readonly token = randomBytes(24).toString("hex");
  private exitPromise?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private messageQueue: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(private readonly options: NativeTuiProcessOptions) {}

  async start() {
    const binary = await resolveNativeTuiBinary();
    const { server, port } = await listenOnLoopback();
    this.server = server;

    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      server.on("connection", (socket) => {
        if (this.socket) {
          socket.destroy();
          return;
        }
        socket.setNoDelay(true);
        let authenticated = false;
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          while (true) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) {
              break;
            }
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) {
              continue;
            }
            let message: NativeClientEvent;
            try {
              message = JSON.parse(line) as NativeClientEvent;
            } catch (error) {
              socket.destroy(new Error(`Invalid native TUI message: ${error instanceof Error ? error.message : String(error)}`));
              return;
            }
            if (!authenticated) {
              if (message.type !== "hello" || message.token !== this.token) {
                socket.destroy(new Error("Native TUI authentication failed."));
                return;
              }
              authenticated = true;
              this.socket = socket;
              server.close();
              if (!settled) {
                settled = true;
                resolve();
              }
              continue;
            }
            if (message.type === "hello") {
              continue;
            }
            this.messageQueue = this.messageQueue
              .then(() => this.options.onMessage(message))
              .catch((error: unknown) => {
                this.send({
                  type: "run_failed",
                  message: `Unable to handle terminal input: ${error instanceof Error ? error.message : String(error)}`
                });
              });
          }
        });
        socket.on("error", (error) => fail(error));
        socket.on("close", () => {
          if (!this.closing) {
            this.options.onDisconnect?.();
          }
        });
      });
      server.on("error", fail);
    });

    this.child = spawn(binary, ["--connect", `127.0.0.1:${port}`, "--token", this.token], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ARIVU_TUI_PARENT_PID: String(process.pid)
      },
      stdio: "inherit"
    });
    this.child.once("error", (error) => server.emit("error", error));
    this.exitPromise = new Promise((resolve) => {
      this.child?.once("exit", (code, signal) => resolve({ code, signal }));
    });
    this.child.once("exit", (code, signal) => {
      if (!this.socket && !this.closing) {
        const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
        server.close();
        // The child can exit before the socket handshake; surface that through ready.
        server.emit("error", new Error(`Native Arivu TUI exited before connecting (${detail}).`));
      }
    });

    await ready;
  }

  send(event: NativeServerEvent) {
    if (!this.socket || this.socket.destroyed) {
      return false;
    }
    this.socket.write(`${JSON.stringify(event)}\n`);
    return true;
  }

  async wait() {
    const result = await this.exitPromise;
    if (!result) {
      return;
    }
    if (!this.closing && result.code !== 0) {
      const detail = result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? "unknown"}`;
      throw new Error(`Native Arivu TUI closed unexpectedly (${detail}).`);
    }
  }

  close() {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.send({ type: "quit" });
    this.socket?.end();
    this.server?.close();
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      const child = this.child;
      const forceClose = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
      }, 1_000);
      forceClose.unref();
    }
  }
}

async function resolveNativeTuiBinary() {
  const executable = process.platform === "win32" ? "arivu-tui.exe" : "arivu-tui";
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const platformDirectory = `${process.platform}-${process.arch}`;
  const candidates = [
    process.env.ARIVU_TUI_BINARY,
    path.join(moduleDirectory, "native", platformDirectory, executable),
    path.resolve(moduleDirectory, "..", "native", platformDirectory, executable),
    path.resolve(moduleDirectory, "..", "..", "native", "arivu-tui", "target", "release", executable),
    path.resolve(process.cwd(), "native", "arivu-tui", "target", "release", executable)
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next development or packaged location.
    }
  }
  throw new Error(
    [
      "The native Arivu TUI binary is missing.",
      "Build it with `npm run native:tui:build`, then launch `arivu` again.",
      `Checked: ${candidates.join(", ")}`
    ].join("\n")
  );
}

function listenOnLoopback(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate the native TUI loopback channel."));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}
