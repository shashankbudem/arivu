import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const manifest = path.join(root, "native", "arivu-tui", "Cargo.toml");

export async function runCargo(args) {
  const cargo = await resolveCargo();
  await run(cargo, args, {
    ...process.env,
    PATH: `${path.dirname(cargo)}${path.delimiter}${process.env.PATH ?? ""}`
  });
}

async function resolveCargo() {
  const candidates = [
    process.env.CARGO,
    "cargo",
    process.platform === "darwin" ? "/opt/homebrew/opt/rustup/bin/cargo" : undefined,
    process.platform === "darwin" ? "/usr/local/opt/rustup/bin/cargo" : undefined,
    process.env.HOME ? path.join(process.env.HOME, ".cargo", "bin", executableName("cargo")) : undefined
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "cargo") {
      if (await commandWorks(candidate)) {
        return candidate;
      }
      continue;
    }
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  throw new Error("Rust/Cargo is required to build Arivu's native TUI. Install Rust 1.92 with rustup, then retry.");
}

function commandWorks(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}).`));
    });
  });
}

function executableName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}
