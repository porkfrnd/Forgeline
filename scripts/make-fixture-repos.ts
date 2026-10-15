import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FixtureSet {
  root: string;
  remotes: string;
  repos: Record<string, string>;
  cleanup: () => void;
}

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", ["-c", "core.autocrlf=input", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
}

function initRepo(path: string, remote?: string): void {
  git(path, ["init", "-b", "main"]);
  git(path, ["config", "user.email", "test@example.com"]);
  git(path, ["config", "user.name", "Test"]);
  writeFileSync(join(path, "README.md"), "# fixture\n");
  git(path, ["add", "README.md"]);
  git(path, ["commit", "-m", "Initial commit"]);
  if (remote) {
    git(path, ["remote", "add", "origin", remote]);
    git(path, ["push", "-u", "origin", "main"]);
  }
}

export function makeFixtureRepos(): FixtureSet {
  const root = mkdtempSync(join(tmpdir(), "forgeline-fixtures-"));
  const remotes = join(root, "remotes");
  const repos: Record<string, string> = {};
  mkdirSync(remotes, { recursive: true });

  const mkBare = (name: string): string => {
    const p = join(remotes, `${name}.git`);
    mkdirSync(p, { recursive: true });
    git(p, ["init", "--bare"]);
    return p;
  };

  const mkWork = (name: string): string => {
    const p = join(root, name);
    mkdirSync(p, { recursive: true });
    return p;
  };

  const cleanRemote = mkBare("clean");
  const clean = mkWork("clean");
  initRepo(clean, cleanRemote);
  repos.clean = clean;

  const dirty = mkWork("dirty");
  initRepo(dirty, mkBare("dirty"));
  writeFileSync(join(dirty, "notes.txt"), "uncommitted work\n");
  repos.dirty = dirty;

  const staged = mkWork("staged-unstaged");
  initRepo(staged, mkBare("staged"));
  writeFileSync(join(staged, "file.txt"), "line1\nline2\n");
  git(staged, ["add", "file.txt"]);
  git(staged, ["commit", "-m", "Add file"]);
  writeFileSync(join(staged, "file.txt"), "line1 changed\nline2\nline3 new\n");
  git(staged, ["add", "file.txt"]);
  writeFileSync(join(staged, "file.txt"), "line1 changed\nline2 edited\nline3 new\n");
  repos.stagedUnstaged = staged;

  const ahead = mkWork("ahead");
  initRepo(ahead, mkBare("ahead"));
  writeFileSync(join(ahead, "extra.txt"), "ahead commit\n");
  git(ahead, ["add", "extra.txt"]);
  git(ahead, ["commit", "-m", "Local commit ahead"]);
  repos.ahead = ahead;

  const behindBase = mkWork("behind-seed");
  const behindRemote = mkBare("behind");
  initRepo(behindBase, behindRemote);
  const behind = mkWork("behind");
  const cr = spawnSync("git", ["clone", "-b", "main", behindRemote, behind], { encoding: "utf8" });
  if (cr.status !== 0) throw new Error(`clone failed: ${cr.stderr}`);
  git(behindBase, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(behindBase, "remote.txt"), "remote change\n");
  git(behindBase, ["add", "remote.txt"]);
  git(behindBase, ["commit", "-m", "Remote change"]);
  git(behindBase, ["push", "origin", "main"]);
  git(behind, ["fetch", "origin"]);
  repos.behind = behind;

  const detached = mkWork("detached");
  initRepo(detached, mkBare("detached"));
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: detached, encoding: "utf8" }).stdout.trim();
  git(detached, ["checkout", "--detach", sha]);
  repos.detached = detached;

  const conflict = mkWork("conflict");
  initRepo(conflict, mkBare("conflict"));
  writeFileSync(join(conflict, "merge.txt"), "base\n");
  git(conflict, ["add", "merge.txt"]);
  git(conflict, ["commit", "-m", "Base"]);
  git(conflict, ["checkout", "-b", "side"]);
  writeFileSync(join(conflict, "merge.txt"), "side change\n");
  git(conflict, ["commit", "-am", "Side change"]);
  git(conflict, ["checkout", "main"]);
  writeFileSync(join(conflict, "merge.txt"), "main change\n");
  git(conflict, ["commit", "-am", "Main change"]);
  spawnSync("git", ["merge", "side"], { cwd: conflict, encoding: "utf8" });
  repos.conflict = conflict;

  const noRemote = mkWork("no-remote");
  git(noRemote, ["init", "-b", "main"]);
  git(noRemote, ["config", "user.email", "test@example.com"]);
  git(noRemote, ["config", "user.name", "Test"]);
  writeFileSync(join(noRemote, "README.md"), "# no remote\n");
  git(noRemote, ["add", "README.md"]);
  git(noRemote, ["commit", "-m", "Initial commit"]);
  repos.noRemote = noRemote;

  const big = mkWork("large-file");
  initRepo(big, mkBare("large"));
  const buf = Buffer.alloc(6 * 1024 * 1024, "a");
  writeFileSync(join(big, "big.bin"), buf);
  repos.largeFile = big;

  return {
    root,
    remotes,
    repos,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
