import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Check, Copy, LoaderCircle, MessageSquare, Pencil, RotateCcw, Rows3 } from "lucide-react";
import { formatDateTime, formatMessageDateTime, messageDateTimeValue, writeClipboardText } from "../../format";
import { chatContentTextOnly, chatContentToText, imagePartsFromContent } from "./chatContent";

type ThemeMode = "dark" | "light";

export function EmptyConversation() {
  return (
    <div className="empty-conversation">
      <div className="empty-icon">
        <MessageSquare size={26} />
      </div>
      <h2>Start with the task, not the setup.</h2>
      <p>Ask for a code review, a fix, an explanation, or a small implementation. Tool activity and approvals stay visible on the right.</p>
    </div>
  );
}

export function QueuedPromptList({
  prompts,
  steeringPromptId,
  onSteer
}: {
  prompts: QueuedPrompt[];
  steeringPromptId: string | null;
  onSteer: (promptId: string) => void;
}) {
  return (
    <section className="queued-prompts" aria-label="Queued messages">
      <div className="queued-prompts-heading">
        <span>
          <Rows3 size={14} aria-hidden="true" />
          Queued messages
        </span>
        <strong>{prompts.length}</strong>
      </div>
      <div className="queued-prompt-list">
        {prompts.map((queuedPrompt, index) => {
          const text = chatContentToText(queuedPrompt.content).trim();
          const preview = text || "Attached content";
          const steering = queuedPrompt.state === "steering";
          return (
            <article className={steering ? "queued-prompt steering" : "queued-prompt"} key={queuedPrompt.id}>
              <span className="queued-prompt-order">{index + 1}</span>
              <div className="queued-prompt-copy">
                <p title={preview}>{preview}</p>
                <time dateTime={queuedPrompt.createdAt}>{formatDateTime(queuedPrompt.createdAt)}</time>
              </div>
              <button
                type="button"
                className="queued-prompt-steer"
                onClick={() => onSteer(queuedPrompt.id)}
                disabled={steering || steeringPromptId !== null}
                title={steering ? "This message will steer the next model turn" : "Steer the current run with this message"}
              >
                {steeringPromptId === queuedPrompt.id ? (
                  <LoaderCircle className="spinning" size={13} aria-hidden="true" />
                ) : (
                  <ArrowUp size={13} aria-hidden="true" />
                )}
                {steering ? "Steering" : "Steer now"}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function MessageBubble({
  message,
  searchKey,
  searchActive,
  theme,
  busy,
  copied,
  canRetry,
  canEdit,
  onCopy,
  onRetry,
  onEdit
}: {
  message: ChatMessage;
  searchKey: string;
  searchActive: boolean;
  theme: ThemeMode;
  busy: boolean;
  copied: boolean;
  canRetry: boolean;
  canEdit: boolean;
  onCopy: () => void;
  onRetry: () => void;
  onEdit: () => void;
}) {
  const isUser = message.role === "user";
  const copyLabel = copied ? "Copied" : "Copy message";
  const messageDateTime = messageDateTimeValue(message.createdAt);
  const formattedMessageDateTime = formatMessageDateTime(message.createdAt);
  return (
    <article
      className={`${isUser ? "message user-message" : "message assistant-message"}${searchActive ? " search-active" : ""}`}
      data-message-search-key={searchKey}
    >
      <div className="message-heading">
        <div className="message-label">{isUser ? "You" : "Agent"}</div>
      </div>
      {isUser ? (
        <UserMessageContent content={message.content} />
      ) : (
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: (props) => <MarkdownCode {...props} theme={theme} /> }}>
            {chatContentToText(message.content)}
          </ReactMarkdown>
        </div>
      )}
      {messageDateTime && formattedMessageDateTime ? (
        <time className="message-timestamp" dateTime={messageDateTime} title={messageDateTime}>
          {formattedMessageDateTime}
        </time>
      ) : null}
      <div className="message-actions">
        {canEdit ? (
          <button
            className="message-action-button"
            type="button"
            onClick={onEdit}
            disabled={busy}
            title="Edit query"
            aria-label="Edit query"
          >
            <Pencil size={13} />
            <span className="message-action-tooltip" aria-hidden="true">
              Edit query
            </span>
          </button>
        ) : null}
        {canRetry ? (
          <button
            className="message-action-button"
            type="button"
            onClick={onRetry}
            disabled={busy}
            title="Retry query"
            aria-label="Retry query"
          >
            <RotateCcw size={13} />
            <span className="message-action-tooltip" aria-hidden="true">
              Retry query
            </span>
          </button>
        ) : null}
        <button className="message-action-button" type="button" onClick={onCopy} title={copyLabel} aria-label={copyLabel}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span className="message-action-tooltip" aria-hidden="true">
            {copyLabel}
          </span>
        </button>
      </div>
    </article>
  );
}

function MarkdownCode({ className, children, theme, ...props }: ComponentPropsWithoutRef<"code"> & { theme: ThemeMode }) {
  const code = String(children ?? "").replace(/\n$/, "");
  const language = /language-([a-zA-Z0-9_+-]+)/.exec(className ?? "")?.[1];
  const looksLikeBlock = Boolean(language) || code.includes("\n");

  if (!looksLikeBlock) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  return <CodeBlock code={code} language={language ?? "text"} theme={theme} />;
}

function CodeBlock({ code, language, theme }: { code: string; language: string; theme: ThemeMode }) {
  const [html, setHtml] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function highlight() {
      try {
        const nextHtml = await highlightCode(code, language, theme);
        if (!cancelled) {
          setHtml(nextHtml);
        }
      } catch {
        if (!cancelled) {
          setHtml("");
        }
      }
    }
    void highlight();
    return () => {
      cancelled = true;
    };
  }, [code, language, theme]);

  async function copyCode() {
    await writeClipboardText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{languageLabel(language)}</span>
        <button type="button" className="code-copy-button" onClick={() => void copyCode()} title="Copy code" aria-label="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      {html ? (
        <div className="code-block-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-block-fallback">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

async function highlightCode(code: string, language: string, theme: ThemeMode) {
  const { highlightCodeHtml } = await import("../../highlight");
  return highlightCodeHtml(code, language || "text", theme === "light" ? "min-light" : "vitesse-black");
}

function languageLabel(language: string) {
  return language === "text" ? "text" : language;
}

function UserMessageContent({ content }: { content: ChatContent }) {
  const text = chatContentTextOnly(content);
  const images = imagePartsFromContent(content);
  return (
    <div className="user-message-content">
      {text ? <pre>{text}</pre> : null}
      {images.length > 0 ? (
        <div className="message-image-grid">
          {images.map((image, index) => (
            <figure className="message-image" key={`${image.image_url.url.slice(0, 48)}-${index}`}>
              <img src={image.image_url.url} alt={image.name ?? `Attached image ${index + 1}`} />
            </figure>
          ))}
        </div>
      ) : null}
    </div>
  );
}
