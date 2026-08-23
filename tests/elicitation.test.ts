import { describe, expect, it } from "vitest";
import {
  elicitationRequestSchema,
  findCredentialRequest,
  formatElicitationResponse,
  MAX_ELICITATION_QUESTIONS,
  validateElicitationResponse,
  type ElicitationRequest
} from "../src/tools/elicitation.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { ApprovalManager } from "../src/permissions/ApprovalManager.js";

function baseRequest(): ElicitationRequest {
  return {
    title: "Deployment target",
    questions: [
      {
        id: "env",
        type: "select",
        label: "Which environment should I deploy to?",
        required: true,
        options: [{ value: "staging" }, { value: "production", description: "Requires a release tag" }]
      }
    ]
  };
}

describe("elicitationRequestSchema", () => {
  it("accepts a well-formed request", () => {
    expect(() => elicitationRequestSchema.parse(baseRequest())).not.toThrow();
  });

  it("rejects selects without options and non-selects with options", () => {
    expect(() => elicitationRequestSchema.parse({ questions: [{ id: "a", type: "select", label: "Pick one" }] })).toThrow(
      /at least one option/
    );
    expect(() =>
      elicitationRequestSchema.parse({
        questions: [{ id: "a", type: "text", label: "Name?", options: [{ value: "x" }] }]
      })
    ).toThrow(/must not include options/);
  });

  it("rejects duplicate ids and over-limit question counts", () => {
    expect(() =>
      elicitationRequestSchema.parse({
        questions: [
          { id: "a", type: "text", label: "One" },
          { id: "a", type: "text", label: "Two" }
        ]
      })
    ).toThrow(/duplicate question id/);
    const tooMany = Array.from({ length: MAX_ELICITATION_QUESTIONS + 1 }, (_, index) => ({
      id: `q${index}`,
      type: "text" as const,
      label: `Question ${index}`
    }));
    expect(() => elicitationRequestSchema.parse({ questions: tooMany })).toThrow();
  });

  it("rejects inverted numeric and count bounds", () => {
    expect(() => elicitationRequestSchema.parse({ questions: [{ id: "n", type: "number", label: "How many?", min: 5, max: 1 }] })).toThrow(
      /min greater than max/
    );
    expect(() =>
      elicitationRequestSchema.parse({ questions: [{ id: "f", type: "images", label: "Shots", minCount: 4, maxCount: 2 }] })
    ).toThrow(/minCount greater than maxCount/);
  });
});

describe("findCredentialRequest", () => {
  it("flags secret-collecting questions anywhere in the request", () => {
    expect(
      findCredentialRequest({
        questions: [{ id: "p", type: "text", label: "Enter your ServiceNow password" }]
      })
    ).toMatch(/password/i);
    expect(
      findCredentialRequest({
        title: "Card number needed to finish checkout",
        questions: [{ id: "x", type: "text", label: "Continue?" }]
      })
    ).toMatch(/card number/i);
    expect(findCredentialRequest(baseRequest())).toBeUndefined();
  });
});

describe("formatElicitationResponse", () => {
  it("echoes answers by question id and marks unanswered questions skipped", () => {
    const request: ElicitationRequest = {
      questions: [
        { id: "env", type: "select", label: "Env?", options: [{ value: "staging" }] },
        { id: "notes", type: "text", label: "Notes?" }
      ]
    };
    const formatted = JSON.parse(formatElicitationResponse(request, { status: "answered", answers: [{ id: "env", value: "staging" }] }));
    expect(formatted).toEqual({
      status: "answered",
      answers: [
        { id: "env", value: "staging" },
        { id: "notes", skipped: true }
      ]
    });
  });

  it("keeps ordered file paths in user order", () => {
    const request: ElicitationRequest = {
      questions: [{ id: "shots", type: "images", label: "Screenshots in order" }]
    };
    const formatted = JSON.parse(
      formatElicitationResponse(request, {
        status: "answered",
        answers: [{ id: "shots", value: ["/tmp/second-step.png", "/tmp/first-step.png"] }]
      })
    );
    expect(formatted.answers[0].value).toEqual(["/tmp/second-step.png", "/tmp/first-step.png"]);
  });

  it("explains declined and unavailable outcomes to the model", () => {
    const declined = JSON.parse(formatElicitationResponse(baseRequest(), { status: "declined" }));
    expect(declined.status).toBe("declined");
    expect(declined.note).toMatch(/best judgment/i);
    const unavailable = JSON.parse(formatElicitationResponse(baseRequest(), { status: "unavailable" }));
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.note).toMatch(/normal chat message/i);
  });
});

describe("validateElicitationResponse", () => {
  it("uses the same URL acceptance rules as JavaScript URL parsing", () => {
    const request: ElicitationRequest = { questions: [{ id: "url", type: "url", label: "URL", required: true }] };
    for (const value of ["https://example.com", "http://[::1]:8080/path", "https:///path", "https://example.com/%zz"]) {
      expect(validateElicitationResponse(request, { status: "answered", answers: [{ id: "url", value }] })).toBeUndefined();
    }
    for (const value of ["https://", "https://example.com:abc", "https://exa%mple.com", "https://[::1"]) {
      expect(validateElicitationResponse(request, { status: "answered", answers: [{ id: "url", value }] })).toBeTruthy();
    }
  });

  it("rejects protocol-bypassed number, choice, and file constraints", () => {
    const request: ElicitationRequest = {
      questions: [
        { id: "count", type: "number", label: "Count", min: 10 },
        { id: "choice", type: "select", label: "Choice", options: [{ value: "safe" }] },
        { id: "files", type: "files", label: "Files", minCount: 1 }
      ]
    };
    expect(validateElicitationResponse(request, { status: "answered", answers: [{ id: "count", value: 1 }] })).toMatch(/at least 10/);
    expect(validateElicitationResponse(request, { status: "answered", answers: [{ id: "choice", value: "injected" }] })).toMatch(
      /listed option/
    );
    expect(validateElicitationResponse(request, { status: "answered", answers: [{ id: "files", value: ["relative.txt"] }] })).toMatch(
      /existing absolute/
    );
    expect(
      validateElicitationResponse(request, { status: "answered", answers: [{ id: "files", value: ["/definitely/missing"] }] })
    ).toMatch(/existing absolute/);
  });

  it("rejects malicious non-string multiselect and file elements without throwing", () => {
    const choices: ElicitationRequest = {
      questions: [{ id: "choice", type: "multiselect", label: "Choice", options: [{ value: "safe" }], allowOther: true }]
    };
    const files: ElicitationRequest = { questions: [{ id: "files", type: "files", label: "Files" }] };
    expect(() =>
      validateElicitationResponse(choices, { status: "answered", answers: [{ id: "choice", value: [1] as any }] })
    ).not.toThrow();
    expect(validateElicitationResponse(choices, { status: "answered", answers: [{ id: "choice", value: [1] as any }] })).toMatch(
      /text options/
    );
    expect(() => validateElicitationResponse(files, { status: "answered", answers: [{ id: "files", value: [123] as any }] })).not.toThrow();
    expect(validateElicitationResponse(files, { status: "answered", answers: [{ id: "files", value: [123] as any }] })).toMatch(
      /file paths/
    );
  });
});

describe("ask_user tool", () => {
  function registryWith(elicit?: Parameters<typeof createToolRegistry>[0]["elicit"]) {
    return createToolRegistry({
      workspaceRoot: process.cwd(),
      approvals: new ApprovalManager("ask", async () => true),
      elicit
    });
  }

  it("is offered to the model with a bounded question schema", () => {
    const registry = registryWith();
    const schema = registry.schemas.find((tool) => tool.name === "ask_user");
    expect(schema).toBeDefined();
    expect(JSON.stringify(schema?.parameters)).toContain("multiselect");
  });

  it("returns the frontend's answers", async () => {
    const registry = registryWith(async (request) => ({
      status: "answered",
      answers: [{ id: request.questions[0].id, value: "staging" }]
    }));
    const result = JSON.parse(await registry.execute("ask_user", baseRequest()));
    expect(result).toEqual({ status: "answered", answers: [{ id: "env", value: "staging" }] });
  });

  it("refuses credential requests without ever invoking the frontend", async () => {
    let invoked = false;
    const registry = registryWith(async () => {
      invoked = true;
      return { status: "answered", answers: [] };
    });
    const result = JSON.parse(
      await registry.execute("ask_user", {
        questions: [{ id: "p", type: "text", label: "What is your API key?" }]
      })
    );
    expect(result.status).toBe("refused");
    expect(result.note).toMatch(/never collects/i);
    expect(invoked).toBe(false);
  });

  it("reports unavailable when the session has no frontend elicitor", async () => {
    const registry = registryWith(undefined);
    const result = JSON.parse(await registry.execute("ask_user", baseRequest()));
    expect(result.status).toBe("unavailable");
  });

  it("surfaces validation errors so the model can retry", async () => {
    const registry = registryWith();
    const result = await registry.execute("ask_user", { questions: [] });
    expect(result).toMatch(/^Error:/);
  });
});
