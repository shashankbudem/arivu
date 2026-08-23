import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { manifest, root, runCargo } from "./native-tui-cargo.mjs";

const executable = process.platform === "win32" ? "arivu-tui.exe" : "arivu-tui";
const source = path.join(root, "native", "arivu-tui", "target", "release", executable);
const legalDirectory = path.join(root, "native", "arivu-tui");
const destinationDirectory = path.join(root, "dist", "native", `${process.platform}-${process.arch}`);
const destination = path.join(destinationDirectory, executable);

await runCargo(["build", "--release", "--locked", "--manifest-path", manifest]);
await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);
await Promise.all(
  ["LICENSE", "NOTICE"].map((filename) => copyFile(path.join(legalDirectory, filename), path.join(destinationDirectory, filename)))
);
if (process.platform !== "win32") {
  await chmod(destination, 0o755);
}
process.stdout.write(`Staged native TUI: ${path.relative(root, destination)}\n`);
