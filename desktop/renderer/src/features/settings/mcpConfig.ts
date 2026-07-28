import { isRecord, isStringRecord } from "../../shared/typeGuards";

export function parseMcpServersText(value: string): McpServersConfig {
  const parsed = JSON.parse(value.trim() || "{}") as unknown;
  if (!isRecord(parsed)) {
    throw new Error("MCP servers must be a JSON object.");
  }

  const servers: McpServersConfig = {};
  for (const [name, server] of Object.entries(parsed)) {
    if (!isRecord(server)) {
      throw new Error(`MCP server "${name}" must be an object.`);
    }
    if (typeof server.command !== "string" || !server.command.trim()) {
      throw new Error(`MCP server "${name}" requires a command.`);
    }
    const args = server.args === undefined ? [] : server.args;
    if (!Array.isArray(args) || !args.every((entry) => typeof entry === "string")) {
      throw new Error(`MCP server "${name}" args must be an array of strings.`);
    }
    const env = server.env === undefined ? {} : server.env;
    if (!isStringRecord(env)) {
      throw new Error(`MCP server "${name}" env must be an object of string values.`);
    }
    servers[name] = {
      command: server.command.trim(),
      args,
      env,
      disabled: typeof server.disabled === "boolean" ? server.disabled : false
    };
  }
  return servers;
}

export function uniqueMcpServerName(preferredName: string, servers: McpServersConfig) {
  const baseName = preferredName.trim().replace(/\s+/g, "-") || "proposed-tool";
  if (!(baseName in servers)) {
    return baseName;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${baseName}-${index}`;
    if (!(candidate in servers)) {
      return candidate;
    }
  }
}
