import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
  SourceFileUnavailableError,
  SourceFileUnreadableError,
  decodeStoredSourceIdentity,
  fingerprintSource,
} from "./SourceIntegrity.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("source integrity", () => {
  test("streams SHA-256 while counting bytes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "poink-source-"));
    tempDirs.push(directory);
    const path = join(directory, "source.bin");
    writeFileSync(path, Buffer.from("abc"));

    const fingerprint = await Effect.runPromise(fingerprintSource(path));

    expect(fingerprint).toEqual({
      identity: {
        algorithm: "sha256",
        hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
      sizeBytes: 3,
    });
  });

  test("distinguishes unavailable and non-regular sources", async () => {
    const directory = mkdtempSync(join(tmpdir(), "poink-source-errors-"));
    tempDirs.push(directory);
    const nestedDirectory = join(directory, "nested");
    mkdirSync(nestedDirectory);

    const missing = await Effect.runPromise(
      Effect.either(fingerprintSource(join(directory, "missing.pdf"))),
    );
    const nonRegular = await Effect.runPromise(
      Effect.either(fingerprintSource(nestedDirectory)),
    );

    expect(missing._tag).toBe("Left");
    if (missing._tag === "Left") {
      expect(missing.left).toBeInstanceOf(SourceFileUnavailableError);
    }
    expect(nonRegular._tag).toBe("Left");
    if (nonRegular._tag === "Left") {
      expect(nonRegular.left).toBeInstanceOf(SourceFileUnreadableError);
    }
  });

  test("follows symlinks to regular files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "poink-source-link-"));
    tempDirs.push(directory);
    const target = join(directory, "target.md");
    const link = join(directory, "link.md");
    writeFileSync(target, "linked content");

    try {
      symlinkSync(target, link, "file");
    } catch {
      return;
    }

    await expect(
      Effect.runPromise(fingerprintSource(link)),
    ).resolves.toEqual(
      await Effect.runPromise(fingerprintSource(target)),
    );
  });

  test("validates stored identity without exposing it through documents", () => {
    expect(decodeStoredSourceIdentity(null, null)).toEqual({
      status: "missing",
    });
    expect(decodeStoredSourceIdentity("sha256", "g".repeat(64))).toEqual({
      status: "invalid",
    });
    expect(decodeStoredSourceIdentity("SHA256", "a".repeat(64))).toEqual({
      status: "invalid",
    });
  });
});
