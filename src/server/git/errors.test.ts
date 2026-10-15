import { describe, expect, it, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git.js";
import { translateError } from "./errors.js";

/**
 * Every case here runs REAL git in a REAL repository and feeds what git
 * actually printed into the translator. That is deliberate: several wordings
 * differ from what memory produces, so a rule tested only against an
 * invented string would pass here and fail on a user's machine.
 *
 * A merge conflict, "nothing to commit", and a detached HEAD all arrive on
 * STDOUT while "fatal: not a git repository" arrives on STDERR, so the helper
 * below combines both — which is exactly what the translator's callers do.
 */

/** Run git without throwing when it fails. Returns [exitCode, combinedOutput]. */
async function attempt(dir: string, args: string[], cwd = dir): Promise<[number, string]> {
  const res = await runGit(["-C", cwd, ...args], { cwd });
  return [res.exitCode, `${res.stdout}\n${res.stderr}`];
}

/** A repo with one commit and no unconfigured anything. */
async function makeRepo(name: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "fl-err-"));
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  await runGit(["-C", repo, "init", "-b", "main"], { cwd: repo });
  await runGit(["-C", repo, "config", "user.email", "ada@fixture.invalid"], { cwd: repo });
  await runGit(["-C", repo, "config", "user.name", "Ada Fixture"], { cwd: repo });
  writeFileSync(join(repo, "f.txt"), "v1\n");
  await runGit(["-C", repo, "add", "-A"], { cwd: repo });
  await runGit(["-C", repo, "commit", "-m", "Base"], { cwd: repo });
  return repo;
}

/** The command the translator is told ran, for its `command` argument. */
const cmd = (...args: string[]) => args.join(" ");

const cleanup: string[] = [];
async function repo(name: string): Promise<string> {
  const r = await makeRepo(name);
  cleanup.push(dirname(r));
  return r;
}
const dirname = (p: string) => p.split("/").slice(0, -1).join("/");
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

describe("translateError against real git output", () => {
  it("reads 'not a git repository' from a folder git has never initialised", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-err-"));
    cleanup.push(root);
    const notRepo = join(root, "plain-folder");
    mkdirSync(notRepo, { recursive: true });

    const [, output] = await attempt(notRepo, ["status"]);
    const card = translateError(output, cmd("status"));

    expect(card.code).toBe("not-a-repo");
    expect(card.title).toBe("This folder isn't a git project yet.");
    expect(card.fixes.map((f) => f.id)).toEqual(["init-here"]);
    // The raw output is preserved verbatim behind the card, always.
    expect(card.raw).toContain("not a git repository");
  });

  it("reads a merge conflict, which git prints to STDOUT not stderr", async () => {
    const r = await repo("conflict");
    await runGit(["-C", r, "checkout", "-b", "other"], { cwd: r });
    writeFileSync(join(r, "f.txt"), "theirs\n");
    await runGit(["-C", r, "commit", "-am", "theirs"], { cwd: r });
    await runGit(["-C", r, "checkout", "main"], { cwd: r });
    writeFileSync(join(r, "f.txt"), "ours\n");
    await runGit(["-C", r, "commit", "-am", "ours"], { cwd: r });

    const [exitCode, output] = await attempt(r, ["merge", "other"]);
    expect(exitCode).not.toBe(0);

    const card = translateError(output, cmd("merge", "other"));

    expect(card.code).toBe("merge-conflict");
    // The file is named, because a card that doesn't say which file is not a
    // fix, it is a hint.
    expect(card.title).toContain("f.txt");
    expect(card.fixes.map((f) => f.id)).toEqual(["open-conflict-resolver", "abort-merge"]);
    expect(card.raw).toContain("CONFLICT (content): Merge conflict in f.txt");
  });

  it("reads 'Merging is not possible because you have unmerged files'", async () => {
    const r = await repo("inprogress");
    await runGit(["-C", r, "checkout", "-b", "other"], { cwd: r });
    writeFileSync(join(r, "f.txt"), "theirs\n");
    await runGit(["-C", r, "commit", "-am", "theirs"], { cwd: r });
    await runGit(["-C", r, "checkout", "main"], { cwd: r });
    writeFileSync(join(r, "f.txt"), "ours\n");
    await runGit(["-C", r, "commit", "-am", "ours"], { cwd: r });
    await attempt(r, ["merge", "other"]);

    const [, output] = await attempt(r, ["merge", "other"]);
    const card = translateError(output, cmd("merge", "other"));

    expect(card.code).toBe("merge-in-progress");
    expect(card.fixes.map((f) => f.id)).toEqual(["open-conflict-resolver", "abort-merge"]);
  });

  it("reads 'refusing to merge unrelated histories'", async () => {
    const shared = mkdtempSync(join(tmpdir(), "fl-err-"));
    cleanup.push(shared);
    const a = join(shared, "a");
    const b = join(shared, "b");
    for (const d of [a, b]) {
      mkdirSync(d, { recursive: true });
      await runGit(["-C", d, "init", "-b", "main"], { cwd: d });
      await runGit(["-C", d, "config", "user.email", "ada@fixture.invalid"], { cwd: d });
      await runGit(["-C", d, "config", "user.name", "Ada Fixture"], { cwd: d });
    }
    writeFileSync(join(a, "only-a.txt"), "a\n");
    writeFileSync(join(b, "only-b.txt"), "b\n");
    for (const d of [a, b]) {
      await runGit(["-C", d, "add", "-A"], { cwd: d });
      await runGit(["-C", d, "commit", "-m", "base"], { cwd: d });
    }

    // Pulled from `a`, not from `shared`: the third argument is the cwd, and
    // pointing it at a non-repo turned the error into "not a git repository".
    const [, output] = await attempt(a, ["pull", "--no-rebase", b]);
    const card = translateError(output, cmd("pull"));

    expect(card.code).toBe("unrelated-histories");
    expect(card.fixes.map((f) => f.id)).toEqual(["allow-unrelated-histories"]);
  });

  it("reads a push rejected because the remote has work you don't have", async () => {
    const shared = mkdtempSync(join(tmpdir(), "fl-err-"));
    cleanup.push(shared);
    const remote = join(shared, "remote.git");
    mkdirSync(remote, { recursive: true });
    await runGit(["-C", remote, "init", "-q", "--bare", "-b", "main"], { cwd: remote });

    const cloneInto = async (name: string) => {
      const d = join(shared, name);
      await runGit(["clone", "-q", remote, d], { cwd: shared });
      return d;
    };

    const a = await cloneInto("a");
    writeFileSync(join(a, "f.txt"), "a's line\n");
    await runGit(["-C", a, "add", "-A"], { cwd: a });
    await runGit(["-C", a, "commit", "-m", "a"], { cwd: a });
    await runGit(["-C", a, "push", "origin", "main"], { cwd: a });

    const b = await cloneInto("b");
    writeFileSync(join(b, "f.txt"), "b's line\n");
    await runGit(["-C", b, "add", "-A"], { cwd: b });
    await runGit(["-C", b, "commit", "-m", "b"], { cwd: b });
    await runGit(["-C", b, "push", "origin", "main"], { cwd: b });

    const [exitCode, output] = await attempt(a, ["push", "origin", "main"]);
    expect(exitCode).not.toBe(0);

    const card = translateError(output, cmd("push", "origin", "main"));

    expect(card.code).toBe("push-rejected");
    expect(card.fixes.map((f) => f.id)).toEqual(["pull-then-push"]);
    expect(card.raw).toContain("(fetch first)");
  });

  it("reads a push rejected when no remote is configured at all", async () => {
    const r = await repo("noremote");
    const [exitCode, output] = await attempt(r, ["push"]);
    expect(exitCode).not.toBe(0);

    const card = translateError(output, cmd("push"));
    expect(card.code).toBe("no-remote");
    expect(card.fixes.map((f) => f.id)).toEqual(["add-remote"]);
  });

  it("reads 'remote origin already exists'", async () => {
    const r = await repo("remoteexists");
    await runGit(["-C", r, "remote", "add", "origin", r], { cwd: r });

    const [, output] = await attempt(r, ["remote", "add", "origin", r]);
    const card = translateError(output, cmd("remote", "add", "origin"));

    expect(card.code).toBe("remote-exists");
    expect(card.fixes.map((f) => f.id)).toEqual(["show-remote", "replace-remote"]);
  });

  it("reads 'Your local changes ... would be overwritten by checkout'", async () => {
    const r = await repo("overwrite");
    await runGit(["-C", r, "checkout", "-b", "other"], { cwd: r });
    writeFileSync(join(r, "f.txt"), "theirs\n");
    await runGit(["-C", r, "commit", "-am", "theirs"], { cwd: r });
    await runGit(["-C", r, "checkout", "main"], { cwd: r });
    writeFileSync(join(r, "f.txt"), "uncommitted\n");

    const [exitCode, output] = await attempt(r, ["checkout", "other"]);
    expect(exitCode).not.toBe(0);

    const card = translateError(output, cmd("checkout", "other"));

    expect(card.code).toBe("local-changes");
    expect(card.fixes.map((f) => f.id)).toEqual(["stash-and-continue", "commit-first"]);
    expect(card.raw).toContain("would be overwritten");
  });

  it("reads a detached HEAD from git status output on stdout", async () => {
    const r = await repo("detached");
    await runGit(["-C", r, "checkout", "--detach", "HEAD"], { cwd: r });

    const [, output] = await attempt(r, ["status"]);
    const card = translateError(output, cmd("status"));

    expect(card.code).toBe("detached-head");
    expect(card.title).toBe("You're not on a branch.");
    expect(card.fixes.map((f) => f.id)).toEqual(["create-branch"]);
    expect(card.raw).toContain("HEAD detached at");
  });

  it("reads 'nothing to commit, working tree clean' with no fix offered", async () => {
    const r = await repo("clean");
    const [exitCode, output] = await attempt(r, ["commit", "-m", "x"]);
    expect(exitCode).not.toBe(0);

    const card = translateError(output, cmd("commit"));

    expect(card.code).toBe("nothing-to-commit");
    // A fix would be a button that does something nothing needs doing for.
    expect(card.fixes).toEqual([]);
    expect(card.title).toBe("There's nothing new to save.");
  });

  it("reads an index.lock left behind in .git", async () => {
    const r = await repo("lock");
    writeFileSync(join(r, "f.txt"), "v2\n");
    writeFileSync(join(r, ".git", "index.lock"), "");

    const [exitCode, output] = await attempt(r, ["add", "-A"]);
    expect(exitCode).not.toBe(0);

    const card = translateError(output, cmd("add"));

    expect(card.code).toBe("index-lock");
    expect(card.fixes.map((f) => f.id)).toEqual(["check-running-git", "remove-lock"]);
    expect(card.raw).toContain("index.lock");
  });

  it("reads 'no upstream configured for branch'", async () => {
    const r = await repo("upstream");
    const [, output] = await attempt(r, ["rev-parse", "@{u}"]);

    const card = translateError(output, cmd("rev-parse", "@{u}"));

    expect(card.code).toBe("no-upstream");
    expect(card.title).toContain("main");
    expect(card.fixes.map((f) => f.id)).toEqual(["push-set-upstream"]);
  });

  it("reads a pathspec that matches no file", async () => {
    const r = await repo("pathspec");
    const [, output] = await attempt(r, ["checkout", "HEAD", "--", "nope.txt"]);

    const card = translateError(output, cmd("checkout", "HEAD", "--", "nope.txt"));

    expect(card.code).toBe("pathspec");
    expect(card.fixes.map((f) => f.id)).toEqual(["retry"]);
    expect(card.raw).toContain("did not match any file(s) known to git");
  });

  it("reads an unknown revision or path", async () => {
    const r = await repo("unknownrev");
    const [, output] = await attempt(r, ["rev-parse", "nosuchref"]);

    const card = translateError(output, cmd("rev-parse", "nosuchref"));

    expect(card.code).toBe("pathspec");
    expect(card.fixes.map((f) => f.id)).toEqual(["retry"]);
  });
});

describe("the generic card never hides an error", () => {
  it("falls through to the raw output when no rule matches", () => {
    const raw = "fatal: some wording git has never printed to this project";
    const card = translateError(raw, cmd("push"));

    expect(card.code).toBe("git-error");
    expect(card.fixes).toEqual([]);
    // This is the whole point: no rule matched, and the output is still shown.
    expect(card.raw).toBe(raw);
    expect(card.explanation).toContain("unchanged");
  });

  it("still translates when the output is empty", () => {
    const card = translateError("", cmd("push"));
    expect(card.code).toBe("git-error");
    expect(card.raw).toBe("");
  });
});

/**
 * These three cannot be produced by offline git: the server side has to say
 * no. Their patterns quote git's documented wording rather than a run made
 * here, and each says so — an honesty gap would be worse than a missing test.
 */
describe("patterns for errors this machine cannot produce", () => {
  it("reads a public-key refusal, which needs a real SSH server", () => {
    const raw = "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.";
    const card = translateError(raw, cmd("push", "origin"));

    expect(card.code).toBe("ssh-key");
    expect(card.fixes.map((f) => f.id)).toEqual(["setup-ssh-key", "switch-remote-https"]);
  });

  it("reads a host key git has never accepted", () => {
    const raw = "Host key verification failed.";
    const card = translateError(raw, cmd("fetch", "origin"));

    expect(card.code).toBe("host-key");
    expect(card.title).toContain("never seen");
  });

  it("reads a protected branch, which only a remote refuses", () => {
    const raw = "remote: error: GH013: Cannot push to protected branch 'main'";
    const card = translateError(raw, cmd("push", "origin", "main"));

    expect(card.code).toBe("protected-branch");
    // The branch is named in the explanation, because it is what the user
    // needs to know to act.
    expect(card.explanation).toContain("main");
  });

  it("reads a file over GitHub's size limit", () => {
    const raw = "remote: error: File build/out.blob is 421.00 MB; this exceeds GitHub's file size limit of 100.00 MB";
    const card = translateError(raw, cmd("push", "origin"));

    expect(card.code).toBe("file-too-large");
    expect(card.fixes.map((f) => f.id)).toEqual(["unstage-file", "add-gitignore"]);
  });
});

describe("the catalogue covers the spec's starter list", () => {
  /** The spec's table, as codes. If a rule is removed this fails and says so,
   *  rather than the catalogue quietly shrinking. */
  it("keeps every starter-code pattern matchable", () => {
    const cases: Array<[string, string]> = [
      ["push-rejected", " ! [rejected] main -> main (fetch first)\nerror: failed to push some refs"],
      ["ssh-key", "Permission denied (publickey)"],
      ["remote-auth", "fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
      ["remote-auth", "remote: 403 Unauthorized\nfatal: The requested URL returned error: 403"],
      ["merge-conflict", "CONFLICT (content): Merge conflict in a.txt"],
      ["not-a-repo", "fatal: not a git repository (or any of the parent directories): .git"],
      ["detached-head", "HEAD detached at 1a2b3c"],
      ["local-changes", "error: Your local changes to the following files would be overwritten by checkout:"],
      ["unrelated-histories", "fatal: refusing to merge unrelated histories"],
      ["protected-branch", "remote: error: Cannot push to protected branch"],
      ["remote-unreachable", "fatal: unable to access: Could not resolve host: github.com"],
      ["remote-exists", "error: remote origin already exists."],
      ["no-identity", "fatal: unable to auto-detect email address (please tell me who you are)"],
      ["index-lock", "fatal: Unable to create 'x/.git/index.lock': File exists."],
      ["file-too-large", "remote: error: File x is 421.00 MB; this exceeds GitHub's file size limit"],
      ["diverged", "fatal: Not possible to fast-forward, aborting."],
      ["nothing-to-commit", "On branch main\nnothing to commit, working tree clean"],
    ];

    for (const [expected, raw] of cases) {
      expect(translateError(raw, "").code, `for ${JSON.stringify(raw)}`).toBe(expected);
    }
  });
});

describe("translateError's host and file extraction", () => {
  it("names the host from an https URL without chopping a port", () => {
    const card = translateError(
      "fatal: unable to access 'http://127.0.0.1:8080/repo.git/': The requested URL returned error: 403",
      "",
    );
    expect(card.code).toBe("remote-auth");
    expect(card.explanation).toContain("127.0.0.1:8080");
  });

  it("names a hostname with its domain", () => {
    const card = translateError(
      "fatal: unable to access 'https://git.example.com/x/': The requested URL returned error: 403",
      "",
    );
    expect(card.explanation).toContain("git.example.com");
  });

  it("does not invent a host when none was printed", () => {
    const card = translateError(
      "fatal: unable to access 'ssh://localhost/': Could not resolve host",
      "",
    );
    expect(card.title).toContain("Can't reach the remote");
    // No stray parentheses or the word "null".
    expect(card.title).not.toContain("null");
  });
  it("does not read a port number as an HTTP status", () => {
    // A local remote on port 40387 really does contain "403" once the URL is
    // printed. The 403 rule used to match "http" followed by "403", which
    // turned a 401 into "permissions problem" — wrong, and it hid the actual
    // question, which was credentials. Digits in a host must never move a
    // card between codes.
    const withForbiddenPort = translateError(
      "fatal: could not read Username for 'http://127.0.0.1:40387/repo.git': terminal prompts disabled",
      "",
    );
    expect(withForbiddenPort.code).toBe("remote-auth");
    expect(withForbiddenPort.title).toBe("The remote needs you to sign in.");

    // The same trap with the other two numbers that appear in rejections.
    const withNotFoundPort = translateError(
      "fatal: unable to access 'http://127.0.0.1:4041/x.git/': Could not resolve host",
      "",
    );
    expect(withNotFoundPort.title).toContain("Can't reach the remote");
  });

  it("reads a real 403 as a permissions problem", () => {
    // The genuine wording, so the rule still earns its keep.
    const card = translateError(
      "remote: 403 Unauthorized\nfatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403",
      "",
    );
    expect(card.code).toBe("remote-auth");
    expect(card.title).toBe("The remote refused you.");
  });
});
