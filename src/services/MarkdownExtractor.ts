/**
 * Markdown Extraction Service
 *
 * Uses unified/remark ecosystem for proper AST-based markdown parsing.
 * Supports frontmatter extraction via gray-matter.
 */

import { Context, Effect, Layer, Schema } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { toString as mdastToString } from "mdast-util-to-string";
import matter from "gray-matter";
import type { Root, Heading, RootContent } from "mdast";
import {
  assertValidChunking,
  chunkNormalizedText,
  preprocessLargeMarkdownTables,
} from "../chunking.js";
import { resolveUserPath } from "../pathUtils.js";
import { LibraryConfig } from "../types.js";

// ============================================================================
// Custom Error Types
// ============================================================================

export class MarkdownNotFoundError extends Schema.TaggedError<MarkdownNotFoundError>()(
  "MarkdownNotFoundError",
  { path: Schema.String },
) {}

export class MarkdownExtractionError extends Schema.TaggedError<MarkdownExtractionError>()(
  "MarkdownExtractionError",
  { path: Schema.String, reason: Schema.String },
) {}

// ============================================================================
// Types
// ============================================================================

/**
 * Frontmatter data extracted from markdown
 */
export interface MarkdownFrontmatter {
  title?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
}

/**
 * A section of markdown content, typically delimited by headings
 */
export interface ExtractedSection {
  section: number;
  heading: string;
  headingLevel: number;
  headingPath: string[];
  text: string;
}

/**
 * Result of extracting markdown content
 */
export interface ExtractedMarkdown {
  frontmatter: MarkdownFrontmatter;
  sections: ExtractedSection[];
  sectionCount: number;
}

/**
 * A chunk of content ready for embedding
 */
export interface ProcessedChunk {
  page: number; // Using section number as "page" for consistency with PDF model
  chunkIndex: number;
  content: string;
}

// ============================================================================
// Service Definition
// ============================================================================

export class MarkdownExtractor extends Context.Tag("MarkdownExtractor")<
  MarkdownExtractor,
  {
    /**
     * Extract markdown into sections with frontmatter
     */
    readonly extract: (
      path: string,
    ) => Effect.Effect<
      ExtractedMarkdown,
      MarkdownExtractionError | MarkdownNotFoundError
    >;

    /**
     * Process markdown into chunks suitable for embedding
     */
    readonly process: (path: string) => Effect.Effect<
      {
        pageCount: number;
        chunks: ProcessedChunk[];
        frontmatter: MarkdownFrontmatter;
      },
      MarkdownExtractionError | MarkdownNotFoundError
    >;

    /**
     * Extract frontmatter only (fast path for title extraction)
     */
    readonly extractFrontmatter: (
      path: string,
    ) => Effect.Effect<
      MarkdownFrontmatter,
      MarkdownExtractionError | MarkdownNotFoundError
    >;
  }
>() {}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Sanitize text by removing null bytes that crash PostgreSQL TEXT columns
 */
export function sanitizeText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping null bytes
  return text.replace(/\x00/g, "");
}

/**
 * Create unified processor with remark plugins
 */
function createProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml", "toml"])
    .use(remarkGfm);
}

/**
 * Check if a node is a frontmatter node (yaml or toml)
 */
function isFrontmatterNode(node: RootContent): boolean {
  return node.type === "yaml" || (node as { type: string }).type === "toml";
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function renderTableSeparator(align: unknown): string {
  if (align === "left") return ":---";
  if (align === "right") return "---:";
  if (align === "center") return ":---:";
  return "---";
}

function renderMarkdownTable(node: RootContent): string | null {
  if (node.type !== "table") return null;

  const table = node as {
    align?: unknown[];
    children?: Array<{ children?: RootContent[] }>;
  };
  const rows =
    table.children?.map((row) =>
      (row.children ?? []).map((cell) => escapeTableCell(mdastToString(cell))),
    ) ?? [];

  if (rows.length === 0) return "";

  const width = Math.max(...rows.map((row) => row.length));
  const paddedRows = rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ""),
  ]);
  const align = table.align ?? [];
  const separator = Array.from({ length: width }, (_, index) =>
    renderTableSeparator(align[index]),
  );

  const renderRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    renderRow(paddedRows[0] ?? []),
    renderRow(separator),
    ...paddedRows.slice(1).map(renderRow),
  ].join("\n");
}

function renderMarkdownNode(node: RootContent): string {
  return renderMarkdownTable(node) ?? mdastToString(node);
}

function compactHeadingPath(
  headingStack: string[],
  headingLevel: number,
): string[] {
  return headingStack
    .slice(0, headingLevel)
    .filter((heading): heading is string => Boolean(heading));
}

/**
 * Parse markdown content into AST and extract sections
 */
function parseMarkdownAST(content: string): ExtractedSection[] {
  const processor = createProcessor();
  const tree = processor.parse(content) as Root;

  const sections: ExtractedSection[] = [];
  let currentSection = 0;
  let currentHeading = "";
  let currentHeadingLevel = 0;
  let currentHeadingPath: string[] = [];
  let currentContent: RootContent[] = [];
  const headingStack: string[] = [];

  /**
   * Flush current section to results
   */
  function flushSection() {
    if (currentContent.length > 0 || currentHeading) {
      const text = currentContent
        .map((node) => renderMarkdownNode(node))
        .join("\n\n")
        .trim();

      if (text || currentHeading) {
        sections.push({
          section: currentSection || 1,
          heading: currentHeading,
          headingLevel: currentHeadingLevel,
          headingPath: currentHeadingPath,
          text,
        });
      }
    }
  }

  // Walk through top-level children
  for (const node of tree.children) {
    // Skip frontmatter nodes (handled separately by gray-matter)
    if (isFrontmatterNode(node)) {
      continue;
    }

    if (node.type === "heading") {
      // Flush previous section
      flushSection();

      // Start new section
      currentSection = sections.length + 1;
      currentHeading = mdastToString(node);
      currentHeadingLevel = (node as Heading).depth;
      headingStack[currentHeadingLevel - 1] = currentHeading;
      headingStack.length = currentHeadingLevel;
      currentHeadingPath = compactHeadingPath(
        headingStack,
        currentHeadingLevel,
      );
      currentContent = [];
    } else {
      // Add to current section content
      currentContent.push(node);
    }
  }

  // Flush final section
  flushSection();

  // If no sections found, treat entire document as one section
  if (sections.length === 0 && content.trim()) {
    // Remove frontmatter for the fallback case
    const { content: bodyContent } = matter(content);
    sections.push({
      section: 1,
      heading: "",
      headingLevel: 0,
      headingPath: [],
      text: bodyContent.trim(),
    });
  }

  return sections;
}

/**
 * Extract frontmatter using gray-matter
 */
function extractFrontmatterData(content: string): MarkdownFrontmatter {
  try {
    const { data } = matter(content);
    return {
      title: typeof data.title === "string" ? data.title : undefined,
      description:
        typeof data.description === "string" ? data.description : undefined,
      tags: Array.isArray(data.tags)
        ? data.tags.filter((t): t is string => typeof t === "string")
        : undefined,
      ...data,
    };
  } catch {
    return {};
  }
}

/**
 * Split a large code block into smaller chunks while preserving syntax
 *
 * @param code - The code content (without backticks)
 * @param lang - The language identifier
 * @param maxSize - Maximum size per chunk
 * @returns Array of code block strings with backticks
 */
function splitCodeBlock(code: string, lang: string, maxSize: number): string[] {
  const lines = code.split("\n");
  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentLength = 0;

  // Account for backticks and language tag overhead
  const overhead = lang.length + 8; // ```lang\n...\n```
  const effectiveMax = maxSize - overhead;

  for (const line of lines) {
    const lineLength = line.length + 1; // +1 for newline

    if (currentLength + lineLength > effectiveMax && currentLines.length > 0) {
      // Flush current chunk
      chunks.push(`\`\`\`${lang}\n${currentLines.join("\n")}\n\`\`\``);
      currentLines = [];
      currentLength = 0;
    }

    currentLines.push(line);
    currentLength += lineLength;
  }

  // Flush remaining
  if (currentLines.length > 0) {
    chunks.push(`\`\`\`${lang}\n${currentLines.join("\n")}\n\`\`\``);
  }

  return chunks;
}

/**
 * Pre-process text to split large code blocks before chunking
 * This prevents the "restore code block" step from blowing up chunk sizes
 *
 * @param text - Raw markdown text
 * @param maxCodeBlockSize - Maximum size for a single code block
 * @returns Text with large code blocks split into smaller ones
 */
function preprocessLargeCodeBlocks(
  text: string,
  maxCodeBlockSize: number,
): string {
  return text.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    if (match.length <= maxCodeBlockSize) {
      return match; // Small enough, keep as-is
    }

    // Split large code block
    const chunks = splitCodeBlock(code.trim(), lang || "", maxCodeBlockSize);
    return chunks.join("\n\n");
  });
}

/**
 * Chunk text with intelligent splitting
 * Handles code blocks and tables specially to prevent oversized chunks
 */
function chunkText(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
): string[] {
  assertValidChunking(chunkSize, chunkOverlap);

  // Sanitize first to remove null bytes
  const sanitized = sanitizeText(text);

  // Pre-process large code blocks and tables BEFORE placeholder extraction
  // Use 80% of chunk size as max to leave room for surrounding context
  const maxElementSize = Math.floor(chunkSize * 0.8);
  let processed = preprocessLargeCodeBlocks(sanitized, maxElementSize);
  processed = preprocessLargeMarkdownTables(processed, maxElementSize);

  // Now extract code blocks for preservation during text chunking
  const codeBlocks: { placeholder: string; content: string }[] = [];
  const withPlaceholders = processed.replace(
    /```[\s\S]*?```|`[^`]+`/g,
    (match) => {
      // Only use placeholder if the code block is small enough
      // Large ones were already split above
      if (match.length <= maxElementSize) {
        const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
        codeBlocks.push({ placeholder, content: match });
        return placeholder;
      }
      // Keep large code blocks inline (they've been split)
      return match;
    },
  );

  // Clean up excessive whitespace while preserving paragraph breaks
  const cleaned = withPlaceholders
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned.length <= chunkSize) {
    // Restore code blocks
    let result = cleaned;
    for (const { placeholder, content } of codeBlocks) {
      result = result.replace(placeholder, content);
    }
    return result ? [result] : [];
  }

  const chunks = chunkNormalizedText(cleaned, chunkSize, chunkOverlap);
  return chunks.map((chunk) => {
    let restored = chunk;
    for (const { placeholder, content } of codeBlocks) {
      restored = restored.replace(placeholder, content);
    }
    return restored;
  });
}

/**
 * Resolve path with home directory expansion
 */
function resolvePath(path: string): string {
  return resolveUserPath(path);
}

// ============================================================================
// Service Layer
// ============================================================================

export const MarkdownExtractorLive = Layer.effect(
  MarkdownExtractor,
  Effect.gen(function* () {
    const config = LibraryConfig.fromEnv();

    return {
      extract: (path: string) =>
        Effect.gen(function* () {
          const resolvedPath = resolvePath(path);

          if (!existsSync(resolvedPath)) {
            return yield* Effect.fail(
              new MarkdownNotFoundError({ path: resolvedPath }),
            );
          }

          const result = yield* Effect.try({
            try: () => {
              const content = readFileSync(resolvedPath, "utf-8");
              const frontmatter = extractFrontmatterData(content);
              const sections = parseMarkdownAST(content);

              return {
                frontmatter,
                sections,
                sectionCount: sections.length,
              } as ExtractedMarkdown;
            },
            catch: (e) =>
              new MarkdownExtractionError({
                path: resolvedPath,
                reason: String(e),
              }),
          });

          return result;
        }),

      process: (path: string) =>
        Effect.gen(function* () {
          const resolvedPath = resolvePath(path);

          if (!existsSync(resolvedPath)) {
            return yield* Effect.fail(
              new MarkdownNotFoundError({ path: resolvedPath }),
            );
          }

          const { frontmatter, sections } = yield* Effect.try({
            try: () => {
              const content = readFileSync(resolvedPath, "utf-8");
              return {
                frontmatter: extractFrontmatterData(content),
                sections: parseMarkdownAST(content),
              };
            },
            catch: (e) =>
              new MarkdownExtractionError({
                path: resolvedPath,
                reason: String(e),
              }),
          });

          const allChunks: ProcessedChunk[] = [];

          for (const { section, heading, headingPath, text } of sections) {
            const contextHeading =
              headingPath.length > 0 ? headingPath.join(" > ") : heading;
            const sectionContent = contextHeading
              ? `# ${contextHeading}\n\n${text}`
              : text;
            const sectionChunks = chunkText(
              sectionContent,
              config.chunkSize,
              config.chunkOverlap,
            );
            sectionChunks.forEach((content, chunkIndex) => {
              allChunks.push({
                page: section, // Use section number as "page"
                chunkIndex,
                content,
              });
            });
          }

          return {
            pageCount: sections.length, // Section count as pseudo-pages
            chunks: allChunks,
            frontmatter,
          };
        }),

      extractFrontmatter: (path: string) =>
        Effect.gen(function* () {
          const resolvedPath = resolvePath(path);

          if (!existsSync(resolvedPath)) {
            return yield* Effect.fail(
              new MarkdownNotFoundError({ path: resolvedPath }),
            );
          }

          const result = yield* Effect.try({
            try: () => {
              const content = readFileSync(resolvedPath, "utf-8");
              return extractFrontmatterData(content);
            },
            catch: (e) =>
              new MarkdownExtractionError({
                path: resolvedPath,
                reason: String(e),
              }),
          });

          return result;
        }),
    };
  }),
);
