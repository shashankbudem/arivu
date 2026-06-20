import type { AppConfig } from "../config.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

export type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  detail?: string;
};

export type DoctorReport = {
  generatedAt: string;
  checks: DoctorCheck[];
  summary: Record<DoctorStatus, number>;
};

type DoctorOptions = {
  fetcher?: FetchLike;
};

type DoctorConfig = Pick<AppConfig, "apiKey" | "tavilyApiKey" | "baseUrl" | "model" | "trustMode"> &
  Partial<Pick<AppConfig, "mcpServers">>;

type ChatJson = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: unknown[];
    };
  }>;
};

export async function runDoctor(config: DoctorConfig, options: DoctorOptions = {}): Promise<DoctorReport> {
  const fetcher = options.fetcher ?? fetch;
  const checks: DoctorCheck[] = [];
  const apiKey = config.apiKey?.trim();

  checks.push(
    apiKey
      ? check("api-key", "API key", "pass", "API key is configured.")
      : check("api-key", "API key", "fail", "Missing ARIVU_API_KEY, legacy SHANKINSTER_API_KEY, or saved apiKey config.")
  );

  let models: string[] | undefined;
  if (!apiKey) {
    checks.push(check("models", "Models endpoint", "skip", "Skipped because no API key is configured."));
    checks.push(check("selected-model", "Selected model", "skip", "Skipped because no model list is available."));
    checks.push(check("chat", "Chat completions", "skip", "Skipped because no API key is configured."));
    checks.push(check("streaming", "Streaming", "skip", "Skipped because no API key is configured."));
    checks.push(check("tool-calling", "Tool calling", "skip", "Skipped because no API key is configured."));
  } else {
    const modelCheck = await checkModels(config, fetcher);
    checks.push(modelCheck.check);
    models = modelCheck.models;
    checks.push(checkSelectedModel(config.model, models));
    checks.push(await checkBasicChat(config, fetcher));
    checks.push(await checkStreaming(config, fetcher));
    checks.push(await checkToolCalling(config, fetcher));
  }

  checks.push(await checkTavily(config, fetcher));

  return {
    generatedAt: new Date().toISOString(),
    checks,
    summary: summarize(checks)
  };
}

function check(id: string, label: string, status: DoctorStatus, message: string, detail?: string): DoctorCheck {
  return { id, label, status, message, detail };
}

async function checkModels(config: DoctorConfig, fetcher: FetchLike): Promise<{ check: DoctorCheck; models?: string[] }> {
  try {
    const response = await fetcher(`${trimBaseUrl(config.baseUrl)}/models`, {
      headers: headers(config.apiKey)
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        check: check("models", "Models endpoint", "fail", `Model list request failed (${response.status}).`, truncate(text, 500))
      };
    }

    const json = parseJson<{ data?: Array<{ id?: string }> }>(text);
    const models = (json?.data ?? []).map((entry) => entry.id).filter((id): id is string => Boolean(id));
    return {
      check: check("models", "Models endpoint", "pass", `${models.length} model${models.length === 1 ? "" : "s"} returned.`),
      models
    };
  } catch (error) {
    return {
      check: check("models", "Models endpoint", "fail", formatError(error))
    };
  }
}

function checkSelectedModel(model: string, models: string[] | undefined): DoctorCheck {
  if (!models) {
    return check("selected-model", "Selected model", "skip", "Skipped because no model list is available.");
  }
  if (models.length === 0) {
    return check("selected-model", "Selected model", "warn", "The models endpoint returned no model IDs.");
  }
  if (models.includes(model)) {
    return check("selected-model", "Selected model", "pass", `${model} is present in the model list.`);
  }
  return check("selected-model", "Selected model", "warn", `${model} was not returned by the models endpoint.`);
}

async function checkBasicChat(config: DoctorConfig, fetcher: FetchLike): Promise<DoctorCheck> {
  const response = await postChat(config, fetcher, {
    model: config.model,
    messages: [{ role: "user", content: "Reply exactly OK." }],
    max_tokens: 8
  });
  if (!response.ok) {
    return check("chat", "Chat completions", "fail", `Chat request failed (${response.status}).`, truncate(response.text, 500));
  }

  return response.json?.choices?.[0]?.message
    ? check("chat", "Chat completions", "pass", "Basic chat completion succeeded.")
    : check("chat", "Chat completions", "warn", "Chat request succeeded but no message was returned.", truncate(response.text, 500));
}

async function checkStreaming(config: DoctorConfig, fetcher: FetchLike): Promise<DoctorCheck> {
  try {
    const response = await fetcher(`${trimBaseUrl(config.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: headers(config.apiKey),
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "Reply exactly OK." }],
        max_tokens: 8,
        stream: true
      })
    });
    if (!response.ok) {
      const text = await response.text();
      return check("streaming", "Streaming", "warn", `Streaming request failed (${response.status}); batch fallback may be used.`, truncate(text, 500));
    }

    const contentType = response.headers.get("content-type") ?? "";
    await response.body?.cancel();
    return contentType.toLowerCase().includes("text/event-stream")
      ? check("streaming", "Streaming", "pass", "Endpoint returned an SSE stream.")
      : check("streaming", "Streaming", "warn", "Endpoint returned a non-SSE response; batch fallback may be used.");
  } catch (error) {
    return check("streaming", "Streaming", "warn", formatError(error));
  }
}

async function checkToolCalling(config: DoctorConfig, fetcher: FetchLike): Promise<DoctorCheck> {
  const response = await postChat(config, fetcher, {
    model: config.model,
    messages: [{ role: "user", content: "Call diagnostic_ping with message ok." }],
    tools: [
      {
        type: "function",
        function: {
          name: "diagnostic_ping",
          description: "Return a short diagnostic ping.",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string" }
            },
            required: ["message"],
            additionalProperties: false
          }
        }
      }
    ],
    tool_choice: {
      type: "function",
      function: {
        name: "diagnostic_ping"
      }
    },
    max_tokens: 64
  });

  if (!response.ok) {
    const status = unsupportedTools(response.text) ? "warn" : "fail";
    const message = status === "warn" ? "Endpoint appears not to support tool calling; Markdown fallback will be used." : `Tool-call check failed (${response.status}).`;
    return check("tool-calling", "Tool calling", status, message, truncate(response.text, 500));
  }

  const toolCalls = response.json?.choices?.[0]?.message?.tool_calls ?? [];
  return toolCalls.length > 0
    ? check("tool-calling", "Tool calling", "pass", "Endpoint returned a tool call.")
    : check("tool-calling", "Tool calling", "warn", "Request succeeded but no tool call was returned; Markdown fallback may be needed.");
}

async function checkTavily(config: DoctorConfig, fetcher: FetchLike): Promise<DoctorCheck> {
  const apiKey = config.tavilyApiKey?.trim();
  if (!apiKey) {
    return check("tavily", "Tavily", "skip", "No Tavily API key is configured.");
  }

  try {
    const response = await fetcher("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "arivu/0.1 doctor"
      },
      body: JSON.stringify({
        query: "OpenAI",
        search_depth: "basic",
        max_results: 1,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_usage: true
      })
    });
    const text = await response.text();
    return response.ok
      ? check("tavily", "Tavily", "pass", "Tavily search endpoint accepted the key.")
      : check("tavily", "Tavily", "fail", `Tavily request failed (${response.status}).`, truncate(text, 500));
  } catch (error) {
    return check("tavily", "Tavily", "fail", formatError(error));
  }
}

async function postChat(config: DoctorConfig, fetcher: FetchLike, body: Record<string, unknown>) {
  try {
    const response = await fetcher(`${trimBaseUrl(config.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: headers(config.apiKey),
      body: JSON.stringify(body)
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
      json: parseJson<ChatJson>(text)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: formatError(error),
      json: undefined
    };
  }
}

function headers(apiKey: string | undefined): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey ?? ""}`,
    "Content-Type": "application/json"
  };
}

function summarize(checks: DoctorCheck[]): Record<DoctorStatus, number> {
  return checks.reduce<Record<DoctorStatus, number>>(
    (summary, entry) => {
      summary[entry.status] += 1;
      return summary;
    },
    { pass: 0, warn: 0, fail: 0, skip: 0 }
  );
}

function unsupportedTools(text: string) {
  return /\b(tool|tools|tool_choice|function calling|function_call|functions)\b/i.test(text);
}

function trimBaseUrl(value: string) {
  return value.replace(/\/$/, "");
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
