import { describe, expect, test } from "vitest";
import {
  chunkText,
  cleanPDFPageArtifacts,
  enhancePDFPageText,
  renderPDFTableAsMarkdown,
  sanitizeText,
} from "./PDFExtractor.js";

/** Builds numbered pages from per-page line arrays. */
function pagesFromLines(...pages: string[][]) {
  return pages.map((lines, index) => ({ page: index + 1, text: lines.join("\n") }));
}

test("sanitizeText strips null bytes and keeps everything else", () => {
  expect(sanitizeText("\x00café\x00\x00 naïve\x00")).toBe("café naïve");
});

describe("cleanPDFPageArtifacts", () => {
  test.each([
    {
      name: "removes repeated headers, footers, and page numbers",
      pages: pagesFromLines(
        ["Quarterly Report", "Revenue increased.", "Confidential", "Page 1 of 3"],
        ["Quarterly Report", "Margins improved.", "Confidential", "Page 2 of 3"],
        ["Quarterly Report", "Cash flow remained stable.", "Confidential", "Page 3 of 3"],
      ),
      expected: ["Revenue increased.", "Margins improved.", "Cash flow remained stable."],
    },
    {
      name: "keeps repeated body lines that are not page edges",
      pages: pagesFromLines(
        ["Header", "Intro 1", "More 1", "Important repeated finding.", "Detail 1", "Closing 1", "1"],
        ["Header", "Intro 2", "More 2", "Important repeated finding.", "Detail 2", "Closing 2", "2"],
      ),
      expected: [
        "Intro 1\nMore 1\nImportant repeated finding.\nDetail 1\nClosing 1",
        "Intro 2\nMore 2\nImportant repeated finding.\nDetail 2\nClosing 2",
      ],
    },
    {
      name: "keeps numeric-only body lines",
      pages: pagesFromLines(
        ["Header", "Intro 1", "42", "Body after number.", "1"],
        ["Header", "Intro 2", "42", "Other body after number.", "2"],
      ),
      expected: ["Intro 1\n42\nBody after number.", "Intro 2\n42\nOther body after number."],
    },
  ])("$name", ({ pages, expected }) => {
    expect(cleanPDFPageArtifacts(pages).map((page) => page.text)).toEqual(expected);
  });
});

describe("PDF table extraction helpers", () => {
  test("renders pdf-parse table arrays as Markdown tables", () => {
    const markdown = renderPDFTableAsMarkdown([
      ["Metric", "2026", "2025"],
      ["Revenue", "1 094 018", "580 294"],
      ["Net profit", "535 042", "193 923"],
    ]);

    expect(markdown).toBe(
      [
        "| Metric | 2026 | 2025 |",
        "| --- | ---: | ---: |",
        "| Revenue | 1 094 018 | 580 294 |",
        "| Net profit | 535 042 | 193 923 |",
      ].join("\n"),
    );
  });

  test("appends usable explicit pdf-parse tables and ignores one-cell detections", () => {
    const text = enhancePDFPageText("Body text", [
      [["chart-like noise only"]],
      [
        ["Name", "Value"],
        ["A", "1"],
      ],
    ]);

    expect(text).toBe(
      [
        "Body text",
        "## Detected PDF tables",
        "Table 1",
        "| Name | Value |\n| --- | ---: |\n| A | 1 |",
      ].join("\n\n"),
    );
  });
});

describe("chunkText", () => {
  test.each([
    {
      name: "joins wrapped lines but keeps paragraph boundaries",
      lines: ["Para 1 line one", "Para 1 line two", "", "Para 2 line one", "Para 2 line two", ""],
      expected: "Para 1 line one Para 1 line two\n\nPara 2 line one Para 2 line two",
    },
    {
      name: "removes hyphenation artifacts at line breaks",
      lines: ["This is inter-", "national text."],
      expected: "This is international text.",
    },
    {
      name: "marks likely section titles as headings",
      lines: [
        "Executive Summary",
        "This paragraph should remain under the section heading.",
        "",
        "FINDINGS",
        "These are the findings in body text.",
      ],
      expected:
        "# Executive Summary\n\nThis paragraph should remain under the section heading.\n\n# FINDINGS\n\nThese are the findings in body text.",
    },
    {
      name: "keeps Markdown table rows on separate lines",
      lines: [
        "| Pozycja | 31.03.2026 | 31.03.2025 |",
        "| --- | ---: | ---: |",
        "| Przychody | 1 094 018 | 580 294 |",
        "| Zysk netto | 535 042 | 193 923 |",
      ],
      expected: [
        "| Pozycja | 31.03.2026 | 31.03.2025 |",
        "| --- | ---: | ---: |",
        "| Przychody | 1 094 018 | 580 294 |",
        "| Zysk netto | 535 042 | 193 923 |",
      ].join("\n"),
    },
  ])("$name", ({ lines, expected }) => {
    expect(chunkText(lines.join("\n"), 10_000, 0)).toEqual([expected]);
  });

  test("keeps a short section title as its own chunk", () => {
    const input = ["Short", "", "This is a longer paragraph that should remain."].join("\n");

    expect(chunkText(input, 25, 0)).toEqual([
      "# Short",
      "This is a longer paragrap",
      "h that should remain.",
    ]);
  });
});
