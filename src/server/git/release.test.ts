import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git.js";
import {
  bumpVersion,
  listTags,
  localDate,
  nextVersion,
  planRelease,
  readVersion,
  renderChangelogSection,
  tagRelease,
  writeChangelog,
} from "./release.js";

/**
 * `nextVersion` is a pure function about semVER, so it is tested directly —
 * including the cases that must *not* be guessed at. Everything else is tested
 * against real repositories with real `package.json` files on disk.
 */

async function makeRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main", "."]);
  await git(dir, ["config", "user.email", "ada@fixture.invalid"]);
  await git(dir, ["config", "user.name", "Ada Fixture"]);
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "demo", version: "1.2.3" }, null, 2)}\n`,
  );
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "chore: initial"]);
}

const git = async (cwd: string, args: string[]) => runGit(["-C", cwd, ...args], { cwd });

/** A commit in the conventional-commit style, so the changelog has something to sort. */
async function committed(dir: string, message: string, body?: string) {
  writeFileSync(join(dir, "note.txt"), `${message}\n${body ?? ""}`);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", message, ...(body ? ["-m", body] : [])]);
}

describe("reading the version", () => {
  it("reads the version out of a real package.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-release-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      expect(await readVersion(repo)).toBe("1.2.3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null rather than inventing one when there is no package.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-release-"));
    try {
      const repo = join(root, "demo");
      mkdirSync(repo, { recursive: true });
      await git(repo, ["init", "-q", "-b", "main", "."]);
      writeFileSync(join(repo, "readme.md"), "nothing here\n");
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-q", "-m", "base"]);
      // No version is a state the interface has to say out loud, not a number
      // to make up. A release tool that decided the version would decide it
      // wrong.
      expect(await readVersion(repo)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("nextVersion", () => {
  it("bumps each level by the semVER rules", () => {
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
  });

  it("works whether or not the version carries a leading v", () => {
    expect(nextVersion("v1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersion("v1.2.3", "patch")).toBe("1.2.4");
  });

  it("bumps from the numbers in a pre-release, leaving the tag behind", () => {
    // A release tool must not turn "1.2.4-beta.1" into "1.2.4" by policy: that
    // would be inventing a decision about whether the beta shipped. The
    // numbers are bumped and the suffix dropped, which is the one reading that
    // needs no policy.
    expect(nextVersion("1.2.4-beta.1", "patch")).toBe("1.2.5");
    expect(nextVersion("1.2.4-beta.1", "minor")).toBe("1.3.0");
  });

  it("refuses a version that is not semVER instead of guessing", () => {
    // A date stamp or a codename is not a semVER, and guessing at what the
    // next one should be is exactly what this tool must not do.
    expect(nextVersion("2024-01-02", "minor")).toBeNull();
    expect(nextVersion("banana", "patch")).toBeNull();
    expect(nextVersion("1.2", "patch")).toBeNull();
  });
});

describe("planning a release", () => {
  it("lists the commits since the last tag, newest first", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-release-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await committed(repo, "feat: add a thing");
      await committed(repo, "fix: mend the thing");
      await git(repo, ["tag", "-a", "v1.0.0", "-m", "first"]);

      await committed(repo, "feat: another thing");

      const plan = await planRelease(repo);
      expect(plan.latestTag).toBe("v1.0.0");
      expect(plan.commitsSince.map((c) => c.subject)).toEqual(["feat: another thing"]);
      expect(plan.hasChanges).toBe(true);
      expect(plan.currentVersion).toBe("1.2.3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says there is nothing to release when HEAD is already tagged", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-release-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await committed(repo, "feat: only commit");
      await git(repo, ["tag", "-a", "v1.2.3", "-m", "the whole thing"]);

      const plan = await planRelease(repo);
      expect(plan.latestTag).toBe("v1.2.3");
      expect(plan.commitsSince).toEqual([]);
      expect(plan.hasChanges).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes merge commits, which are not things anyone did", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-release-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await git(repo, ["switch", "-q", "-c", "side"]);
      await committed(repo, "feat: side work");
      await git(repo, ["switch", "-q", "main"]);
      await committed(repo, "feat: main work");
      await git(repo, ["merge", "-q", "--no-ff", "-m", "Merge branch 'side'", "side"]);

      const plan = await planRelease(repo);
      // "Merge branch 'side'" in a changelog is noise. What is listed is the
      // history git reaches, which is main's own commits: the merge is the
      // thing that would have brought the side's work in, and it is excluded,
      // so this is a first-parent view and says so rather than pretending to
      // include work that is only on a branch.
      expect(plan.commitsSince.map((c) => c.subject)).toEqual(["feat: main work", "chore: initial"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists tags with the commits they sit on", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-release-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await committed(repo, "feat: the only one");
      await git(repo, ["tag", "-a", "v1.2.3", "-m", "it"]);

      const tags = await listTags(repo);
      expect(tags).toHaveLength(1);
      expect(tags[0].name).toBe("v1.2.3");
      const head = await git(repo, ["rev-parse", "HEAD"]);
      expect(tags[0].sha).toBe(head.stdout.trim());
      expect(tags[0].subject).toBe("feat: the only one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the changelog", () => {
  it("sorts conventional subjects into Added, Fixed, and Changed", () => {
    const subjects = [
      "fix: mend a thing",
      "feat: build a thing",
      "chore: tidy the tools",
      "feat(api): another thing",
    ];
    const section = renderChangelogSection("1.3.0", subjects, "2026-10-16");
    expect(section).toContain("## [1.3.0] - 2026-10-16");
    expect(section).toContain("### Added");
    expect(section).toContain("- build a thing");
    // The scope is stripped from the reader's view — it is for the commit, not
    // for the person who wants to know what changed.
    expect(section).toContain("- another thing");
    expect(section).toContain("### Fixed");
    expect(section).toContain("- mend a thing");
    expect(section).toContain("### Changed");
    expect(section).toContain("- tidy the tools");
  });

  it("omits a heading with nothing under it rather than printing it empty", () => {
    const section = renderChangelogSection("2.0.0", ["feat: only this"], "2026-10-16");
    expect(section).toContain("### Added");
    expect(section).not.toContain("### Fixed");
    expect(section).not.toContain("### Changed");
  });

  it("writes a new section above what was already there", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-release-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [1.0.0] - 2020-01-01\n\n### Added\n\n- the very beginning\n");
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-q", "-m", "docs: changelog"]);

      const written = await writeChangelog(repo, "CHANGELOG.md", renderChangelogSection("1.1.0", ["feat: new"], "2026-10-16"));
      expect(written.ok).toBe(true);
      const text = readFileSync(join(repo, "CHANGELOG.md"), "utf8");
      // Newest first, which is what anyone reading a changelog needs.
      expect(text.indexOf("1.1.0")).toBeLessThan(text.indexOf("1.0.0"));
      expect(text).toContain("1.1.0");
      expect(text).toContain("1.0.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts a changelog where there was none", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-release-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      const written = await writeChangelog(repo, "CHANGELOG.md", renderChangelogSection("0.1.0", ["feat: first"], "2026-10-16"));
      expect(written.ok).toBe(true);
      expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toContain("0.1.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bumping and tagging", () => {
  it("writes the new version into package.json and stages it", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-release-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);

      const bumped = await bumpVersion(repo, "1.2.3", "1.3.0");
      expect(bumped.ok).toBe(true);
      // On disk, not just in the answer, and formatted the way a JSON file
      // should be rather than written by hand.
      expect(readFileSync(join(repo, "package.json"), "utf8")).toContain('"version": "1.3.0"');
      expect(await readVersion(repo)).toBe("1.2.3");
      const staged = await git(repo, ["diff", "--cached", "--name-only"]);
      expect(staged.stdout.trim()).toBe("package.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to bump from a version that is not really there", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-release-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      // A caller that read the version from somewhere else must not be able to
      // overwrite it with a number this function then reports as success.
      const bumped = await bumpVersion(repo, "9.9.9", "1.0.0");
      expect(bumped.ok).toBe(false);
      expect(readFileSync(join(repo, "package.json"), "utf8")).toContain('"version": "1.2.3"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes a tag on the current commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-release-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await committed(repo, "feat: the release");
      const head = await git(repo, ["rev-parse", "HEAD"]);

      const tagged = await tagRelease(repo, "v1.2.3", "the first release");
      expect(tagged.ok).toBe(true);
      const onTag = await git(repo, ["rev-parse", "v1.2.3^{commit}"]);
      expect(onTag.stdout.trim()).toBe(head.stdout.trim());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a tag that already exists, because a tag is not a switch", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-release-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await committed(repo, "feat: one");
      await git(repo, ["tag", "-a", "v1.0.0", "-m", "first"]);
      await committed(repo, "feat: two");

      const again = await tagRelease(repo, "v1.0.0", "overwrite?");
      expect(again.ok).toBe(false);
      expect(again.output).toContain("already a tag called v1.0.0");
      // The old tag is untouched: pointing it at a new commit is the one
      // operation in this whole feature that a user cannot take back.
      const stillOn = await git(repo, ["rev-parse", "v1.0.0^{commit}"]);
      const first = await git(repo, ["rev-parse", "HEAD~1"]);
      expect(stillOn.stdout.trim()).toBe(first.stdout.trim());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a path outside the repository when writing", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-release-"));
    const outside = mkdtempSync(join(tmpdir(), "fl-release-outside-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      writeFileSync(join(outside, "precious.md"), "must survive\n");

      const written = await writeChangelog(repo, "../fl-release-outside-secret/precious.md", "overwritten\n");
      expect(written.ok).toBe(false);
      expect(readFileSync(join(outside, "precious.md"), "utf8")).toBe("must survive\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("the changelog date", () => {
  it("uses the local date, not the UTC one", () => {
    // On a machine east of Greenwich a release made this morning is dated
    // *yesterday* by toISOString, which disagrees with every commit timestamp
    // the user just looked at. This kind of thing is only noticed by someone
    // actually reading a changelog.
    const late = new Date(2026, 9, 16, 0, 30);
    expect(localDate(late)).toBe("2026-10-16");
    const early = new Date(2026, 9, 16, 23, 30);
    expect(localDate(early)).toBe("2026-10-16");
  });
});
