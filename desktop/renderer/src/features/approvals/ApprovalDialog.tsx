import { AlertTriangle, Check, FileText, Globe, Shield, TerminalSquare, X } from "lucide-react";
import { approvalViewFromRequest, parseApprovalMessage, type ApprovalView, type SideBySideDiff } from "../../approvalParsing";

export function ApprovalDialog({ approval, onRespond }: { approval: ApprovalRequest; onRespond: (approved: boolean) => void }) {
  // Prefer the structured request from the main process; fall back to parsing the text message.
  const view = (approval.request ? approvalViewFromRequest(approval.request) : undefined) ?? parseApprovalMessage(approval.message);

  return (
    <div className="modal-backdrop">
      <section className="approval-dialog rich-approval-dialog" role="dialog" aria-modal="true" aria-label="Approval required">
        <div className="approval-header">
          <div className="approval-icon">
            <Shield size={24} />
          </div>
          <div>
            <h2>Approval required</h2>
            <p>{approvalSubtitle(view)}</p>
          </div>
        </div>
        <ApprovalContent view={view} fallback={approval.message} />
        <div className="approval-actions">
          <button type="button" className="deny-button" onClick={() => onRespond(false)}>
            <X size={17} />
            Deny
          </button>
          <button type="button" className="approve-button" onClick={() => onRespond(true)}>
            <Check size={17} />
            Approve
          </button>
        </div>
      </section>
    </div>
  );
}

function ApprovalContent({ view, fallback }: { view: ApprovalView; fallback: string }) {
  if (view.type === "shell") {
    return (
      <div className="approval-detail shell-approval">
        <div className="shell-command-card">
          <code className="shell-command-text">{view.command}</code>
        </div>
        {view.cwd ? (
          <div className="shell-meta">
            <TerminalSquare size={14} />
            <span>{view.cwd}</span>
          </div>
        ) : null}
        {view.warnings.length > 0 ? (
          <div className="danger-badges">
            {view.warnings.map((warning) => (
              <span key={warning} className="danger-badge">
                <AlertTriangle size={13} />
                {warning}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (view.type === "write" && view.diff) {
    return (
      <div className="approval-detail">
        <div className="write-summary">{view.summary}</div>
        <SideBySideDiffView diff={view.diff} />
      </div>
    );
  }

  if (view.type === "browser") {
    return (
      <div className="approval-detail browser-approval">
        <div className="browser-approval-card">
          <Globe size={16} />
          <div>
            <strong>{view.action}</strong>
            <span>{view.target}</span>
          </div>
        </div>
        {view.mode ? <span className="browser-approval-mode">{view.mode}</span> : null}
      </div>
    );
  }

  if (view.type === "network") {
    return (
      <div className="approval-detail browser-approval">
        <div className="browser-approval-card">
          <Globe size={16} />
          <div>
            <strong>{view.summary}</strong>
            <span>{view.destination ?? "Network"}</span>
          </div>
        </div>
        {view.query ? <pre>{view.query}</pre> : null}
      </div>
    );
  }

  return <pre>{fallback}</pre>;
}

function SideBySideDiffView({ diff }: { diff: SideBySideDiff }) {
  return (
    <div className="side-diff">
      <div className="side-diff-title">
        <FileText size={14} />
        <span>{diff.title}</span>
      </div>
      <div className="side-diff-grid">
        <div className="side-diff-heading">Original</div>
        <div className="side-diff-heading">Modified</div>
        {diff.rows.map((row, index) =>
          row.kind === "meta" ? (
            <div key={`meta-${index}`} className="side-diff-meta">
              {row.label}
            </div>
          ) : (
            <div key={`row-${index}-${row.oldNumber ?? ""}-${row.newNumber ?? ""}`} className="side-diff-row">
              <div className={`side-diff-cell old ${row.kind}`}>
                <span className="side-diff-number">{row.oldNumber ?? ""}</span>
                <code>{row.left ?? ""}</code>
              </div>
              <div className={`side-diff-cell new ${row.kind}`}>
                <span className="side-diff-number">{row.newNumber ?? ""}</span>
                <code>{row.right ?? ""}</code>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function approvalSubtitle(view: ApprovalView) {
  if (view.type === "shell") {
    return view.destructive ? "Review this command before it runs." : "Review this command before it runs.";
  }
  if (view.type === "write") {
    return view.destructive ? "Review the proposed file change." : "Review the proposed file change.";
  }
  if (view.type === "browser") {
    return view.destructive ? "Review this browser action." : "Review this browser read.";
  }
  if (view.type === "network") {
    return "Review this network request before it leaves the machine.";
  }
  return "The agent wants to perform an action that changes state or runs a command.";
}
