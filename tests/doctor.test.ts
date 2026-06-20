import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/diagnostics/doctor.js";

describe("doctor diagnostics", () => {
  it("skips network checks when the API key is missing", async () => {
    const report = await runDoctor({
      baseUrl: "https://api.example.test/v1",
      model: "test-model",
      trustMode: "ask"
    });

    expect(report.checks.find((check) => check.id === "api-key")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "chat")?.status).toBe("skip");
    expect(report.checks.find((check) => check.id === "tavily")?.status).toBe("skip");
  });

  it("warns when tool calling is unsupported", async () => {
    const report = await runDoctor(
      {
        apiKey: "test-key",
        baseUrl: "https://api.example.test/v1",
        model: "test-model",
        trustMode: "ask"
      },
      {
        async fetcher(input, init) {
          const url = String(input);
          if (url.endsWith("/models")) {
            return Response.json({ data: [{ id: "test-model" }] });
          }

          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          if (body.stream) {
            return new Response("data: [DONE]\n\n", {
              headers: {
                "Content-Type": "text/event-stream"
              }
            });
          }
          if (body.tools) {
            return new Response("tools are not supported", { status: 400 });
          }
          return Response.json({
            choices: [
              {
                message: {
                  content: "OK"
                }
              }
            ]
          });
        }
      }
    );

    expect(report.checks.find((check) => check.id === "models")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "chat")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "streaming")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "tool-calling")?.status).toBe("warn");
  });
});
