export type TokenTruncation = {
  text: string;
  estimatedTokens: number;
  truncated: boolean;
};

const TOKEN_PART_PATTERN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const ASCII_WORD_PATTERN = /^[\x00-\x7F]+$/;
const WORD_PATTERN = /^[\p{L}\p{N}_]+$/u;

export const TRUNCATION_NOTICE = "\n\n[Truncated before sending: pasted text exceeded the composer token budget.]";

export function estimateTokenCount(text: string) {
  if (!text.trim()) {
    return 0;
  }

  return tokenParts(text).reduce((total, part) => total + estimatePartTokens(part), 0);
}

export function truncateTextToTokenBudget(text: string, maxTokens: number): TokenTruncation {
  if (maxTokens <= 0) {
    return { text: "", estimatedTokens: 0, truncated: true };
  }

  const totalTokens = estimateTokenCount(text);
  if (totalTokens <= maxTokens) {
    return { text, estimatedTokens: totalTokens, truncated: false };
  }

  const noticeTokens = estimateTokenCount(TRUNCATION_NOTICE);
  const contentBudget = Math.max(1, maxTokens - noticeTokens);
  let usedTokens = 0;
  let output = "";

  for (const part of tokenParts(text)) {
    const partTokens = estimatePartTokens(part);
    if (partTokens === 0) {
      output += part;
      continue;
    }

    if (usedTokens + partTokens <= contentBudget) {
      output += part;
      usedTokens += partTokens;
      continue;
    }

    const remaining = contentBudget - usedTokens;
    if (remaining > 0) {
      const characters = Array.from(part);
      const keepCount = Math.max(1, Math.floor((characters.length * remaining) / partTokens));
      output += characters.slice(0, keepCount).join("");
    }
    break;
  }

  let truncatedContent = output.trimEnd();
  let truncatedText = `${truncatedContent}${TRUNCATION_NOTICE}`;
  while (estimateTokenCount(truncatedText) > maxTokens && truncatedContent.length > 0) {
    truncatedContent = Array.from(truncatedContent).slice(0, -1).join("").trimEnd();
    truncatedText = `${truncatedContent}${TRUNCATION_NOTICE}`;
  }

  return {
    text: truncatedText,
    estimatedTokens: estimateTokenCount(truncatedText),
    truncated: true
  };
}

function tokenParts(text: string) {
  return text.match(TOKEN_PART_PATTERN) ?? [];
}

function estimatePartTokens(part: string) {
  if (/^\s+$/.test(part)) {
    return part.includes("\n") ? part.split("\n").length - 1 : 0;
  }

  if (WORD_PATTERN.test(part)) {
    if (ASCII_WORD_PATTERN.test(part)) {
      return Math.max(1, Math.ceil(part.length / 4));
    }
    return Math.max(1, Math.ceil(Array.from(part).length / 2));
  }

  return Math.max(1, Array.from(part).length);
}
