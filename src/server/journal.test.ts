import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDataDir, readJson, setAppDataDirForTest } from "./appdata.js";
import { appendJournal, journaled, readJournal, type JournalEntry } from "./journal.js";
import { readRefs } from "./git/git.js";
import { runGit } from "./git/git.js";

async function git(dir: string, args: string[]): Promise<void> {
  const res = await runGit(["-C", dir, ...args], { cwd: dir });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
}

/** A repo with one commit, so refs have something real to move. */
async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "fl-journal-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "ada@fixture.invalid"]);
  await git(repo, ["config", "user.name", "Ada Fixture"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-m", "Base"]);
  return repo;
}

describe("readRefs", () => {
  it("reports HEAD, branch, and no stash", async () => {
    const repo = await makeRepo();
    try {
      const refs = await readRefs(repo);
      expect(refs.branch).toBe("main");
      expect(refs.head).toMatch(/^[0-9a-f]{40}$/);
      expect(refs.hasStash).toBe(false);
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  }, 60000);

  it("reports HEAD and a stash once one exists", async () => {
    const repo = await makeRepo();
    try {
      writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
      await git(repo, ["stash"]);
      const refs = await readRefs(repo);
      expect(refs.hasStash).toBe(true);
      expect(refs.branch).toBe("main");
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  }, 60000);
});

describe("journal storage", () => {
  let dir: string;
  const original = process.env.FORGELINE_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fl-journal-store-"));
    process.env.FORGELINE_DATA_DIR = dir;
    setAppDataDirForTest(null);
  });

  afterEach(() => {
    setAppDataDirForTest(null);
    if (original === undefined) delete process.env.FORGELINE_DATA_DIR;
    else process.env.FORGELINE_DATA_DIR = original;
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads an empty journal when no file exists", async () => {
    expect(await readJournal()).toEqual([]);
  });

  it("reads a corrupted journal as empty rather than throwing", async () => {
    writeFileSync(join(appDataDir(), "journal.json"), "not json at all", "utf8");
    expect(await readJournal()).toEqual([]);
  });

  it("keeps the newest entry first and survives a reload", async () => {
    const base = {
      repoPath: "/tmp/r",
      command: "git add",
      refs: {
        before: { head: "a".repeat(40), branch: "main", hasStash: false },
        after: { head: "a".repeat(40), branch: "main", hasStash: false },
      },
      undoable: true,
    } satisfies Omit<JournalEntry, "id" | "at" | "description">;

    await appendJournal({ ...base, id: "1", at: "2026-10-15T10:00:00.000Z", description: "older" });
    await appendJournal({ ...base, id: "2", at: "2026-10-15T11:00:00.000Z", description: "newer" });

    const entries = await readJournal();
    expect(entries.map((e) => e.id)).toEqual(["2", "1"]);
    // Read back from disk with the module-internal cache out of the way.
    const onDisk = await readJson<{ entries: Array<{ id: string }> }>("journal.json");
    expect(onDisk?.entries.map((e) => e.id)).toEqual(["2", "1"]);
  });
});

describe("journaled", () => {
  let dir: string;
  const original = process.env.FORGELINE_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fl-journaled-"));
    process.env.FORGELINE_DATA_DIR = dir;
    setAppDataDirForTest(null);
  });

  afterEach(() => {
    setAppDataDirForTest(null);
    if (original === undefined) delete process.env.FORGELINE_DATA_DIR;
    else process.env.FORGELINE_DATA_DIR = original;
    rmSync(dir, { recursive: true, force: true });
  });

  it("records refs before and after a successful action", async () => {
    const repo = await makeRepo();
    try {
      const res = await journaled(repo, "Committed: hello", () =>
        runGit(["-C", repo, "commit", "--allow-empty", "-m", "hello"], { cwd: repo }),
      );
      expect(res.exitCode).toBe(0);

      const entries = await readJournal();
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(entry?.description).toBe("Committed: hello");
      expect(entry?.repoPath).toBe(repo);
      expect(entry?.undoable).toBe(true);
      expect(entry?.command).toContain("commit");
      // The commit moved HEAD, so the entry has to show both ref states and
      // they must differ.
      expect(entry?.refs.before.head).not.toBe(entry?.refs.after.head);
      expect(entry?.refs.after.head).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  }, 60000);

  it("does not journal an action that failed", async () => {
    const repo = await makeRepo();
    try {
      // `git add` on a path that does not exist fails every time, without
      // depending on what the index happens to hold.
      const res = await journaled(repo, "Staged a file that is not there", () =>
        runGit(["-C", repo, "add", "--", "no/such/file.txt"], { cwd: repo }),
      );
      expect(res.exitCode).not.toBe(0);
      expect(await readJournal()).toHaveLength(0);
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  }, 60000);

  it("records an index-only change with identical HEAD refs", async () => {
    const repo = await makeRepo();
    try {
      writeFileSync(join(repo, "b.txt"), "two\n");
      await journaled(repo, "Staged 1 file: b.txt", () =>
        runGit(["-C", repo, "add", "b.txt"], { cwd: repo }),
      );
      const [entry] = await readJournal();
      // Staging moves the index, not HEAD. The honest journal says so rather
      // than inventing a ref change.
      expect(entry?.refs.before.head).toBe(entry?.refs.after.head);
      expect(entry?.refs.before.branch).toBe("main");
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  }, 60000);

  it("marks a remote-reaching action as not locally undoable, with a reason", async () => {
    const repo = await makeRepo();
    try {
      await journaled(
        repo,
        "Pushed to origin",
        () => runGit(["-C", repo, "commit", "--allow-empty", "-m", "x"], { cwd: repo }),
        {
          undoable: false,
          notUndoableReason:
            "This commit is already on the remote, so it cannot be undone from here.",
        },
      );
      const [entry] = await readJournal();
      expect(entry?.undoable).toBe(false);
      expect(entry?.notUndoableReason).toContain("remote");
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  }, 60000);
});

describe("journal placement", () => {
  it("never writes the journal inside a repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fl-journal-place-"));
    process.env.FORGELINE_DATA_DIR = dir;
    setAppDataDirForTest(null);
    try {
      const repo = await makeRepo();
      await journaled(repo, "Committed: z", () =>
        runGit(["-C", repo, "commit", "--allow-empty", "-m", "z"], { cwd: repo }),
      );
      // The repo itself must still be clean apart from the commit it was given.
      const status = await runGit(["-C", repo, "status", "--porcelain"], { cwd: repo });
      expect(status.stdout.trim()).toBe("");
      // And the journal lives in the app-data folder, not under the repo.
      expect(dir.startsWith(repo)).toBe(false);
    } finally {
      setAppDataDirForTest(null);
      delete process.env.FORGELINE_DATA_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
