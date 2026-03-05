/**
 * Conservative token estimate: ~1 token per 4 characters.
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const MAX_TOKENS_PER_PART = 7000;

/**
 * Splits text into parts of ~maxTokens tokens, never breaking mid-word.
 * Prefers paragraph boundaries (\n\n), then sentence boundaries (. ! ?), then line breaks (\n).
 */
export function splitIntoParts(
  text: string,
  maxTokens: number = MAX_TOKENS_PER_PART
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const parts: string[] = [];
  const paragraphs = trimmed.split(/\n\n+/);

  let current = "";

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    if (paraTokens > maxTokens) {
      if (current) {
        parts.push(current.trim());
        current = "";
      }
      const subParts = splitOversizedBlock(para, maxTokens);
      parts.push(...subParts);
      continue;
    }

    const withPara = current ? `${current}\n\n${para}` : para;
    if (estimateTokens(withPara) <= maxTokens) {
      current = withPara;
    } else {
      if (current) {
        parts.push(current.trim());
        current = "";
      }
      current = para;
    }
  }

  if (current) parts.push(current.trim());
  return parts;
}

/**
 * Splits a single block that exceeds maxTokens by sentences, then by lines.
 */
function splitOversizedBlock(block: string, maxTokens: number): string[] {
  const parts: string[] = [];
  const sentences = block.split(/(?<=[.!?])\s+/);

  let current = "";
  for (const sent of sentences) {
    const withSent = current ? `${current} ${sent}` : sent;
    if (estimateTokens(withSent) <= maxTokens) {
      current = withSent;
    } else {
      if (current) {
        parts.push(current.trim());
        current = "";
      }
      if (estimateTokens(sent) > maxTokens) {
        const byLines = sent.split(/\n/);
        for (const line of byLines) {
          const withLine = current ? `${current}\n${line}` : line;
          if (estimateTokens(withLine) <= maxTokens) {
            current = withLine;
          } else {
            if (current) {
              parts.push(current.trim());
              current = "";
            }
            current = line;
          }
        }
      } else {
        current = sent;
      }
    }
  }
  if (current) parts.push(current.trim());
  return parts;
}
