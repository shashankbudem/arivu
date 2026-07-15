import { access, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appDataDir } from "../config.js";

/**
 * launchd LaunchAgent for the daily catalog sync.
 *
 * launchd (not cron) because it runs with Arivu closed and fires a missed StartCalendarInterval on
 * wake — a laptop is rarely awake at 07:00, and cron would simply skip the day. The plist is
 * generated at install time rather than committed, because it must embed absolute paths to this
 * machine's node and dist/cli.js.
 */

export const LAUNCH_AGENT_LABEL = "com.arivu.model-catalog";
export const SYNC_HOUR = 7;
export const SYNC_MINUTE = 0;

export function launchAgentPath(homeDir: string = os.homedir()) {
  return path.join(homeDir, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

export function logPath() {
  return path.join(appDataDir(), "logs", "model-catalog.log");
}

export function renderLaunchAgentPlist(options: { nodePath: string; cliPath: string; logFile: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.nodePath)}</string>
    <string>${escapeXml(options.cliPath)}</string>
    <string>models</string>
    <string>sync</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${SYNC_HOUR}</integer>
    <key>Minute</key>
    <integer>${SYNC_MINUTE}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.logFile)}</string>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export type InstallResult = { plistPath: string; nodePath: string; cliPath: string; logFile: string; bootstrapCommand: string };

/**
 * Writes the LaunchAgent. Fails loudly when dist/cli.js is missing: a plist pointing at a path that
 * doesn't exist would fail silently every morning forever.
 */
export async function installLaunchAgent(options: { cliPath: string; nodePath?: string; homeDir?: string }): Promise<InstallResult> {
  const cliPath = path.resolve(options.cliPath);
  try {
    await access(cliPath);
  } catch {
    throw new Error(`Cannot schedule: ${cliPath} does not exist. Run "npm run build" first.`);
  }
  const nodePath = options.nodePath ?? process.execPath;
  const logFile = logPath();
  const plistPath = launchAgentPath(options.homeDir);

  await mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(plistPath), { recursive: true });
  await writeFile(plistPath, renderLaunchAgentPlist({ nodePath, cliPath, logFile }), { encoding: "utf8", mode: 0o644 });

  return {
    plistPath,
    nodePath,
    cliPath,
    logFile,
    bootstrapCommand: `launchctl bootstrap gui/$(id -u) ${plistPath}`
  };
}

export async function uninstallLaunchAgent(homeDir?: string): Promise<{ plistPath: string; bootoutCommand: string }> {
  const plistPath = launchAgentPath(homeDir);
  await rm(plistPath, { force: true });
  return { plistPath, bootoutCommand: `launchctl bootout gui/$(id -u)/${LAUNCH_AGENT_LABEL}` };
}

export async function launchAgentInstalled(homeDir?: string): Promise<boolean> {
  try {
    await access(launchAgentPath(homeDir));
    return true;
  } catch {
    return false;
  }
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
