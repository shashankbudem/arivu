import { existsSync } from "node:fs";
import { checkbox, input, select } from "@inquirer/prompts";
import { z } from "zod";

/**
 * Structured "ask the user" requests: the model describes WHAT it needs (typed questions),
 * each frontend owns HOW that renders (desktop form card, inquirer prompts, or a prose
 * fallback). The model never authors UI — a fixed component set is what keeps a
 * prompt-injected model from painting arbitrary interfaces inside the trusted chat surface.
 */

export const MAX_ELICITATION_QUESTIONS = 5;
export const MAX_ELICITATION_OPTIONS = 12;
export const MAX_ELICITATION_LABEL_CHARS = 300;
export const MAX_ELICITATION_DESCRIPTION_CHARS = 600;
export const MAX_ELICITATION_TEXT_ANSWER_CHARS = 4_000;
export const MAX_ELICITATION_FILE_COUNT = 10;

export type ElicitationQuestionType = "select" | "multiselect" | "text" | "url" | "number" | "images" | "files";

export type ElicitationOption = {
  value: string;
  label?: string;
  description?: string;
};

export type ElicitationQuestion = {
  id: string;
  type: ElicitationQuestionType;
  label: string;
  description?: string;
  required?: boolean;
  /** select / multiselect only. */
  options?: ElicitationOption[];
  /** select / multiselect: allow a free-text "Other" entry alongside the options. */
  allowOther?: boolean;
  placeholder?: string;
  /** number only. */
  min?: number;
  max?: number;
  /** images / files: bounds on how many the user should provide. */
  minCount?: number;
  maxCount?: number;
};

export type ElicitationRequest = {
  /** Short heading shown above the questions. */
  title?: string;
  /** Why the model needs this input; shown to the user. */
  reason?: string;
  questions: ElicitationQuestion[];
};

export type ElicitationAnswer = {
  id: string;
  /**
   * select/text/url: string. multiselect: string[]. number: number.
   * images/files: ordered absolute paths (order is meaningful — the user arranged them).
   */
  value?: string | string[] | number;
  skipped?: boolean;
};

export type ElicitationResponse = {
  /**
   * answered: the user submitted the form (individual optional questions may be skipped).
   * declined: the user dismissed the request without answering.
   * unavailable: this frontend cannot show interactive questions.
   */
  status: "answered" | "declined" | "unavailable";
  answers?: ElicitationAnswer[];
  note?: string;
};

export type Elicitor = (request: ElicitationRequest) => Promise<ElicitationResponse>;

const optionSchema = z.object({
  value: z.string().trim().min(1).max(MAX_ELICITATION_LABEL_CHARS),
  label: z.string().trim().min(1).max(MAX_ELICITATION_LABEL_CHARS).optional(),
  description: z.string().trim().max(MAX_ELICITATION_DESCRIPTION_CHARS).optional()
});

const questionSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/, "question ids must be alphanumeric with dashes/underscores"),
    type: z.enum(["select", "multiselect", "text", "url", "number", "images", "files"]),
    label: z.string().trim().min(1).max(MAX_ELICITATION_LABEL_CHARS),
    description: z.string().trim().max(MAX_ELICITATION_DESCRIPTION_CHARS).optional(),
    required: z.boolean().optional(),
    options: z.array(optionSchema).max(MAX_ELICITATION_OPTIONS).optional(),
    allowOther: z.boolean().optional(),
    placeholder: z.string().trim().max(MAX_ELICITATION_LABEL_CHARS).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    minCount: z.number().int().min(0).max(MAX_ELICITATION_FILE_COUNT).optional(),
    maxCount: z.number().int().min(1).max(MAX_ELICITATION_FILE_COUNT).optional()
  })
  .superRefine((question, ctx) => {
    const needsOptions = question.type === "select" || question.type === "multiselect";
    if (needsOptions && !question.options?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `question "${question.id}" is a ${question.type} and must include at least one option`
      });
    }
    if (!needsOptions && question.options?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `question "${question.id}" is type "${question.type}" and must not include options`
      });
    }
    if (question.min !== undefined && question.max !== undefined && question.min > question.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `question "${question.id}" has min greater than max` });
    }
    if (question.minCount !== undefined && question.maxCount !== undefined && question.minCount > question.maxCount) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `question "${question.id}" has minCount greater than maxCount` });
    }
  });

export const elicitationRequestSchema = z
  .object({
    title: z.string().trim().max(MAX_ELICITATION_LABEL_CHARS).optional(),
    reason: z.string().trim().max(MAX_ELICITATION_DESCRIPTION_CHARS).optional(),
    questions: z.array(questionSchema).min(1).max(MAX_ELICITATION_QUESTIONS)
  })
  .superRefine((request, ctx) => {
    const ids = new Set<string>();
    for (const question of request.questions) {
      if (ids.has(question.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate question id "${question.id}"` });
      }
      ids.add(question.id);
    }
  });

// Hard rule enforced harness-side, not model-side: interactive questions must never be used
// to collect secrets. A prompt-injected model asking for a password through the app's own
// trusted form UI is exactly the phishing shape this feature must not enable.
const CREDENTIAL_REQUEST_PATTERN =
  /\b(password|passcode|passphrase|otp|one[- ]?time\s+(?:code|password)|2fa|mfa|verification\s+code|api[- ]?key|secret\s+key|access\s+token|auth\s+token|private\s+key|seed\s+phrase|recovery\s+(?:code|phrase)|credit\s+card|card\s+number|cvv|cvc|ssn|social\s+security)\b/i;

export function findCredentialRequest(request: ElicitationRequest): string | undefined {
  const surfaces: string[] = [request.title ?? "", request.reason ?? ""];
  for (const question of request.questions) {
    surfaces.push(question.label, question.description ?? "", question.placeholder ?? "");
  }
  return surfaces.find((surface) => CREDENTIAL_REQUEST_PATTERN.test(surface));
}

/** True when a value counts as an answer for required-question enforcement. */
export function hasElicitationValue(value: ElicitationAnswer["value"]): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Number.isFinite(value);
}

/**
 * Serializes a response for the model. Answers are echoed with their question ids so the
 * model can consume them without guessing; file answers keep user-chosen order.
 */
export function formatElicitationResponse(request: ElicitationRequest, response: ElicitationResponse): string {
  if (response.status === "unavailable") {
    return JSON.stringify({
      status: "unavailable",
      note:
        response.note ??
        "This session has no interactive question UI. Ask the user in a normal chat message instead, and continue with stated assumptions if they do not reply."
    });
  }
  if (response.status === "declined") {
    return JSON.stringify({
      status: "declined",
      note: response.note ?? "The user dismissed the questions without answering. Proceed with your best judgment and state assumptions."
    });
  }
  const answersById = new Map((response.answers ?? []).map((answer) => [answer.id, answer]));
  const answers = request.questions.map((question) => {
    const answer = answersById.get(question.id);
    if (!answer || answer.skipped || !hasElicitationValue(answer.value)) {
      return { id: question.id, skipped: true };
    }
    return { id: question.id, value: boundAnswerValue(answer.value) };
  });
  return JSON.stringify({ status: "answered", answers });
}

function boundAnswerValue(value: ElicitationAnswer["value"]): ElicitationAnswer["value"] {
  if (typeof value === "string") {
    return value.slice(0, MAX_ELICITATION_TEXT_ANSWER_CHARS);
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ELICITATION_FILE_COUNT).map((entry) => entry.slice(0, MAX_ELICITATION_TEXT_ANSWER_CHARS));
  }
  return value;
}

const OTHER_OPTION_VALUE = "__arivu_other__";

/**
 * Terminal frontend: renders the same request through @inquirer prompts. Used by the CLI;
 * blessed-based TUI sessions and headless runs pass no elicitor and get "unavailable".
 */
export async function terminalElicit(request: ElicitationRequest): Promise<ElicitationResponse> {
  if (!process.stdin.isTTY) {
    return { status: "unavailable", note: "stdin is not interactive." };
  }
  const answers: ElicitationAnswer[] = [];
  if (request.title) {
    process.stdout.write(`\n${request.title}\n`);
  }
  if (request.reason) {
    process.stdout.write(`${request.reason}\n`);
  }
  try {
    for (const question of request.questions) {
      answers.push(await terminalQuestion(question));
    }
  } catch {
    // Ctrl+C inside a prompt declines the whole request rather than crashing the run.
    return { status: "declined" };
  }
  return { status: "answered", answers };
}

async function terminalQuestion(question: ElicitationQuestion): Promise<ElicitationAnswer> {
  const requiredSuffix = question.required ? "" : " (optional, submit empty to skip)";
  const message = `${question.label}${question.description ? ` — ${question.description}` : ""}`;
  switch (question.type) {
    case "select": {
      const choices = [
        ...(question.options ?? []).map((option) => ({
          name: option.label ?? option.value,
          value: option.value,
          description: option.description
        })),
        ...(question.allowOther ? [{ name: "Other…", value: OTHER_OPTION_VALUE }] : []),
        ...(question.required ? [] : [{ name: "(skip)", value: "" }])
      ];
      const picked = await select({ message, choices });
      if (picked === OTHER_OPTION_VALUE) {
        const other = await input({ message: "Other:" });
        return { id: question.id, value: other.trim(), skipped: !other.trim() };
      }
      return { id: question.id, value: picked, skipped: !picked };
    }
    case "multiselect": {
      const picked = await checkbox({
        message,
        choices: (question.options ?? []).map((option) => ({
          name: option.label ?? option.value,
          value: option.value,
          description: option.description
        }))
      });
      let values = picked;
      if (question.allowOther) {
        const other = await input({ message: "Other (optional):" });
        if (other.trim()) {
          values = [...picked, other.trim()];
        }
      }
      return { id: question.id, value: values, skipped: values.length === 0 };
    }
    case "number": {
      const raw = await input({
        message: `${message}${requiredSuffix}`,
        validate: (value) => validateNumberInput(value, question)
      });
      if (!raw.trim()) {
        return { id: question.id, skipped: true };
      }
      return { id: question.id, value: Number(raw) };
    }
    case "url": {
      const raw = await input({
        message: `${message}${requiredSuffix}`,
        validate: (value) => validateUrlInput(value, question)
      });
      return { id: question.id, value: raw.trim(), skipped: !raw.trim() };
    }
    case "images":
    case "files": {
      const raw = await input({
        message: `${message}${requiredSuffix} — absolute paths in order, separated by commas`,
        validate: (value) => validatePathsInput(value, question)
      });
      const paths = splitPathsInput(raw);
      return { id: question.id, value: paths, skipped: paths.length === 0 };
    }
    default: {
      const raw = await input({ message: `${message}${requiredSuffix}` });
      return { id: question.id, value: raw.trim(), skipped: !raw.trim() };
    }
  }
}

function validateNumberInput(value: string, question: ElicitationQuestion): true | string {
  if (!value.trim()) {
    return question.required ? "An answer is required." : true;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "Enter a number.";
  }
  if (question.min !== undefined && parsed < question.min) {
    return `Must be at least ${question.min}.`;
  }
  if (question.max !== undefined && parsed > question.max) {
    return `Must be at most ${question.max}.`;
  }
  return true;
}

function validateUrlInput(value: string, question: ElicitationQuestion): true | string {
  if (!value.trim()) {
    return question.required ? "An answer is required." : true;
  }
  try {
    const parsed = new URL(value.trim());
    return ["http:", "https:"].includes(parsed.protocol) ? true : "Enter an http(s) URL.";
  } catch {
    return "Enter a valid URL.";
  }
}

function validatePathsInput(value: string, question: ElicitationQuestion): true | string {
  const paths = splitPathsInput(value);
  if (paths.length === 0) {
    return question.required || (question.minCount ?? 0) > 0 ? "At least one path is required." : true;
  }
  const minCount = question.minCount ?? 0;
  const maxCount = question.maxCount ?? MAX_ELICITATION_FILE_COUNT;
  if (paths.length < minCount) {
    return `Provide at least ${minCount} path(s).`;
  }
  if (paths.length > maxCount) {
    return `Provide at most ${maxCount} path(s).`;
  }
  const missing = paths.find((entry) => !existsSync(entry));
  return missing ? `File not found: ${missing}` : true;
}

function splitPathsInput(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, MAX_ELICITATION_FILE_COUNT);
}
