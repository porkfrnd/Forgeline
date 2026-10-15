import { spawn } from "node:child_process";

/**
 * Token storage.
 *
 * A token is a password. The spec is unambiguous about where it may live: the
 * OS keychain, or memory for the current run — and *never* a plain file, which
 * would put a live GitHub token in a world-readable place next to the repos it
 * can push to.
 *
 * So the store is one of two things, and it says which:
 *
 *  - **keychain**: `secret-tool`, the standard Secret Service client on Linux
 *    (shipped by libsecret-tools). It is used only if it is actually present
 *    — the probe runs it and checks that it works, since a binary existing is
 *    not the same as a secret service running. On many machines there is no
 *    D-Bus session at all.
 *  - **memory**: the token lives in this process and dies with it.
 *
 * The fallback is never a file. The interface is told which mode is active so
 * it can be honest about it rather than implying a token is safely stored when
 * it is not.
 */

export type TokenStoreMode = "keychain" | "memory";

export interface TokenStore {
  readonly mode: TokenStoreMode;
  /** A sentence the interface can show, or null when there is nothing to warn
   *  about. */
  readonly notice: string | null;
  get(provider: string): Promise<string | null>;
  set(provider: string, token: string): Promise<void>;
  remove(provider: string): Promise<void>;
}

/** Run `secret-tool` and collect its output. Resolves null if it cannot be
 *  run at all, which is how every caller distinguishes "no key" from "no
 *  keychain". */
async function secretTool(
  args: string[],
  stdin?: string,
): Promise<{ status: number; stdout: string; stderr: string } | null> {
  return new Promise((resolve) => {
    const child = spawn("secret-tool", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    // A missing binary emits `error` and never spawns; a hung daemon would
    // otherwise wait forever with no answer either way.
    child.on("error", () => resolve(null));
    child.on("close", (status) => resolve({ status: status ?? -1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

const LABEL = "Forgeline";

/**
 * Create the store for this run. The probe is deliberately real: it writes a
 * value and reads it back, because `secret-tool` can be installed while the
 * Secret Service itself is unreachable, and that case looks identical until it
 * is tried.
 */
export async function createTokenStore(): Promise<TokenStore> {
  const probe = await secretTool(
    ["store", "--label=" + LABEL, "service", "forgeline.probe", "account", "probe"],
    "ok",
  );
  if (probe !== null && probe.status === 0) {
    const back = await secretTool(["lookup", "service", "forgeline.probe"]);
    const alive = back !== null && back.status === 0 && back.stdout.trim() === "ok";
    await secretTool(["clear", "service", "forgeline.probe"]);
    if (alive) {
      return {
        mode: "keychain",
        notice: null,
        get: (provider) => readKey(provider),
        set: (provider, token) => writeKey(provider, token),
        remove: (provider) => clearKey(provider),
      };
    }
  }

  return memoryStore(
    "There is no OS keychain available on this machine, so your sign-in is kept in memory only. It will be forgotten when Forgeline closes, and you will need to sign in again.",
  );
}

async function readKey(provider: string): Promise<string | null> {
  const res = await secretTool(["lookup", "service", `forgeline.${provider}`]);
  // A non-zero exit means "no such item", which is a normal answer, not a
  // failure to report as one.
  if (res === null || res.status !== 0) return null;
  const value = res.stdout.trim();
  return value.length > 0 ? value : null;
}

async function writeKey(provider: string, token: string): Promise<void> {
  await secretTool(
    ["store", `--label=${LABEL} ${provider}`, "service", `forgeline.${provider}`, "account", provider],
    token,
  );
}

async function clearKey(provider: string): Promise<void> {
  await secretTool(["clear", "service", `forgeline.${provider}`]);
}

/** The in-memory store. Deliberately incapable of persisting. */
export function memoryStore(notice: string | null): TokenStore {
  const tokens = new Map<string, string>();
  return {
    mode: "memory",
    notice,
    get: async (provider) => tokens.get(provider) ?? null,
    set: async (provider, token) => {
      tokens.set(provider, token);
    },
    remove: async (provider) => {
      tokens.delete(provider);
    },
  };
}
