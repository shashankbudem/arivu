import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleChatClient } from "../src/agent/OpenAICompatibleChatClient.js";
import type { ChatRequest } from "../src/agent/types.js";

describe("OpenAICompatibleChatClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to markdown when an endpoint rejects tool calling", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const observations: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response("tools are not supported", { status: 400 });
      }
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Use this Markdown plan instead."
            }
          }
        ]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask",
      onCapabilityObservation: (observation) => {
        observations.push(observation);
      }
    });
    const request: ChatRequest = {
      messages: [{ role: "user", content: "read the file" }],
      tools: [
        {
          name: "read",
          description: "Read a file.",
          parameters: { type: "object" }
        }
      ]
    };

    const response = await client.complete(request);

    expect(response.message.content).toBe("Use this Markdown plan instead.");
    expect(bodies[0]?.tools).toBeTruthy();
    expect(bodies[1]?.tools).toBeUndefined();
    expect(JSON.stringify(bodies[1]?.messages)).toContain("Tool calling is unavailable");
    expect(observations).toMatchObject([
      {
        capability: "toolCalling",
        value: "disabled",
        source: "provider_error",
        status: 400
      }
    ]);
  });

  it("omits tools immediately when provider tool calling is disabled", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Plain chat response."
            }
          }
        ]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask",
      toolCalling: "disabled"
    });

    const response = await client.complete({
      messages: [{ role: "user", content: "read the file" }],
      tools: [
        {
          name: "read",
          description: "Read a file.",
          parameters: { type: "object" }
        }
      ]
    });

    expect(response.message.content).toBe("Plain chat response.");
    expect(body?.tools).toBeUndefined();
    expect(body?.tool_choice).toBeUndefined();
    expect(JSON.stringify(body?.messages)).toContain("Tool calling is unavailable");
  });

  it("does not downgrade when provider tool calling is explicitly enabled", async () => {
    vi.stubGlobal("fetch", async () => new Response("tools are not supported", { status: 400 }));

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask",
      toolCalling: "enabled"
    });

    await expect(
      client.complete({
        messages: [{ role: "user", content: "read the file" }],
        tools: [
          {
            name: "read",
            description: "Read a file.",
            parameters: { type: "object" }
          }
        ]
      })
    ).rejects.toThrow("Model request failed (400): tools are not supported");
  });

  it("strips tool protocol history when retrying a failed tool result request", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response("failed to decode json body: json: string of object unexpected end of JSON input", { status: 500 });
      }
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "India's latest cricket update is available from the search results."
            }
          }
        ]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });
    const request: ChatRequest = {
      messages: [
        { role: "user", content: "What's latest in Indian cricket?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "web_search", arguments: { query: "Indian cricket team latest news", maxResults: 5 } }]
        },
        {
          role: "tool",
          toolCallId: "call_1",
          name: "web_search",
          content: "1. India Men's Cricket Team News | BCCI.tv"
        }
      ],
      tools: [
        {
          name: "web_search",
          description: "Search the public web.",
          parameters: { type: "object" }
        }
      ]
    };

    const response = await client.complete(request);

    expect(response.message.content).toContain("latest cricket update");
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[0]?.messages)).toContain("tool_calls");
    expect(bodies[1]?.tools).toBeUndefined();
    expect(bodies[1]?.tool_choice).toBeUndefined();
    const retryMessages = JSON.stringify(bodies[1]?.messages);
    expect(retryMessages).not.toContain('"role":"tool"');
    expect(retryMessages).not.toContain("tool_calls");
    expect(retryMessages).toContain("Local tool request");
    expect(retryMessages).toContain("Local tool result from web_search");
  });

  it("serializes empty assistant tool-call content as null", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Done."
            }
          }
        ]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    await client.complete({
      messages: [
        { role: "user", content: "read the file" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read", arguments: { path: "README.md" } }]
        },
        {
          role: "tool",
          toolCallId: "call_1",
          name: "read",
          content: "# Fixture"
        }
      ],
      tools: [
        {
          name: "read",
          description: "Read a file.",
          parameters: { type: "object" }
        }
      ]
    });

    const messages = body?.messages as Array<Record<string, unknown>>;
    expect(messages[1]?.content).toBeNull();
    expect(messages[1]?.tool_calls).toBeTruthy();
  });

  it("serializes multimodal user content with image parts", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "The image shows a diagram."
            }
          }
        ]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    await client.complete({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this." },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "low" },
              name: "diagram.png",
              mimeType: "image/png",
              size: 5
            }
          ]
        }
      ],
      tools: []
    });

    const messages = body?.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "Describe this." },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "low" } }
    ]);
    expect(JSON.stringify(messages[0]?.content)).not.toContain("diagram.png");
  });

  it("fails before sending images when provider image input is disabled", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask",
      imageInput: "disabled"
    });

    await expect(
      client.complete({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this." },
              { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "low" } }
            ]
          }
        ],
        tools: []
      })
    ).rejects.toThrow("Image input is disabled for this provider");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("observes image input as disabled when an endpoint rejects image parts", async () => {
    const observations: unknown[] = [];
    vi.stubGlobal("fetch", async () => new Response("image_url content parts are not supported by this model", { status: 400 }));

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask",
      imageInput: "auto",
      onCapabilityObservation: (observation) => {
        observations.push(observation);
      }
    });

    await expect(
      client.complete({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this." },
              { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "low" } }
            ]
          }
        ],
        tools: []
      })
    ).rejects.toThrow("image_url content parts are not supported");

    expect(observations).toMatchObject([
      {
        capability: "imageInput",
        value: "disabled",
        source: "provider_error",
        status: 400
      }
    ]);
  });

  it("falls back to markdown when an endpoint rejects empty assistant tool-call content", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message: "request: Value error, Empty content is not allowed for assistant messages",
              type: "BadRequestError",
              code: 400
            }
          }),
          { status: 400 }
        );
      }
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Answered from the plain transcript."
            }
          }
        ]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    const response = await client.complete({
      messages: [
        { role: "user", content: "read the file" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read", arguments: { path: "README.md" } }]
        },
        {
          role: "tool",
          toolCallId: "call_1",
          name: "read",
          content: "# Fixture"
        }
      ],
      tools: [
        {
          name: "read",
          description: "Read a file.",
          parameters: { type: "object" }
        }
      ]
    });

    expect(response.message.content).toBe("Answered from the plain transcript.");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.tools).toBeUndefined();
    const retryMessages = JSON.stringify(bodies[1]?.messages);
    expect(retryMessages).not.toContain("tool_calls");
    expect(retryMessages).toContain("Local tool request");
    expect(retryMessages).toContain("Local tool result from read");
  });

  it("omits empty assistant history messages from follow-up requests", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Follow-up answered."
            }
          }
        ]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "diffusiongemma-26b-a4b-it",
      trustMode: "ask"
    });

    await client.complete({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "First question" },
        { role: "assistant", content: "" },
        { role: "user", content: "Follow-up question" }
      ],
      tools: [
        {
          name: "read",
          description: "Read a file.",
          parameters: { type: "object" }
        }
      ]
    });

    const messages = body?.messages as Array<Record<string, unknown>>;
    expect(messages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "First question" },
      { role: "user", content: "Follow-up question" }
    ]);
  });

  it("omits empty assistant history messages from no-tools requests", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Follow-up answered without tools."
            }
          }
        ]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "diffusiongemma-26b-a4b-it",
      trustMode: "ask"
    });

    await client.complete({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "First question" },
        { role: "assistant", content: "" },
        { role: "user", content: "Follow-up question" }
      ],
      tools: []
    });

    const messages = body?.messages as Array<Record<string, unknown>>;
    expect(messages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "First question" },
      { role: "user", content: "Follow-up question" }
    ]);
  });

  it("omits stream false from batch and markdown fallback requests", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response("failed to decode json body: json: invalid character as false", { status: 500 });
      }
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Recovered without stream false."
            }
          }
        ]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });
    const request: ChatRequest = {
      messages: [{ role: "user", content: "latest news" }],
      tools: [
        {
          name: "web_search",
          description: "Search the public web.",
          parameters: { type: "object" }
        }
      ]
    };

    const response = await client.complete(request);

    expect(response.message.content).toBe("Recovered without stream false.");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.stream).toBeUndefined();
    expect(bodies[1]?.stream).toBeUndefined();
    expect(bodies[1]?.tools).toBeUndefined();
  });

  it("uses stream true only for streaming requests", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    await client.stream?.({ messages: [{ role: "user", content: "hello" }], tools: [] });

    expect(body?.stream).toBe(true);
  });

  it("removes raw source-line citation artifacts from assistant text", async () => {
    vi.stubGlobal("fetch", async () => {
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "India announced the squad【1†L1-L2】. Fixtures are updated【2†L3-L4】."
            }
          }
        ]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    const response = await client.complete({ messages: [{ role: "user", content: "latest news" }], tools: [] });

    expect(response.message.content).toBe("India announced the squad. Fixtures are updated.");
  });

  it("removes raw source-line citation artifacts from streamed assistant text", async () => {
    vi.stubGlobal("fetch", async () => {
      const events = [
        { choices: [{ delta: { content: "India announced the squad" } }] },
        { choices: [{ delta: { content: "【1†L1" } }] },
        { choices: [{ delta: { content: "-L2】. Fixtures are updated【2†L3-L4】." } }] }
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");

      return new Response(`${events}data: [DONE]\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });
    const streamed: string[] = [];

    const response = await client.stream?.({ messages: [{ role: "user", content: "latest news" }], tools: [] }, (event) => {
      if (event.type === "content_delta") {
        streamed.push(event.delta);
      }
    });

    expect(streamed.join("")).toBe("India announced the squad. Fixtures are updated.");
    expect(response?.message.content).toBe(streamed.join(""));
    expect(streamed.join("")).not.toContain("【");
  });

  it("recovers a provider-unparsed textual tool call from complete() content", async () => {
    vi.stubGlobal("fetch", async () => {
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content:
                'Delegating to the page agent now.\n\nLocal tool request:\n- browser_task: {\n  "instruction": "Create the catalog item",\n  "mode": "visible"\n}'
            }
          }
        ]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    const response = await client.complete({
      messages: [{ role: "user", content: "create the item" }],
      tools: [{ name: "browser_task", description: "Delegate a browser task.", parameters: { type: "object", properties: {} } }]
    });

    expect(response.message.toolCalls).toHaveLength(1);
    expect(response.message.toolCalls?.[0]).toMatchObject({
      name: "browser_task",
      arguments: { instruction: "Create the catalog item", mode: "visible" }
    });
    expect(String(response.message.content)).toBe("Delegating to the page agent now.");
  });

  it("recovers a provider-unparsed textual tool call from streamed content", async () => {
    vi.stubGlobal("fetch", async () => {
      const events = [
        { choices: [{ delta: { content: "On it.\n<tool_call>\n" } }] },
        { choices: [{ delta: { content: '{"name": "browser_state", "arguments": {}}\n</tool_call>' } }] }
      ];
      const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    const response = await client.stream?.(
      {
        messages: [{ role: "user", content: "check the browser" }],
        tools: [{ name: "browser_state", description: "Inspect browser state.", parameters: { type: "object", properties: {} } }]
      },
      () => undefined
    );

    expect(response?.message.toolCalls).toHaveLength(1);
    expect(response?.message.toolCalls?.[0]).toMatchObject({ name: "browser_state", arguments: {} });
    expect(String(response?.message.content)).toBe("On it.");
  });

  it("recovers textual tool calls when a provider answers a stream request with a batch body", async () => {
    vi.stubGlobal("fetch", async () => {
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: 'Local tool request:\n- browser_task: {\n  "instruction": "Create the item"\n}'
            }
          }
        ]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    const response = await client.stream?.(
      {
        messages: [{ role: "user", content: "create the item" }],
        tools: [{ name: "browser_task", description: "Delegate a browser task.", parameters: { type: "object", properties: {} } }]
      },
      () => undefined
    );

    expect(response?.message.toolCalls).toHaveLength(1);
    expect(response?.message.toolCalls?.[0]).toMatchObject({ name: "browser_task", arguments: { instruction: "Create the item" } });
  });

  it("retries retryable status codes with backoff and then succeeds", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
      }
      return Response.json({
        choices: [{ message: { role: "assistant", content: "Recovered after retry." } }]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    const response = await client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });

    expect(response.message.content).toBe("Recovered after retry.");
    expect(calls).toBe(2);
  });

  it("gives up after exhausting retries on retryable errors", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response("upstream unavailable", { status: 503, headers: { "Retry-After": "0" } });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask",
      maxRequestRetries: 1
    });

    await expect(client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] })).rejects.toThrow("Model request failed (503)");
    expect(calls).toBe(2);
  });

  it("does not retry non-retryable client errors", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response("nope", { status: 401 });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    await expect(client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] })).rejects.toThrow("Model request failed (401)");
    expect(calls).toBe(1);
  });

  it("parses token usage from batch responses", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        choices: [{ message: { role: "assistant", content: "Done." } }],
        usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 }
      })
    );

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    const response = await client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });

    expect(response.usage).toEqual({ promptTokens: 100, completionTokens: 25, totalTokens: 125 });
  });

  it("requests and parses streamed usage", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const events = [
        { choices: [{ delta: { content: "Answer." } }] },
        { choices: [], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } }
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      return new Response(`${events}data: [DONE]\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    const response = await client.stream?.({ messages: [{ role: "user", content: "hi" }], tools: [] });

    expect((body?.stream_options as Record<string, unknown>)?.include_usage).toBe(true);
    expect(response?.usage).toEqual({ promptTokens: 40, completionTokens: 10, totalTokens: 50 });
  });

  it("does not send a request when the signal is already aborted", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const controller = new AbortController();
    controller.abort();

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    await expect(
      client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] }, { signal: controller.signal })
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not retry when the caller aborts the request", async () => {
    let calls = 0;
    const controller = new AbortController();
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      calls += 1;
      controller.abort();
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      (init?.signal as AbortSignal | undefined)?.throwIfAborted?.();
      throw abortError;
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    await expect(
      client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] }, { signal: controller.signal })
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("strips tool protocol history from no-tools requests", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Answering from the local transcript."
            }
          }
        ]
      });
    });

    const client = new OpenAICompatibleChatClient({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });
    const request: ChatRequest = {
      messages: [
        { role: "user", content: "What's latest in Indian cricket?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "web_search", arguments: { query: "Indian cricket team latest news", maxResults: 5 } }]
        },
        {
          role: "tool",
          toolCallId: "call_1",
          name: "web_search",
          content: "1. India Men's Cricket Team News | BCCI.tv"
        }
      ],
      tools: []
    };

    await client.complete(request);

    expect(body?.tools).toBeUndefined();
    const messages = JSON.stringify(body?.messages);
    expect(messages).not.toContain('"role":"tool"');
    expect(messages).not.toContain("tool_calls");
    expect(messages).toContain("Local tool request");
    expect(messages).toContain("Local tool result from web_search");
  });
});
