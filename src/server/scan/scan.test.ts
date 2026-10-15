import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepos } from "./scan.js";
import { makeFixtureRepos } from "../../../scripts/make-fixture-repos.js";

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
}

describe("scanRepos", () => {
  it("finds repos nested under a root and skips node_modules and dot-folders", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-scan-"));
    try {
      initRepo(join(root, "alpha"));
      initRepo(join(root, "group", "beta"));
      initRepo(join(root, "node_modules", "sneaky"));
      initRepo(join(root, ".hidden", "sneaky2"));
      writeFileSync(join(root, ".hidden-note"), "not a dot-folder\n");

      const found = await scanRepos([root]);
      expect(found.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
      expect(found.every((r) => r.path.startsWith(root))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans a root that is itself a repo as exactly that repo", async () => {
    const fx = makeFixtureRepos();
    try {
      const found = await scanRepos([fx.repos.clean]);
      expect(found).toHaveLength(1);
      expect(found[0]?.path).toBe(fx.repos.clean);
      expect(found[0]?.name).toBe("clean");
    } finally {
      fx.cleanup();
    }
  });

  it("never descends into symlinked directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-scan-link-"));
    const outside = mkdtempSync(join(tmpdir(), "fl-scan-out-"));
    try {
      initRepo(join(outside, "real"));
      symlinkSync(outside, join(root, "link"));
      initRepo(join(root, "mine"));
      const found = await scanRepos([root]);
      expect(found.map((r) => r.name)).toEqual(["mine"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("treats unreadable roots as empty instead of throwing", async () => {
    await expect(scanRepos([join(tmpdir(), "fl-scan-missing-xyz")])).resolves.toEqual([]);
  });
});
