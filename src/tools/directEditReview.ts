import { unifiedDiffStats } from "./patch.js";

export const DIRECT_EDIT_REVIEW_CHANGED_LINE_THRESHOLD = 120;
export const DIRECT_EDIT_REVIEW_FILE_THRESHOLD = 8;
export const DIRECT_EDIT_REVIEW_CONTENT_LINE_THRESHOLD = 240;
export const DIRECT_EDIT_REVIEW_CONTENT_BYTES_THRESHOLD = 16 * 1024;

export type DirectEditReview = {
  required: boolean;
  reason?: string;
  summary: string;
};

export function reviewForPatch(diff: string): DirectEditReview {
  const stats = unifiedDiffStats(diff);
  const triggers = [
    stats.changedLines >= DIRECT_EDIT_REVIEW_CHANGED_LINE_THRESHOLD
      ? `${stats.changedLines} changed lines`
      : undefined,
    stats.fileCount >= DIRECT_EDIT_REVIEW_FILE_THRESHOLD
      ? `${stats.fileCount} files`
      : undefined
  ].filter((trigger): trigger is string => Boolean(trigger));

  const summary = `${stats.fileCount} file${stats.fileCount === 1 ? "" : "s"}, +${stats.additions}/-${stats.deletions}`;
  return {
    required: triggers.length > 0,
    reason: triggers.length > 0 ? `Large direct patch (${triggers.join(", ")}) needs review before applying.` : undefined,
    summary
  };
}

export function reviewForFileWrite(content: string): DirectEditReview {
  const bytes = Buffer.byteLength(content, "utf8");
  const lines = countLines(content);
  const triggers = [
    lines >= DIRECT_EDIT_REVIEW_CONTENT_LINE_THRESHOLD
      ? `${lines} lines`
      : undefined,
    bytes >= DIRECT_EDIT_REVIEW_CONTENT_BYTES_THRESHOLD
      ? `${formatBytes(bytes)}`
      : undefined
  ].filter((trigger): trigger is string => Boolean(trigger));

  return {
    required: triggers.length > 0,
    reason: triggers.length > 0 ? `Large direct file write (${triggers.join(", ")}) needs review before applying.` : undefined,
    summary: `${lines} line${lines === 1 ? "" : "s"}, ${formatBytes(bytes)}`
  };
}

function countLines(text: string) {
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
