import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Scripted OpenAI-compatible chat.completions server for the bench smoke lane (tests/bench.test.ts).
 * Serves plain JSON (no SSE) — OpenAICompatibleChatClient.stream() falls back to batch parsing when
 * the content-type is not text/event-stream, so the real client path is still exercised.
 */

export type MockTurn = {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: unknown }>;
};

export type MockProvider = {
  baseUrl: string;
  /** Raw JSON request bodies received, in order. */
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
};

export async function startMockProvider(script: MockTurn[]): Promise<MockProvider> {
  const turns = [...script];
  const requests: Array<Record<string, unknown>> = [];

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (!request.url?.endsWith("/chat/completions")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `unexpected path ${request.url}` } }));
        return;
      }
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
      } catch {
        requests.push({});
      }
      const turn = turns.shift();
      if (!turn) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "mock script exhausted" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `mock-${requests.length}`,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              finish_reason: turn.toolCalls ? "tool_calls" : "stop",
              message: {
                role: "assistant",
                content: turn.content ?? (turn.toolCalls ? null : ""),
                tool_calls: turn.toolCalls?.map((call, index) => ({
                  id: `call-${requests.length}-${index}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) }
                }))
              }
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        })
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}
