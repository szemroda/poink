import type { Document } from "./types.js";

type EmbeddableChunk = {
  page: number;
  content: string;
  embeddingContent?: string | undefined;
};

function sectionFromChunkContent(content: string): string | null {
  return content.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() || null;
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function tableEmbeddingText(content: string): string | null {
  const tables = content.match(
    /\|[^\n]+\|\n\|[-:\s|]+\|\n(?:\|[^\n]+\|\n?)+/g,
  );
  if (!tables) return null;

  const rendered: string[] = [];
  for (const table of tables) {
    const lines = table.trim().split("\n");
    const columns = parseMarkdownTableRow(lines[0] ?? "");
    if (columns.length === 0) continue;
    const rows = lines.slice(2).map(parseMarkdownTableRow);
    rendered.push(`Columns: ${columns.join(" | ")}`);
    rows.forEach((row, index) => {
      const values = columns.map(
        (column, cellIndex) => `${column}=${row[cellIndex] ?? ""}`,
      );
      rendered.push(`Row ${index + 1}: ${values.join("; ")}`);
    });
  }
  return rendered.length > 0 ? rendered.join("\n") : null;
}

/**
 * Build the text sent to the embedding model for a chunk: document, section
 * and page context, the chunk body, and a row-by-row rendering of any tables.
 * Ingestion and reindexing must both use this so their embeddings match.
 */
export function buildEmbeddingContent(
  doc: Pick<Document, "title">,
  chunk: EmbeddableChunk,
): string {
  const context = [`Document: ${doc.title}`];
  const section = sectionFromChunkContent(chunk.content);
  if (section) context.push(`Section: ${section}`);
  if (chunk.page > 0) context.push(`Page: ${chunk.page}`);
  const baseContent = chunk.embeddingContent ?? chunk.content;
  const tableContent = tableEmbeddingText(baseContent);
  const body = tableContent
    ? `${baseContent}\n\n${tableContent}`
    : baseContent;
  return `${context.join("\n")}\n\n${body}`;
}

/**
 * Build the text sent to the embedding model for a taxonomy concept. Every
 * path that stores a concept vector must use this so rebuilds reproduce it.
 */
export function conceptEmbeddingText(concept: {
  prefLabel: string;
  definition?: string | undefined;
}): string {
  return concept.definition
    ? `${concept.prefLabel}: ${concept.definition}`
    : concept.prefLabel;
}
