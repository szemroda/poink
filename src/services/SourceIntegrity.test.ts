import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either } from "effect";
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

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "poink-source-"));
  tempDirs.push(directory);
  return directory;
}

const ABC_SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("fingerprintSource", () => {
  test("hashes content with SHA-256 and counts bytes", async () => {
    const path = join(makeTempDir(), "source.bin");
    writeFileSync(path, Buffer.from("abc"));

    await expect(Effect.runPromise(fingerprintSource(path))).resolves.toEqual({
      identity: { algorithm: "sha256", hash: ABC_SHA256 },
      sizeBytes: 3,
    });
  });

  test.each([
    ["a missing path", "missing.pdf", SourceFileUnavailableError],
    ["a directory", "nested", SourceFileUnreadableError],
  ] as const)("rejects %s", async (_case, name, errorClass) => {
    const directory = makeTempDir();
    mkdirSync(join(directory, "nested"));

    const result = await Effect.runPromise(
      Effect.either(fingerprintSource(join(directory, name))),
    );

    expect(Either.isLeft(result) && result.left).toBeInstanceOf(errorClass);
  });

  test("follows symlinks to regular files", async () => {
    const directory = makeTempDir();
    const target = join(directory, "target.md");
    const link = join(directory, "link.md");
    writeFileSync(target, "linked content");

    try {
      symlinkSync(target, link, "file");
    } catch {
      // Creating symlinks needs extra privileges on Windows.
      return;
    }

    await expect(
      Effect.runPromise(fingerprintSource(link)),
    ).resolves.toEqual(
      await Effect.runPromise(fingerprintSource(target)),
    );
  });
});

describe("decodeStoredSourceIdentity", () => {
  test.each([
    ["both columns null", null, null, { status: "missing" }],
    ["non-hex hash", "sha256", "g".repeat(64), { status: "invalid" }],
    ["uppercase hash", "sha256", "A".repeat(64), { status: "invalid" }],
    ["short hash", "sha256", "a".repeat(63), { status: "invalid" }],
    ["unknown algorithm", "SHA256", "a".repeat(64), { status: "invalid" }],
    ["half-null columns", "sha256", null, { status: "invalid" }],
    [
      "a well-formed identity",
      "sha256",
      ABC_SHA256,
      { status: "valid", identity: { algorithm: "sha256", hash: ABC_SHA256 } },
    ],
  ] as const)("decodes %s", (_case, algorithm, hash, expected) => {
    expect(decodeStoredSourceIdentity(algorithm, hash)).toEqual(expected);
  });
});
