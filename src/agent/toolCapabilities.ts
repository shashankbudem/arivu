import type { AgentTaskRunCapability } from "./types.js";

export function capabilityForToolName(name: string): AgentTaskRunCapability {
  if (["list", "read", "search", "git_status"].includes(name)) {
    return "read_repo";
  }
  if (["apply_patch", "write_file"].includes(name)) {
    return "write_workspace";
  }
  if (name === "run") {
    return "run_command";
  }
  if (name === "web_search") {
    return "network_fetch";
  }
  if (name.startsWith("browser_")) {
    return "browser_control";
  }
  if (name.startsWith("mcp_")) {
    return "mcp_call";
  }
  if (name.endsWith("_skill") || name.includes("skills")) {
    return "skill_context";
  }
  if (name.startsWith("current_")) {
    return "local_context";
  }
  if (name.startsWith("arivu_")) {
    return "local_context";
  }
  return "unknown";
}
