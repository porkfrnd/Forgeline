import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  safeRepoChildPath,
  resolveRealpath,
  stillInside,
  isInside,
} from "./paths.js";

describe("safeRepoChildPath", () => {
  const root = join(tmpdir(), "forgeline-string-root");

  it("accepts an ordinary repo-relative file", () => {
    const check = safeRepoChildPath(root, join("src", "app.ts"));
    expect(check.ok).toBe(true);
  });

  it("rejects parent-directory escapes", () => {
    expect(safeRepoChildPath(root, "../escape").ok).toBe(false);
    expect(safeRepoChildPath(root, join("sub", "..", "..", "escape")).ok).toBe(false);
  });

  it("rejects absolute paths and drive-letter forms", () => {
    expect(safeRepoChildPath(root, "/etc/passwd").ok).toBe(false);
    expect(safeRepoChildPath(root, "C:\\Windows\\x").ok).toBe(false);
  });

  it("rejects paths git would read as an option", () => {
    expect(safeRepoChildPath(root, "-weird").ok).toBe(false);
  });
});

describe("isInside", () => {
  it("treats the root itself and nested paths as inside", () => {
    expect(isInside("/r", "/r")).toBe(true);
    expect(isInside("/r", "/r/sub/file")).toBe(true);
  });

  it("is not fooled by a shared prefix", () => {
    expect(isInside("/r", "/r-evil/file")).toBe(false);
    expect(isInside("/r", "/other")).toBe(false);
  });
});

describe("symlink escapes", () => {
  let outer = "";
  let root = "";

  beforeEach(() => {
    outer = mkdtempSync(join(tmpdir(), "fl-outer-"));
    root = join(outer, "repo");
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(join(outer, "secret"), { recursive: true });
    writeFileSync(join(outer, "secret", "note.txt"), "outside\n");
    symlinkSync(join(outer, "secret"), join(root, "sub", "link"));
  });

  afterEach(() => {
    rmSync(outer, { recursive: true, force: true });
  });

  // Directory symlinks need elevated rights on Windows CI runners.
  it.runIf(process.platform !== "win32")(
    "notices when a trusted-looking path resolves outside the root",
    async () => {
      const check = safeRepoChildPath(root, join("sub", "link", "note.txt"));
      expect(check.ok).toBe(true);
      if (!check.ok || !check.path) return;
      const resolvedRoot = await resolveRealpath(root);
      const resolvedChild = await resolveRealpath(check.path);
      expect(stillInside(resolvedRoot, resolvedChild)).toBe(false);
    },
  );
});
