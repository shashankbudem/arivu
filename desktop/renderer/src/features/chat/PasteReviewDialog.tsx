import { Check, Scissors, X } from "lucide-react";
import { formatNumber } from "../../format";

export type PasteReview = {
  budget: number;
  fullText: string;
  truncatedText: string;
  pastedTokens: number;
  fullPromptTokens: number;
  truncatedPromptTokens: number;
  range: {
    start: number;
    end: number;
  };
};

export function PasteReviewDialog({
  review,
  onCancel,
  onInsertFull,
  onInsertTruncated
}: {
  review: PasteReview;
  onCancel: () => void;
  onInsertFull: () => void;
  onInsertTruncated: () => void;
}) {
  const canInsertTruncated = review.truncatedText.length > 0;

  return (
    <div className="modal-backdrop">
      <section className="approval-dialog paste-dialog" role="dialog" aria-modal="true" aria-label="Large paste detected">
        <div className="approval-icon paste-icon">
          <Scissors size={24} />
        </div>
        <h2>Large paste detected</h2>
        <p>
          The full prompt is estimated at {formatNumber(review.fullPromptTokens)} tokens. The composer budget is{" "}
          {formatNumber(review.budget)} tokens.
        </p>
        <div className="paste-stats">
          <div>
            <span>Pasted text</span>
            <strong>{formatNumber(review.pastedTokens)} tokens</strong>
          </div>
          <div>
            <span>Truncated prompt</span>
            <strong>{canInsertTruncated ? `${formatNumber(review.truncatedPromptTokens)} tokens` : "No room left"}</strong>
          </div>
        </div>
        <div className="approval-actions">
          <button type="button" className="deny-button" onClick={onCancel}>
            <X size={17} />
            Cancel
          </button>
          <button type="button" className="deny-button" onClick={onInsertFull}>
            <Check size={17} />
            Insert full
          </button>
          <button type="button" className="approve-button" onClick={onInsertTruncated} disabled={!canInsertTruncated}>
            <Scissors size={17} />
            Insert truncated
          </button>
        </div>
      </section>
    </div>
  );
}
