import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git.js";
import {
  fetchRepo,
  hasRemote,
  listRemotes,
  pullRepo,
  pushRepo,
  upstreamPosition,
} from "./remote.js";

/**
 * A local bare repository is a real remote. It has refs, it accepts pushes, it
 * rejects non-fast-forwards, and it needs no network and no credentials — so
 * every path here is exercised for real rather than mocked.
 */

const git = async (cwd: string, args: string[]) => runGit(["-C", cwd, ...args], { cwd });

/** A committed repository at `dir`. */
async function makeRepo(dir: string, file = "f.txt", body = "base\n"): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main", "."]);
  await git(dir, ["config", "user.email", "ada@fixture.invalid"]);
  await git(dir, ["config", "user.name", "Ada Fixture"]);
  writeFileSync(join(dir, file), body);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "Base"]);
}

/** Commit one file into an EXISTING repository. Re-running `git init` inside a
 *  clone was tried first and quietly re-initialised its remote-tracking
 *  state, so the clones stopped being clones of anything — which is why this
 *  helper exists separately from makeRepo. */
async function commitInto(dir: string, file: string, body: string, message: string) {
  writeFileSync(join(dir, file), body);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", message]);
}

/** A working directory with one bare remote already holding a branch, plus two
 *  real clones of it — the shape every push-rejection case needs. */
async function makeShared() {
  const root = mkdtempSync(join(tmpdir(), "fl-remote-"));
  const remote = join(root, "remote.git");
  await makeRepo(remote, "seed.txt", "seed\n");
  await git(remote, ["config", "core.bare", "true"]);

  // Clone AFTER the seed commit exists, so both repositories have an
  // origin/main to track.
  const clone = async (name: string) => {
    const dir = join(root, name);
    const res = await runGit(["clone", "-q", remote, dir], { cwd: root });
    if (res.exitCode !== 0) throw new Error(`clone failed: ${res.stderr}`);
    return dir;
  };
  const a = await clone("a");
  await commitInto(a, "a.txt", "a's line\n", "a's change");
  const pushed = await pushRepo(a);
  expect(pushed.ok).toBe(true);
  if (!pushed.ok) throw new Error("setup push failed");

  // b is cloned AFTER a's push, so it has an origin/main to be level with and
  // can push. Cloning it earlier — which the first version of this helper did
  // — left b permanently behind, and every b-side push failed as a rejection.
  const b = await clone("b");
  return { root, remote, a, b };
}

describe("reading remotes", () => {
  it("reports each remote's fetch and push address", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-remote-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await git(repo, ["remote", "add", "origin", "https://example.invalid/org/repo.git"]);

      const remotes = await listRemotes(repo);
      expect(remotes).toEqual([
        {
          name: "origin",
          fetch: "https://example.invalid/org/repo.git",
          push: "https://example.invalid/org/repo.git",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a distinct push address, which git allows", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-remote-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      await git(repo, ["remote", "add", "origin", "https://example.invalid/org/repo.git"]);
      await git(repo, ["remote", "set-url", "--push", "origin", "git@example.invalid:org/repo.git"]);

      const [origin] = await listRemotes(repo);
      expect(origin.fetch).toBe("https://example.invalid/org/repo.git");
      expect(origin.push).toBe("git@example.invalid:org/repo.git");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says a repository with no remote has none", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-remote-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      expect(await listRemotes(repo)).toEqual([]);
      expect(await hasRemote(repo)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns nothing rather than throwing on a path that is not a repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-remote-"));
    try {
      expect(await listRemotes(join(root, "nowhere"))).toEqual([]);
      expect(await hasRemote(join(root, "nowhere"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("push", () => {
  it("publishes a branch that has never been pushed", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-remote-"));
    try {
      const remote = join(root, "remote.git");
      mkdirSync(remote, { recursive: true });
      await git(remote, ["init", "-q", "--bare", "-b", "main", "."]);
      const repo = join(root, "demo");
      await makeRepo(repo);
      await git(repo, ["remote", "add", "origin", remote]);

      const res = await pushRepo(repo, { setUpstream: true });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.changed).toBe(true);
      // The branch really is on the remote, which only git can confirm.
      const ls = await git(remote, ["rev-parse", "--verify", "refs/heads/main"]);
      expect(ls.stdout.trim().length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a push with nothing new as unchanged rather than as a failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-remote-"));
    try {
      const remote = join(root, "remote.git");
      mkdirSync(remote, { recursive: true });
      await git(remote, ["init", "-q", "--bare", "-b", "main", "."]);
      const repo = join(root, "demo");
      await makeRepo(repo);
      await git(repo, ["remote", "add", "origin", remote]);
      const first = await pushRepo(repo, { setUpstream: true });
      expect(first.ok).toBe(true);

      // Pushing the same commit again must not look like a change.
      const again = await pushRepo(repo);
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.changed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a push when the remote has work the user does not have", async () => {
    const { root, a, b } = await makeShared();
    try {
      // b pushes first, then a — which has neither fetched nor pulled — tries.
      await commitInto(b, "b.txt", "b's own line\n", "b's change");
      const ok = await pushRepo(b);
      expect(ok.ok).toBe(true);

      const res = await pushRepo(a);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      // The output the translator will be handed is git's real refusal, which
      // is what makes the "someone else pushed" card correct.
      expect(res.output).toContain("fetch first");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a push with no remote configured at all", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-remote-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      const res = await pushRepo(repo);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.output).toContain("No configured push destination");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never puts a credential in the command it reports", async () => {
    // The contract the session rules care about: `command` is for showing the
    // user what ran, so it must not become a way to leak an askpass answer.
    const root = mkdtempSync(join(tmpdir(), "fl-remote-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      const res = await pushRepo(repo);
      if (res.ok) return;
      expect(res.command).not.toMatch(/token|password|secret/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fetch and pull", () => {
  it("fetches without touching the working tree", async () => {
    const { root, a, b } = await makeShared();
    try {
      const before = await git(a, ["status", "--porcelain=v2", "-z"]);
      writeFileSync(join(b, "b.txt"), "b's own line\n");
      await git(b, ["add", "-A"]);
      await git(b, ["commit", "-q", "-m", "b's change"]);
      await pushRepo(b);

      const res = await fetchRepo(a);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.changed).toBe(true);

      // The fetch brought the commit into the object store but did not touch
      // the working tree, which is the whole difference from a pull.
      const after = await git(a, ["status", "--porcelain=v2", "-z"]);
      expect(after.stdout).toBe(before.stdout);
      const has = await git(a, ["cat-file", "-e", "origin/main"]);
      expect(has.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("integrates what a pull fetched, so the working tree gets the change", async () => {
    const { root, a, b } = await makeShared();
    try {
      writeFileSync(join(b, "b.txt"), "b's own line\n");
      await git(b, ["add", "-A"]);
      await git(b, ["commit", "-q", "-m", "b's change"]);
      await pushRepo(b);

      // Fast-forward: a has no commits of its own, so the pull applies cleanly.
      const res = await pullRepo(a);
      expect(res.ok).toBe(true);
      // `.stdout` matters: `git()` returns the whole result object, and
      // `toContain` against an object would not read the log at all.
      const log = await git(a, ["log", "--format=%s", "origin/main"]);
      expect(log.stdout).toContain("b's change");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops a pull at a conflict instead of committing through it", async () => {
    const { root, a, b } = await makeShared();
    try {
      // Both sides edit the SAME file, which is the only way to force a
      // conflict against a local remote.
      writeFileSync(join(b, "shared.txt"), "b's version\n");
      await git(b, ["add", "-A"]);
      await git(b, ["commit", "-q", "-m", "b edits shared"]);
      await pushRepo(b);

      writeFileSync(join(a, "shared.txt"), "a's version\n");
      await git(a, ["add", "-A"]);
      await git(a, ["commit", "-q", "-m", "a edits shared"]);

      const res = await pullRepo(a);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      // The translator's merge-conflict rule must find this text.
      expect(res.output).toMatch(/CONFLICT|merging is not possible/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a pull with nothing new as unchanged", async () => {
    const { root, a } = await makeShared();
    try {
      const res = await pullRepo(a);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.changed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("upstream position", () => {
  it("counts ahead and behind independently", async () => {
    const { root, a, b } = await makeShared();
    try {
      const start = await upstreamPosition(a);
      expect(start).toEqual({ ahead: 0, behind: 0 });

      writeFileSync(join(b, "b.txt"), "b's own line\n");
      await git(b, ["add", "-A"]);
      await git(b, ["commit", "-q", "-m", "b's change"]);
      await pushRepo(b);
      await fetchRepo(a);

      expect(await upstreamPosition(a)).toEqual({ ahead: 0, behind: 1 });

      writeFileSync(join(a, "a2.txt"), "a's second line\n");
      await git(a, ["add", "-A"]);
      await git(a, ["commit", "-q", "-m", "a's second"]);
      // Diverged: one ahead and one behind at the same time.
      expect(await upstreamPosition(a)).toEqual({ ahead: 1, behind: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when the branch has no upstream", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-remote-"));
    try {
      const repo = join(root, "demo");
      await makeRepo(repo);
      expect(await upstreamPosition(repo)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null rather than throwing on a path that is not a repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-remote-"));
    try {
      expect(await upstreamPosition(join(root, "nowhere"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
