import type { EmbeddableNode } from '../core/embeddings/types.js';
import { generateEmbeddingText } from '../core/embeddings/text-generator.js';
import { buildKeywordSummaryPrefix } from '../core/embeddings/keyword-summary.js';

export interface Neo4jEmbeddingTextResult {
  embeddingText: string;
  summaryText?: string;
}

const DEFAULT_EMBEDDING_TEXT_MAX_CHARS = 12_000;
const EMBEDDING_TEXT_MAX_CHARS_ENV = 'GITNEXUS_EMBEDDING_TEXT_MAX_CHARS';

const readEmbeddingTextMaxChars = (): number => {
  const raw = process.env[EMBEDDING_TEXT_MAX_CHARS_ENV];
  if (!raw) return DEFAULT_EMBEDDING_TEXT_MAX_CHARS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMBEDDING_TEXT_MAX_CHARS;
};

const truncateAtLineBoundary = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > maxChars * 0.5) return truncated.slice(0, lastNewline).trimEnd();
  return truncated.trimEnd();
};

const combineEmbeddingText = (summaryText: string | undefined, baseText: string): string => {
  const maxChars = readEmbeddingTextMaxChars();
  if (!summaryText) return truncateAtLineBoundary(baseText, maxChars);

  const separator = '\n\n';
  if (summaryText.length + separator.length >= maxChars) {
    return truncateAtLineBoundary(summaryText, maxChars);
  }

  const remainingBaseChars = maxChars - summaryText.length - separator.length;
  return `${summaryText}${separator}${truncateAtLineBoundary(baseText, remainingBaseChars)}`;
};

export const buildNeo4jEmbeddingText = async (
  node: EmbeddableNode,
  contentHash: string,
): Promise<Neo4jEmbeddingTextResult> => {
  const baseText = generateEmbeddingText(
    node,
    node.content?.trim() || `${node.label} ${node.name}`,
  );
  const summaryText = await buildKeywordSummaryPrefix(node, baseText, contentHash);
  return {
    embeddingText: combineEmbeddingText(summaryText, baseText),
    summaryText,
  };
};
