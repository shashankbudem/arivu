import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";

export type McpServersConfig = AppConfig["mcpServers"];

const MCP_TIMEOUT_MS = 30_000;

export async function listMcpTools(servers: McpServersConfig | undefined) {
  const enabled = enabledServers(servers);
  if (enabled.length === 0) {
    return "No MCP servers configured.";
  }

  const results = await Promise.all(
    enabled.map(async ([serverName, server]) => {
      try {
        const result = await withMcpClient(server, (client) => client.listTools({}, { timeout: MCP_TIMEOUT_MS }));
        return {
          server: serverName,
          tools: result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema
          }))
        };
      } catch (error) {
        return {
          server: serverName,
          error: error instanceof Error ? error.message : String(error),
          tools: []
        };
      }
    })
  );

  return JSON.stringify(results, null, 2);
}

export async function callMcpTool(
  servers: McpServersConfig | undefined,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
) {
  const server = servers?.[serverName];
  if (!server || server.disabled) {
    throw new Error(`MCP server is not configured or is disabled: ${serverName}`);
  }

  const result = await withMcpClient(server, (client) =>
    client.callTool({ name: toolName, arguments: args }, undefined, { timeout: MCP_TIMEOUT_MS })
  );
  return formatMcpToolResult(result);
}

async function withMcpClient<T>(server: McpServersConfig[string], callback: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "arivu", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: stringEnv({ ...process.env, ...server.env }),
    stderr: "pipe"
  });

  try {
    await client.connect(transport, { timeout: MCP_TIMEOUT_MS });
    return await callback(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function enabledServers(servers: McpServersConfig | undefined) {
  return Object.entries(servers ?? {}).filter(([, server]) => !server.disabled);
}

function stringEnv(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function formatMcpToolResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  if ("toolResult" in result) {
    return JSON.stringify(result.toolResult, null, 2);
  }

  const blocks = result.content.map(formatContentBlock).filter(Boolean);
  const structured = result.structuredContent ? `structuredContent:\n${JSON.stringify(result.structuredContent, null, 2)}` : "";
  const status = result.isError ? "MCP tool returned an error." : "";
  return [status, ...blocks, structured].filter(Boolean).join("\n\n") || JSON.stringify(result, null, 2);
}

function formatContentBlock(block: CallToolResult["content"][number]) {
  if (block.type === "text") {
    return block.text;
  }
  if (block.type === "image") {
    return `[image ${block.mimeType}, ${block.data.length} base64 chars]`;
  }
  if (block.type === "audio") {
    return `[audio ${block.mimeType}, ${block.data.length} base64 chars]`;
  }
  if (block.type === "resource") {
    if ("text" in block.resource) {
      return [`resource: ${block.resource.uri}`, block.resource.text].join("\n");
    }
    return `resource: ${block.resource.uri} [${block.resource.mimeType ?? "binary"} blob, ${block.resource.blob.length} base64 chars]`;
  }
  if (block.type === "resource_link") {
    return `resource_link: ${block.uri}${block.description ? `\n${block.description}` : ""}`;
  }
  return JSON.stringify(block);
}
