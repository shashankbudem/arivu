import { useState } from "react";
import { ArrowDown, ArrowUp, HelpCircle, ImagePlus, Paperclip, X } from "lucide-react";

/**
 * Renders the agent's structured ask_user questions as a native form. The model chose WHAT
 * to ask (typed questions, validated in the tool layer); this component owns every pixel —
 * a deliberately fixed component set so model output can never paint arbitrary UI into the
 * trusted chat surface.
 */

type AnswerDraft = {
  value?: ElicitationAnswerValue;
  otherText?: string;
  files?: ElicitationPickedFile[];
};

export function ElicitationDialog({
  prompt,
  onRespond
}: {
  prompt: ElicitationPrompt;
  onRespond: (response: ElicitationResponse) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const [showErrors, setShowErrors] = useState(false);

  const updateDraft = (questionId: string, patch: Partial<AnswerDraft>) => {
    setDrafts((current) => ({ ...current, [questionId]: { ...current[questionId], ...patch } }));
  };

  const questions = prompt.request.questions;
  const errors = new Map<string, string>();
  for (const question of questions) {
    const error = validateAnswer(question, drafts[question.id]);
    if (error) {
      errors.set(question.id, error);
    }
  }

  const submit = () => {
    if (errors.size > 0) {
      setShowErrors(true);
      return;
    }
    onRespond({
      status: "answered",
      answers: questions.map((question) => {
        const value = resolvedValue(question, drafts[question.id]);
        return hasValue(value) ? { id: question.id, value } : { id: question.id, skipped: true };
      })
    });
  };

  return (
    <div className="modal-backdrop">
      <section className="approval-dialog elicitation-dialog" role="dialog" aria-modal="true" aria-label="The agent has questions">
        <div className="approval-header">
          <div className="approval-icon elicitation-icon">
            <HelpCircle size={24} />
          </div>
          <div>
            <h2>{prompt.request.title || "The agent has a question"}</h2>
            {prompt.request.reason ? <p>{prompt.request.reason}</p> : <p>Your answers go straight back to the agent.</p>}
          </div>
        </div>
        <div className="elicitation-questions">
          {questions.map((question) => (
            <QuestionField
              key={question.id}
              question={question}
              draft={drafts[question.id] ?? {}}
              error={showErrors ? errors.get(question.id) : undefined}
              onChange={(patch) => updateDraft(question.id, patch)}
            />
          ))}
        </div>
        <div className="approval-actions">
          <button type="button" className="deny-button" onClick={() => onRespond({ status: "declined" })}>
            <X size={17} />
            Dismiss
          </button>
          <button type="button" className="approve-button" onClick={submit}>
            Send answers
          </button>
        </div>
      </section>
    </div>
  );
}

function QuestionField({
  question,
  draft,
  error,
  onChange
}: {
  question: ElicitationQuestion;
  draft: AnswerDraft;
  error?: string;
  onChange: (patch: Partial<AnswerDraft>) => void;
}) {
  return (
    <div className="elicitation-question">
      <label className="elicitation-label">
        {question.label}
        {question.required ? <span className="elicitation-required"> *</span> : null}
      </label>
      {question.description ? <p className="elicitation-description">{question.description}</p> : null}
      <QuestionInput question={question} draft={draft} onChange={onChange} />
      {error ? <p className="elicitation-error">{error}</p> : null}
    </div>
  );
}

function QuestionInput({
  question,
  draft,
  onChange
}: {
  question: ElicitationQuestion;
  draft: AnswerDraft;
  onChange: (patch: Partial<AnswerDraft>) => void;
}) {
  switch (question.type) {
    case "select":
      return <SelectInput question={question} draft={draft} onChange={onChange} multi={false} />;
    case "multiselect":
      return <SelectInput question={question} draft={draft} onChange={onChange} multi />;
    case "images":
    case "files":
      return <FilesInput question={question} draft={draft} onChange={onChange} />;
    case "number":
      return (
        <input
          type="number"
          className="elicitation-input"
          placeholder={question.placeholder}
          min={question.min}
          max={question.max}
          value={typeof draft.value === "number" ? draft.value : typeof draft.value === "string" ? draft.value : ""}
          onChange={(event) => onChange({ value: event.target.value === "" ? undefined : Number(event.target.value) })}
        />
      );
    default:
      return (
        <input
          type={question.type === "url" ? "url" : "text"}
          className="elicitation-input"
          placeholder={question.placeholder ?? (question.type === "url" ? "https://…" : undefined)}
          value={typeof draft.value === "string" ? draft.value : ""}
          onChange={(event) => onChange({ value: event.target.value })}
        />
      );
  }
}

function SelectInput({
  question,
  draft,
  onChange,
  multi
}: {
  question: ElicitationQuestion;
  draft: AnswerDraft;
  onChange: (patch: Partial<AnswerDraft>) => void;
  multi: boolean;
}) {
  const selected = new Set(Array.isArray(draft.value) ? draft.value : typeof draft.value === "string" && draft.value ? [draft.value] : []);
  const toggle = (value: string) => {
    if (multi) {
      const next = new Set(selected);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      onChange({ value: [...next] });
    } else {
      onChange({ value: selected.has(value) ? undefined : value });
    }
  };
  return (
    <div className="elicitation-options" role={multi ? "group" : "radiogroup"}>
      {(question.options ?? []).map((option) => {
        const active = selected.has(option.value);
        return (
          <button
            key={option.value}
            type="button"
            role={multi ? "checkbox" : "radio"}
            aria-checked={active}
            className={`elicitation-option${active ? " selected" : ""}`}
            onClick={() => toggle(option.value)}
          >
            <span className="elicitation-option-label">{option.label ?? option.value}</span>
            {option.description ? <span className="elicitation-option-description">{option.description}</span> : null}
          </button>
        );
      })}
      {question.allowOther ? (
        <input
          type="text"
          className="elicitation-input elicitation-other"
          placeholder="Other…"
          value={draft.otherText ?? ""}
          onChange={(event) => onChange({ otherText: event.target.value })}
        />
      ) : null}
    </div>
  );
}

function FilesInput({
  question,
  draft,
  onChange
}: {
  question: ElicitationQuestion;
  draft: AnswerDraft;
  onChange: (patch: Partial<AnswerDraft>) => void;
}) {
  const files = draft.files ?? [];
  const maxCount = question.maxCount ?? 10;
  const kind = question.type === "images" ? "images" : "files";

  const addFiles = async () => {
    const picked = await window.arivu.elicitationChooseFiles(kind);
    if (!picked.files.length) {
      return;
    }
    const existing = new Set(files.map((file) => file.path));
    const merged = [...files, ...picked.files.filter((file) => !existing.has(file.path))].slice(0, maxCount);
    onChange({ files: merged });
  };

  const move = (index: number, delta: number) => {
    const next = [...files];
    const target = index + delta;
    if (target < 0 || target >= next.length) {
      return;
    }
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ files: next });
  };

  return (
    <div className="elicitation-files">
      {files.map((file, index) => (
        <div key={file.path} className="elicitation-file">
          <span className="elicitation-file-order">{index + 1}</span>
          {file.previewDataUrl ? <img className="elicitation-file-preview" src={file.previewDataUrl} alt="" /> : null}
          <span className="elicitation-file-name" title={file.path}>
            {file.name}
          </span>
          <span className="elicitation-file-actions">
            <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
              <ArrowUp size={14} />
            </button>
            <button type="button" aria-label="Move down" disabled={index === files.length - 1} onClick={() => move(index, 1)}>
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              aria-label="Remove"
              onClick={() => onChange({ files: files.filter((entry) => entry.path !== file.path) })}
            >
              <X size={14} />
            </button>
          </span>
        </div>
      ))}
      {files.length < maxCount ? (
        <button type="button" className="elicitation-add-files" onClick={() => void addFiles()}>
          {kind === "images" ? <ImagePlus size={15} /> : <Paperclip size={15} />}
          {kind === "images" ? "Add images" : "Add files"}
          {files.length > 0 ? " (order matters)" : ""}
        </button>
      ) : null}
    </div>
  );
}

function resolvedValue(question: ElicitationQuestion, draft: AnswerDraft | undefined): ElicitationAnswerValue {
  if (!draft) {
    return undefined;
  }
  if (question.type === "images" || question.type === "files") {
    const paths = (draft.files ?? []).map((file) => file.path);
    return paths.length ? paths : undefined;
  }
  if (question.type === "multiselect") {
    const picked = Array.isArray(draft.value) ? draft.value : [];
    const other = draft.otherText?.trim();
    const merged = other ? [...picked, other] : picked;
    return merged.length ? merged : undefined;
  }
  if (question.type === "select") {
    const other = draft.otherText?.trim();
    if (typeof draft.value === "string" && draft.value) {
      return draft.value;
    }
    return other || undefined;
  }
  if (typeof draft.value === "string") {
    const trimmed = draft.value.trim();
    return trimmed || undefined;
  }
  return draft.value;
}

function hasValue(value: ElicitationAnswerValue): boolean {
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

function validateAnswer(question: ElicitationQuestion, draft: AnswerDraft | undefined): string | undefined {
  const value = resolvedValue(question, draft);
  if (!hasValue(value)) {
    return question.required || (question.minCount ?? 0) > 0 ? "An answer is required." : undefined;
  }
  if (question.type === "url" && typeof value === "string") {
    try {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return "Enter an http(s) URL.";
      }
    } catch {
      return "Enter a valid URL.";
    }
  }
  if (question.type === "number" && typeof value === "number") {
    if (!Number.isFinite(value)) {
      return "Enter a number.";
    }
    if (question.min !== undefined && value < question.min) {
      return `Must be at least ${question.min}.`;
    }
    if (question.max !== undefined && value > question.max) {
      return `Must be at most ${question.max}.`;
    }
  }
  if ((question.type === "images" || question.type === "files") && Array.isArray(value)) {
    const minCount = question.minCount ?? (question.required ? 1 : 0);
    if (value.length < minCount) {
      return `Add at least ${minCount} ${question.type === "images" ? "image(s)" : "file(s)"}.`;
    }
  }
  return undefined;
}
