import { describe, expect, it } from "vitest";
import {
  aheadBehind,
  currentBranch,
  parseRevListCount,
  parseStatusChangedFiles,
  repoStatusFields,
} from "./git.js";
import { makeFixtureRepos } from "../../../scripts/make-fixture-repos.js";

describe("parseStatusChangedFiles", () => {
  it("counts change records and skips branch headers", () => {
    const out =
      "# branch.oid abc\0# branch.head main\0# branch.ab +0 -0\0" +
      "1 .M N... 100644 100644 100644 a a a.txt\0? b.txt\0";
    expect(parseStatusChangedFiles(out)).toBe(2);
  });

  it("counts zero when the tree is clean", () => {
    const out = "# branch.oid abc\0# branch.head main\0# branch.ab +0 -0\0";
    expect(parseStatusChangedFiles(out)).toBe(0);
  });
});

describe("parseRevListCount", () => {
  it("parses tab-separated ahead/behind counts", () => {
    expect(parseRevListCount("3\t1\n")).toEqual({ ahead: 3, behind: 1 });
  });

  it("falls back to zero on unexpected output", () => {
    expect(parseRevListCount("nope")).toEqual({ ahead: 0, behind: 0 });
  });
});

describe("git read helpers", () => {
  it("reads branch, changed files, and ahead/behind from real fixtures", async () => {
    const fx = makeFixtureRepos();
    try {
      expect(await currentBranch(fx.repos.clean)).toBe("main");
      expect(await currentBranch(fx.repos.detached)).toMatch(/^HEAD/);
      expect(await repoStatusFields(fx.repos.clean)).toMatchObject({
        branch: "main",
        changedFiles: 0,
      });
      const dirty = await repoStatusFields(fx.repos.dirty);
      expect(dirty.changedFiles).toBeGreaterThan(0);
      const ahead = await aheadBehind(fx.repos.ahead);
      expect(ahead.ahead).toBeGreaterThan(0);
      expect(ahead.behind).toBe(0);
      const behind = await aheadBehind(fx.repos.behind);
      expect(behind.behind).toBeGreaterThan(0);
      const noRemote = await aheadBehind(fx.repos.noRemote);
      expect(noRemote).toEqual({ ahead: 0, behind: 0 });
    } finally {
      fx.cleanup();
    }
  }, 60000);
});
