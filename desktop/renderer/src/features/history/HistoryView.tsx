import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, MoreHorizontal, Pencil, Pin, PinOff, RefreshCw, Trash2 } from "lucide-react";
import { basename, clamp, formatDateTime, formatError } from "../../format";
import { agentLoopStatusLabel } from "../sessions/agentLoopPresentation";
import { isAutoModelId, modelDisplayName } from "../models/providerCatalog";

const CHAT_OPTIONS_MENU_WIDTH = 150;

const CHAT_OPTIONS_MENU_HEIGHT = 106;

const CHAT_OPTIONS_MENU_MARGIN = 8;

const CHAT_OPTIONS_MENU_GAP = 2;

export function HistoryView({
  sessions,
  loading,
  activeSessionId,
  openMenuId,
  onReload,
  onOpen,
  onRename,
  onTogglePin,
  onDelete,
  onToggleMenu,
  onError
}: {
  sessions: SessionSummary[];
  loading: boolean;
  activeSessionId?: string;
  openMenuId: string | null;
  onReload: () => void;
  onOpen: (id: string) => Promise<void>;
  onRename: (session: SessionSummary) => Promise<void>;
  onTogglePin: (session: SessionSummary) => Promise<void>;
  onDelete: (session: SessionSummary) => Promise<void>;
  onToggleMenu: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function openSession(id: string) {
    setOpeningId(id);
    try {
      await onOpen(id);
    } catch (err) {
      onError(formatError(err));
    } finally {
      setOpeningId(null);
    }
  }

  async function deleteSession(session: SessionSummary) {
    setDeletingId(session.id);
    try {
      await onDelete(session);
    } catch (err) {
      onError(formatError(err));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="history-panel">
      <div className="history-toolbar">
        <div>
          <div className="section-label">Saved Sessions</div>
          <h2>Conversation history</h2>
        </div>
        <button className="ghost-button" type="button" onClick={onReload} disabled={loading}>
          <RefreshCw size={16} />
          Reload
        </button>
      </div>

      {loading ? <div className="history-empty">Loading history...</div> : null}
      {!loading && sessions.length === 0 ? <div className="history-empty">No saved sessions yet.</div> : null}

      <div className="history-list">
        {sessions.map((session) => (
          <div key={session.id} className={session.id === activeSessionId ? "history-item active" : "history-item"}>
            <button
              className="history-row"
              type="button"
              onClick={() => void openSession(session.id)}
              disabled={openingId === session.id || deletingId === session.id}
            >
              <div className="history-main">
                <strong>{session.title}</strong>
                {session.pinnedAt ? <Pin className="chat-pin-indicator" size={12} aria-label="Pinned chat" /> : null}
                {session.running ? <ChatRunningIndicator /> : null}
              </div>
              <div className="history-details">
                <span>{formatDateTime(session.updatedAt)}</span>
                {session.pinnedAt ? <span title={`Pinned ${formatDateTime(session.pinnedAt)}`}>Pinned</span> : null}
                <span title={session.cwd}>{basename(session.cwd)}</span>
                <span title={sessionModelTitle(session)}>{sessionModelLabel(session)}</span>
                {session.agentLoop ? (
                  <span title={agentLoopStatusLabel(session.agentLoop)}>{sessionLoopLabel(session.agentLoop)}</span>
                ) : null}
                <span>{session.messageCount} messages</span>
              </div>
            </button>
            <ChatOptionsMenu
              open={openMenuId === session.id}
              title={session.title}
              pinned={Boolean(session.pinnedAt)}
              disabled={deletingId === session.id}
              onToggle={() => onToggleMenu(session.id)}
              onRename={() => void onRename(session)}
              onTogglePin={() => void onTogglePin(session)}
              onDelete={() => void deleteSession(session)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

export function SidebarChatItem({
  session,
  active,
  menuOpen,
  className,
  onOpen,
  onToggleMenu,
  onRename,
  onTogglePin,
  onDelete
}: {
  session: SessionSummary;
  active: boolean;
  menuOpen: boolean;
  className?: string;
  onOpen: () => void;
  onToggleMenu: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const classes = ["recent-chat-item", active ? "active" : "", className ?? ""].filter(Boolean).join(" ");

  return (
    <div className={classes} data-session-id={session.id}>
      <button className="recent-chat-row" type="button" onClick={onOpen}>
        <div className="recent-chat-main">
          <strong>{session.title}</strong>
          {session.pinnedAt ? <Pin className="chat-pin-indicator" size={11} aria-label="Pinned chat" /> : null}
          {session.running ? <ChatRunningIndicator /> : null}
        </div>
        <div className="recent-chat-details">
          <span>{formatDateTime(session.updatedAt)}</span>
          {session.pinnedAt ? <span title={`Pinned ${formatDateTime(session.pinnedAt)}`}>Pinned</span> : null}
          <span title={sessionModelTitle(session)}>{sessionModelLabel(session)}</span>
          {session.agentLoop ? <span title={agentLoopStatusLabel(session.agentLoop)}>{sessionLoopLabel(session.agentLoop)}</span> : null}
          <span>{session.messageCount} messages</span>
        </div>
      </button>
      <ChatOptionsMenu
        open={menuOpen}
        title={session.title}
        pinned={Boolean(session.pinnedAt)}
        onToggle={onToggleMenu}
        onRename={onRename}
        onTogglePin={onTogglePin}
        onDelete={onDelete}
      />
    </div>
  );
}

function ChatRunningIndicator() {
  return (
    <span className="chat-running-indicator" role="status" title="Agent is running" aria-label="Agent is running">
      <LoaderCircle size={12} aria-hidden="true" />
    </span>
  );
}

function ChatOptionsMenu({
  open,
  title,
  pinned,
  disabled,
  onToggle,
  onRename,
  onTogglePin,
  onDelete
}: {
  open: boolean;
  title: string;
  pinned: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }

    const updateMenuPosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const maxLeft = Math.max(CHAT_OPTIONS_MENU_MARGIN, window.innerWidth - CHAT_OPTIONS_MENU_WIDTH - CHAT_OPTIONS_MENU_MARGIN);
      const left = clamp(rect.right - CHAT_OPTIONS_MENU_WIDTH, CHAT_OPTIONS_MENU_MARGIN, maxLeft);
      const topBelow = rect.bottom + CHAT_OPTIONS_MENU_GAP;
      const topAbove = rect.top - CHAT_OPTIONS_MENU_HEIGHT - CHAT_OPTIONS_MENU_GAP;
      const hasRoomBelow = topBelow + CHAT_OPTIONS_MENU_HEIGHT <= window.innerHeight - CHAT_OPTIONS_MENU_MARGIN;
      const top = hasRoomBelow ? topBelow : Math.max(CHAT_OPTIONS_MENU_MARGIN, topAbove);

      setMenuPosition({ left, top });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open]);

  const menu =
    open && menuPosition
      ? createPortal(
          <div
            className="chat-options-menu"
            role="menu"
            style={{
              left: menuPosition.left,
              position: "fixed",
              right: "auto",
              top: menuPosition.top
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <button className="chat-menu-item" type="button" onClick={onRename} role="menuitem">
              <Pencil size={14} />
              Rename
            </button>
            <button className="chat-menu-item" type="button" onClick={onTogglePin} role="menuitem">
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
              {pinned ? "Unpin" : "Pin"}
            </button>
            <button className="chat-menu-item danger" type="button" onClick={onDelete} role="menuitem">
              <Trash2 size={14} />
              Delete
            </button>
          </div>,
          document.body
        )
      : null;

  return (
    <div className={open ? "chat-options open" : "chat-options"} onClick={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        className="icon-button chat-options-button"
        type="button"
        onClick={onToggle}
        disabled={disabled}
        title={`Options for ${title}`}
        aria-label={`Options for ${title}`}
        aria-expanded={open}
      >
        <MoreHorizontal size={15} />
      </button>
      {menu}
    </div>
  );
}

function sessionModelLabel(session: SessionSummary) {
  if (session.modelMode === "auto" || isAutoModelId(session.model)) {
    return session.selectedModel ? `Auto -> ${session.selectedModel}` : "Auto";
  }
  return modelDisplayName(session.model);
}

function sessionModelTitle(session: SessionSummary) {
  if (session.modelMode === "auto" || isAutoModelId(session.model)) {
    return [session.selectedProviderName, session.modelSelectionReason].filter(Boolean).join(" - ") || "Auto model selection";
  }
  return session.model ?? "default model";
}

function sessionLoopLabel(loop: AgentLoopState) {
  if (loop.status === "running" || loop.status === "stopping") {
    return `Loop ${loop.iteration}/${loop.maxIterations}`;
  }
  if (loop.status === "completed") {
    return "Loop done";
  }
  if (loop.status === "max_iterations") {
    return "Loop max";
  }
  return `Loop ${loop.status}`;
}
