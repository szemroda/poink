/**
 * Formatting utilities for HATEOAS hint blocks.
 */

const HELP_REFERENCE = "`poink --help` for full reference.";

interface HintStats {
  documents: number;
}

function formatFooter(stats?: HintStats): string {
  if (!stats) {
    return `> ${HELP_REFERENCE}`;
  }
  return `> poink: ${stats.documents} documents. ${HELP_REFERENCE}`;
}

/**
 * Format non-empty hint strings into a markdown blockquote block.
 *
 * Output:
 * ```
 * ---
 * > **Next Actions**
 * > - `cmd` -- description
 * > ...
 * >
 * > poink: N documents. `poink --help` for full reference.
 * ```
 */
export function formatHintBlock(
  hints: string[],
  stats?: HintStats
): string {
  const lines = [
    "---",
    "> **Next Actions**",
    ...hints.map((hint) => `> - ${hint}`),
    ">",
    formatFooter(stats),
  ];

  return `\n${lines.join("\n")}`;
}
