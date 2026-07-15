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
    expect(report.capabilityObservations).toMatchObject([
      {
        capability: "toolCalling",
        value: "disabled",
        source: "doctor",
        checkId: "tool-calling",
        status: "warn"
      }
    ]);
  });

  it("skips tool-calling probe when provider tool calling is disabled", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const report = await runDoctor(
      {
        apiKey: "test-key",
        baseUrl: "https://api.example.test/v1",
        model: "test-model",
        trustMode: "ask",
        toolCalling: "disabled"
      },
      {
        async fetcher(input, init) {
          const url = String(input);
          if (url.endsWith("/models")) {
            return Response.json({ data: [{ id: "test-model" }] });
          }

          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          bodies.push(body);
          if (body.stream) {
            return new Response("data: [DONE]\n\n", {
              headers: {
                "Content-Type": "text/event-stream"
              }
            });
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

    expect(report.checks.find((check) => check.id === "tool-calling")).toMatchObject({
      status: "skip",
      message: "Skipped because this provider is configured for plain chat."
    });
    expect(bodies.some((body) => Boolean(body.tools))).toBe(false);
  });

  it("bounds response bodies before including diagnostics", async () => {
    const report = await runDoctor(
      {
        apiKey: "test-key",
        baseUrl: "https://api.example.test/v1",
        model: "test-model",
        trustMode: "ask"
      },
      {
        async fetcher(input) {
          if (String(input).endsWith("/models")) {
            return new Response("x".repeat(200_000), { status: 500 });
          }
          return Response.json({});
        }
      }
    );

    const detail = report.checks.find((check) => check.id === "models")?.detail ?? "";
    expect(detail.length).toBeLessThan(600);
    expect(detail).toContain("[truncated]");
  });
});
