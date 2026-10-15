import { describe, expect, it } from "vitest";
import { summarizeRepo, summarizeRepos } from "./repo-summary.js";
import type { RepoEntry } from "./registry.js";
import { makeFixtureRepos } from "../../scripts/make-fixture-repos.js";

describe("summarizeRepo", () => {
  it("builds one dashboard row from a real repo", async () => {
    const fx = makeFixtureRepos();
    try {
      const entry: RepoEntry = { id: "opaque-id", path: fx.repos.clean };
      const row = await summarizeRepo(entry);
      expect(row).toEqual({
        id: "opaque-id",
        name: "clean",
        path: fx.repos.clean,
        branch: "main",
        changedFiles: 0,
        ahead: 0,
        behind: 0,
      });
    } finally {
      fx.cleanup();
    }
  }, 60000);

  it("counts changed files on a dirty repo", async () => {
    const fx = makeFixtureRepos();
    try {
      const row = await summarizeRepo({ id: "x", path: fx.repos.dirty });
      expect(row.changedFiles).toBeGreaterThan(0);
      expect(row.branch).toBe("main");
    } finally {
      fx.cleanup();
    }
  }, 60000);

  // Never throws: a path that is not a repo still yields a row, so one broken
  // repo cannot hide the rest of the dashboard.
  it("reports unknown rather than throwing on a non-repo path", async () => {
    const fx = makeFixtureRepos();
    try {
      const row = await summarizeRepo({ id: "x", path: fx.remotes });
      expect(row.branch).toBe("unknown");
      expect(row.changedFiles).toBe(0);
      expect(row.ahead).toBe(0);
      expect(row.behind).toBe(0);
    } finally {
      fx.cleanup();
    }
  }, 60000);

  it("uses an explicit name when one is supplied", async () => {
    const fx = makeFixtureRepos();
    try {
      const row = await summarizeRepo({ id: "x", path: fx.repos.clean }, "scanned-name");
      expect(row.name).toBe("scanned-name");
    } finally {
      fx.cleanup();
    }
  }, 60000);
});

describe("summarizeRepos", () => {
  it("returns rows sorted by path regardless of input order", async () => {
    const fx = makeFixtureRepos();
    try {
      const entries: RepoEntry[] = [
        { id: "b", path: fx.repos.dirty },
        { id: "a", path: fx.repos.clean },
        { id: "c", path: fx.repos.detached },
      ];
      const rows = await summarizeRepos(entries.map((entry) => ({ entry })));
      expect(rows.map((r) => r.path)).toEqual(
        [...rows.map((r) => r.path)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
      );
      expect(rows).toHaveLength(3);
    } finally {
      fx.cleanup();
    }
  }, 60000);
});
