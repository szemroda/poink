/**
 * Tests for unified search result types
 */

import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  EntityType,
  ConceptSearchResult,
  DocumentSearchResult,
  UnifiedSearchResult,
  SearchOptions,
  LibraryConfig,
  Document,
  expandHomePath,
} from "./types";
import { withEnv } from "./testUtils.js";

describe("Unified Search Types", () => {
  describe("EntityType", () => {
    test("should accept 'document' literal", () => {
      const entityType: EntityType = "document";
      expect(entityType).toBe("document");
    });

    test("should accept 'concept' literal", () => {
      const entityType: EntityType = "concept";
      expect(entityType).toBe("concept");
    });
  });

  describe("DocumentSearchResult", () => {
    test("should create valid document search result", () => {
      const result = new DocumentSearchResult({
        chunkId: "doc-123-0",
        docId: "doc-123",
        title: "Test Document",
        page: 1,
        chunkIndex: 0,
        content: "Test content",
        score: 0.95,
        rawScore: 0.95,
        scoreType: "cosine_similarity",
        vectorScore: 0.95,
        matchType: "vector",
        entityType: "document",
      });

      expect(result.entityType).toBe("document");
      expect(result.docId).toBe("doc-123");
      expect(result.score).toBe(0.95);
    });

    test("should support optional expanded content", () => {
      const result = new DocumentSearchResult({
        chunkId: "doc-123-0",
        docId: "doc-123",
        title: "Test Document",
        page: 1,
        chunkIndex: 0,
        content: "Test content",
        score: 0.95,
        rawScore: 0.95,
        scoreType: "cosine_similarity",
        vectorScore: 0.95,
        matchType: "vector",
        entityType: "document",
        expandedContent: "Expanded test content",
        expandedRange: { start: 0, end: 2 },
      });

      expect(result.expandedContent).toBe("Expanded test content");
      expect(result.expandedRange).toEqual({ start: 0, end: 2 });
    });
  });

  describe("ConceptSearchResult", () => {
    test("should create valid concept search result", () => {
      const result = new ConceptSearchResult({
        conceptId: "concept-456",
        prefLabel: "Machine Learning",
        definition: "A subset of artificial intelligence...",
        score: 0.88,
        rawScore: 0.88,
        scoreType: "cosine_similarity",
        entityType: "concept",
      });

      expect(result.entityType).toBe("concept");
      expect(result.conceptId).toBe("concept-456");
      expect(result.prefLabel).toBe("Machine Learning");
      expect(result.score).toBe(0.88);
    });
  });

  describe("UnifiedSearchResult", () => {
    test("should accept DocumentSearchResult", () => {
      const docResult: UnifiedSearchResult = new DocumentSearchResult({
        chunkId: "doc-123-0",
        docId: "doc-123",
        title: "Test Document",
        page: 1,
        chunkIndex: 0,
        content: "Test content",
        score: 0.95,
        rawScore: 0.95,
        scoreType: "cosine_similarity",
        vectorScore: 0.95,
        matchType: "vector",
        entityType: "document",
      });

      expect(docResult.entityType).toBe("document");
    });

    test("should accept ConceptSearchResult", () => {
      const conceptResult: UnifiedSearchResult = new ConceptSearchResult({
        conceptId: "concept-456",
        prefLabel: "Machine Learning",
        definition: "A subset of artificial intelligence...",
        score: 0.88,
        rawScore: 0.88,
        scoreType: "cosine_similarity",
        entityType: "concept",
      });

      expect(conceptResult.entityType).toBe("concept");
    });

    test("should discriminate by entityType", () => {
      const results: UnifiedSearchResult[] = [
        new DocumentSearchResult({
          chunkId: "doc-123-0",
          docId: "doc-123",
          title: "Test Document",
          page: 1,
          chunkIndex: 0,
          content: "Test content",
          score: 0.95,
          rawScore: 0.95,
          scoreType: "cosine_similarity",
          vectorScore: 0.95,
          matchType: "vector",
          entityType: "document",
        }),
        new ConceptSearchResult({
          conceptId: "concept-456",
          prefLabel: "Machine Learning",
          definition: "A subset of artificial intelligence...",
          score: 0.88,
          rawScore: 0.88,
          scoreType: "cosine_similarity",
          entityType: "concept",
        }),
      ];

      const docResults = results.filter(
        (r): r is DocumentSearchResult => r.entityType === "document"
      );
      const conceptResults = results.filter(
        (r): r is ConceptSearchResult => r.entityType === "concept"
      );

      expect(docResults).toHaveLength(1);
      expect(conceptResults).toHaveLength(1);
      expect(docResults[0].docId).toBe("doc-123");
      expect(conceptResults[0].conceptId).toBe("concept-456");
    });
  });

  describe("SearchOptions with entityTypes", () => {
    test("should accept entityTypes filter", () => {
      const options = new SearchOptions({
        limit: 10,
        entityTypes: ["document", "concept"],
      });

      expect(options.entityTypes).toEqual(["document", "concept"]);
    });

    test("should accept single entity type", () => {
      const options = new SearchOptions({
        limit: 10,
        entityTypes: ["document"],
      });

      expect(options.entityTypes).toEqual(["document"]);
    });

    test("should be optional (backwards compatibility)", () => {
      const options = new SearchOptions({
        limit: 10,
      });

      expect(options.entityTypes).toBeUndefined();
    });
  });

});

describe("LibraryConfig path resolution", () => {
  test("defaults to .poink when config omits a library path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "poink-types-"));

    try {
      withEnv(
        {
          POINK_CONFIG: join(tempDir, "config.json"),
          HOME: undefined,
          USERPROFILE: "C:\\Users\\tester",
        },
        () => {
          const config = LibraryConfig.fromEnv();

          expect(config.libraryPath).toBe("C:\\Users\\tester\\.poink");
          expect(config.dbPath).toBe("C:\\Users\\tester\\.poink\\library.db");
        },
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("expands ~ using the resolved home directory", () => {
    withEnv({ HOME: undefined, USERPROFILE: "C:\\Users\\tester" }, () => {
      expect(expandHomePath("~")).toBe("C:\\Users\\tester");
      expect(expandHomePath("~/docs/file.pdf")).toBe(
        "C:\\Users\\tester\\docs\\file.pdf"
      );
    });
  });
});

describe("Document file types", () => {
  test("accepts DOCX and ODT file types", () => {
    const docx = new Document({
      id: "docx-1",
      title: "Word Notes",
      path: "/tmp/notes.docx",
      addedAt: new Date("2024-01-01T00:00:00Z"),
      pageCount: 1,
      sizeBytes: 123,
      tags: [],
      fileType: "docx",
    });
    const odt = new Document({
      id: "odt-1",
      title: "ODT Notes",
      path: "/tmp/notes.odt",
      addedAt: new Date("2024-01-01T00:00:00Z"),
      pageCount: 1,
      sizeBytes: 123,
      tags: [],
      fileType: "odt",
    });

    expect(docx.fileType).toBe("docx");
    expect(odt.fileType).toBe("odt");
  });
});
