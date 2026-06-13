/**
 * Formatting utilities for HATEOAS hint blocks.
 */

const EMOJI_PATTERN =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
const HELP_REFERENCE = "`poink --help` for full reference.";

interface HintStats {
  documents: number;
  concepts?: number;
}

/**
 * Strip emoji characters from text (for cleaner machine-readable output).
 */
export function stripEmoji(text: string): string {
  return text.replace(EMOJI_PATTERN, "").replace(/\s{2,}/g, " ").trim();
}

function formatFooter(stats?: HintStats): string {
  if (!stats) {
    return `> ${HELP_REFERENCE}`;
  }

  const summary = [`${stats.documents} documents`];
  if (stats.concepts !== undefined && stats.concepts > 0) {
    summary.push(`${stats.concepts} concepts`);
  }

  return `> poink: ${summary.join(", ")}. ${HELP_REFERENCE}`;
}

/**
 * Format hint strings into a markdown blockquote block.
 *
 * Output:
 * ```
 * ---
 * > **Next Actions**
 * > - `cmd` -- description
 * > ...
 * >
 * > poink: N documents, M concepts. `poink --help` for full reference.
 * ```
 */
export function formatHintBlock(
  hints: string[],
  stats?: HintStats
): string {
  if (hints.length === 0) {
    return "";
  }

  const lines = [
    "---",
    "> **Next Actions**",
    ...hints.map((hint) => `> - ${hint}`),
    ">",
    formatFooter(stats),
  ];

  return `\n${lines.join("\n")}`;
}
