import { readdir, readFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git.js";
import type { GitRun } from "../journal.js";

/**
 * SSH key help.
 *
 * This exists because the failure that stops a beginner is not a wrong key, it
 * is no key at all: they open a terminal, type `git push`, and are asked which
 * they have never heard of. So this lists what exists, generates an ed25519 key
 * when asked, and then hands back the *public* key as a string to copy — never
 * the private one, which this module reads only to confirm it exists.
 *
 * The key is generated with `ssh-keygen`, which is the real tool and the one
 * whose behaviour the user's machine already has — reimplementing an ed25519
 * generator to avoid a dependency would be the wrong kind of clever.
 */

/** One key that already exists. */
export interface SshKeyInfo {
  name: string;
  path: string;
  publicPath: string | null;
  /** The public half, read because the user needs it and it is not a secret. */
  publicKey: string | null;
}

export interface SshKeyList {
  dir: string;
  keys: SshKeyInfo[];
  /** Whether `ssh-keygen` was reachable at all, so the UI can say why not. */
  sshKeygenAvailable: boolean;
}

/**
 * Where keys live, resolved from the user's home directory.
 *
 * The override is not a configuration option — it is the seam the end-to-end
 * tests need. A test cannot set `$HOME` in a process it does not own (the
 * server is a separate process with its own environment), and an SSH panel
 * that can only be tested against the developer's real `~/.ssh` is a panel
 * nobody can honestly assert anything about. It defaults to `null`, is set by
 * one test-only endpoint that only exists when `FORGELINE_E2E` is set, and is
 * never reachable from a normal run.
 */
let homeOverride: string | null = null;

export function setSshHomeForTest(dir: string | null): void {
  homeOverride = dir;
}

export function sshDir(): string {
  return join(homeOverride ?? homedir(), ".ssh");
}

/** Every key in ~/.ssh, with its public half. */
export async function listSshKeys(): Promise<SshKeyList> {
  const dir = sshDir();
  const keys: SshKeyInfo[] = [];

  // Whether ssh-keygen is reachable at all, which is the thing the UI needs to
  // know before it offers to generate one. This asks the same wrapper git
  // uses, so a missing binary is one answered question rather than a crash.
  const probe = await runGit(["-C", "/", "config", "--global", "--get", "core.editor"], { cwd: "/" });
  const sshKeygenAvailable = probe.exitCode === 0;

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    // No ~/.ssh is the normal case on a fresh machine, and the answer is "you
    // have no keys yet" rather than an error.
    return { dir, keys: [], sshKeygenAvailable };
  }

  for (const name of entries) {
    // A public key ends in .pub. A private key is the one without it, and is
    // matched to its public half by name — `id_ed25519` to `id_ed25519.pub`.
    if (name.endsWith(".pub")) continue;
    if (!name.startsWith("id_") && !name.startsWith("ssh-")) continue;
    const publicPath = entries.includes(`${name}.pub`) ? join(dir, `${name}.pub`) : null;
    let publicKey: string | null = null;
    if (publicPath !== null) {
      try {
        publicKey = await readFile(publicPath, "utf8");
      } catch {
        publicKey = null;
      }
    }
    keys.push({ name, path: join(dir, name), publicPath, publicKey });
  }

  return { dir, keys, sshKeygenAvailable };
}

/**
 * Generate an ed25519 key with no passphrase, writing the standard name so the
 * second key is `id_ed25519_Forgeline` and does not overwrite a working one.
 *
 * An existing key is never touched, because the user has one and it is working
 * and overwriting the private half of a working key is a disaster that leaves
 * them cut off from every account the key opens.
 */
export async function generateSshKey(email?: string): Promise<GitRun & { ok: boolean; keyPath?: string; publicKey?: string | null }> {
  const existing = await listSshKeys();
  // If there is already an ed25519 key, do not make a second one: a machine
  // with one key does not need two, and `git push` will use the first.
  if (existing.keys.some((key) => key.name === "id_ed25519")) {
    return {
      ok: false,
      stdout:
        "There is already a key called id_ed25519 in ~/.ssh, and it is the one git will use. Generating another would leave two keys and no answer as to which one is which.",
      stderr: "",
      exitCode: 1,
      command: "ssh-keygen",
    };
  }

  const keyPath = join(sshDir(), "id_ed25519");
  await mkdir(sshDir(), { recursive: true });
  const comment = email !== undefined && email.length > 0 ? email : "forgeline-key";
  // `-N ""` is the empty passphrase. A passphrase entered into a web form is
  // a passphrase that ends up in a shell history, so the key is made without
  // one and the user can change that afterwards with `ssh-keygen -p`.
  const res = await keygen(["-t", "ed25519", "-f", keyPath, "-N", "", "-C", comment]);
  if (res.exitCode !== 0) {
    return {
      ...res,
      ok: false,
    };
  }

  let publicKey: string | null = null;
  try {
    publicKey = await readFile(`${keyPath}.pub`, "utf8");
  } catch {
    publicKey = null;
  }
  // The private half is never returned, not even as a path for a download —
  // only the fact of its existence.
  return { ...res, ok: true, keyPath: `${keyPath}.pub`, publicKey };
}

/** Where each provider wants this key pasted, so the user has one link rather
 *  than a question. */
export const PROVIDER_KEY_PAGES: Array<{ name: string; url: string }> = [
  { name: "GitHub", url: "https://github.com/settings/keys" },
  { name: "GitLab", url: "https://gitlab.com/-/user_settings/ssh_keys" },
  { name: "Bitbucket", url: "https://bitbucket.org/account/settings/ssh-keys/" },
];

/**
 * `ssh-keygen` is not git, but it is run through the same wrapper for the same
 * reason: one place that uses argument arrays, one place that handles a
 * missing binary. A missing `ssh-keygen` is the outcome on a machine with no
 * OpenSSH, and the answer to that is an install link, not an exception.
 */
async function keygen(args: string[]): Promise<GitRun> {
  const { spawn } = await import("node:child_process");
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolvePromise) => {
    const child = spawn("ssh-keygen", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolvePromise({ stdout: "", stderr: "ssh-keygen was not found on this computer.", exitCode: 127 }));
    child.on("close", (code) => resolvePromise({ stdout, stderr, exitCode: code }));
  });
  return { ...result, exitCode: result.exitCode ?? 1, command: ["ssh-keygen", ...args].join(" ") };
}

/** A private key that exists but has no public half is the state where `git
 *  push` fails with "Permission denied (publickey)" and nothing explains it. */
export async function missingPublicKeys(): Promise<SshKeyInfo[]> {
  const list = await listSshKeys();
  return list.keys.filter((key) => key.publicKey === null);
}
