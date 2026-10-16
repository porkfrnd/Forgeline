import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSshKey, listSshKeys, missingPublicKeys, sshDir } from "./ssh.js";
import { PROVIDER_KEY_PAGES } from "./ssh.js";

/**
 * `ssh-keygen` is the real tool, so the tests that need a real key use a real
 * `ssh-keygen` when the machine has one and skip the one case that cannot be
 * answered without it. The listing logic is tested against a hand-built ~/.ssh
 * instead, because a fake directory containing a real public key is a better
 * test than one that needs OpenSSH installed to run.
 *
 * The private half is never returned by any code path here, and there is a test
 * for exactly that.
 */

const homeKey = "USERPROFILE";
const realHome = process.env[homeKey] ?? process.env.HOME;

afterEach(() => {
  vi.restoreAllMocks();
  if (realHome !== undefined) {
    process.env[homeKey] = realHome;
    process.env.HOME = realHome;
  }
});

/** Point the module at a fake home with a real ~/.ssh inside it. */
function withFakeHome(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "fl-ssh-"));
  const sshPath = join(root, ".ssh");
  mkdirSync(sshPath, { recursive: true });
  return run(root).then(
    () => rmSync(root, { recursive: true, force: true }),
    (error) => {
      rmSync(root, { recursive: true, force: true });
      throw error;
    },
  );
}

describe("listing keys", () => {
  it("returns no keys and no error on a machine with no ~/.ssh", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-ssh-none-"));
    try {
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      const list = await listSshKeys();
      // A fresh machine is the normal case, and the answer is a sentence rather
      // than an exception.
      expect(list.keys).toEqual([]);
      expect(list.dir).toBe(join(root, ".ssh"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists a key with its public half read in", async () => {
    await withFakeHome(async (root) => {
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      const sshPath = join(root, ".ssh");
      writeFileSync(join(sshPath, "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n-----END OPENSSH PRIVATE KEY-----\n");
      writeFileSync(join(sshPath, "id_ed25519.pub"), "ssh-ed25519 AAAAtestkey user@host\n");

      const list = await listSshKeys();
      expect(list.keys).toHaveLength(1);
      expect(list.keys[0].name).toBe("id_ed25519");
      expect(list.keys[0].publicKey).toContain("ssh-ed25519");
      await expect(Promise.resolve(missingPublicKeys())).resolves.toBeDefined();
      expect(await missingPublicKeys()).toEqual([]);
    });
  });

  it("finds a private key with no public half, which is where push fails with publickey", async () => {
    await withFakeHome(async (root) => {
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      writeFileSync(join(root, ".ssh", "id_rsa"), "-----BEGIN PRIVATE KEY-----\nx\n");
      const list = await listSshKeys();
      expect(list.keys).toHaveLength(1);
      expect(list.keys[0].publicKey).toBeNull();
      expect(list.keys[0].publicPath).toBeNull();
      expect(await missingPublicKeys()).toHaveLength(1);
    });
  });

  it("ignores files that are not keys", async () => {
    await withFakeHome(async (root) => {
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      writeFileSync(join(root, ".ssh", "config"), "Host *\n");
      writeFileSync(join(root, ".ssh", "known_hosts"), "x\n");
      const list = await listSshKeys();
      // known_hosts and config are not keys, and listing them would send a user
      // looking for a public key that does not exist.
      expect(list.keys).toEqual([]);
    });
  });

  it("does not read a private key into the answer", async () => {
    await withFakeHome(async (root) => {
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      const privateText = "-----BEGIN OPENSSH PRIVATE KEY-----\nSUPER SECRET\n-----END OPENSSH PRIVATE KEY-----\n";
      writeFileSync(join(root, ".ssh", "id_ed25519"), privateText);
      writeFileSync(join(root, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAA user@host\n");

      const list = await listSshKeys();
      const asText = JSON.stringify(list);
      // The public half is in the answer; the private one is not, and is not
      // even a path a caller could download.
      expect(asText).toContain("ssh-ed25519");
      expect(asText).not.toContain("PRIVATE KEY");
      expect(asText).not.toContain("SUPER SECRET");
    });
  });

  it("resolves the ssh directory from the user's home directory", () => {
    // One function, answered from homedir(), so a test on a machine with a
    // different HOME can check where the key would land.
    expect(sshDir().endsWith(".ssh")).toBe(true);
  });
});

describe("generating a key", () => {
  it("makes a real ed25519 key when ssh-keygen is available", async () => {
    await withFakeHome(async (root) => {
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      const result = await generateSshKey("ada@fixture.invalid");
      if (result.keyPath === undefined) {
        // No ssh-keygen on this machine. The test suite must not fail for it,
        // but the failure has to be a sentence rather than a crash.
        expect(result.ok).toBe(false);
        expect(result.stdout.length).toBeGreaterThan(0);
        return;
      }
      expect(result.ok).toBe(true);
      // The key exists on disk, with the standard name.
      expect(existsSync(join(root, ".ssh", "id_ed25519"))).toBe(true);
      expect(existsSync(join(root, ".ssh", "id_ed25519.pub"))).toBe(true);
      // And it is an ed25519 key, which is the modern default, rather than an
      // RSA key from a tutorial.
      const publicText = readFileSync(join(root, ".ssh", "id_ed25519.pub"), "utf8");
      expect(publicText).toContain("ssh-ed25519");
      expect(publicText).toContain("ada@fixture.invalid");

      // Never returned: the private half.
      expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
      expect(result.publicKey).toContain("ssh-ed25519");
    });
  });

  it("refuses to make a second ed25519 key over a working one", async () => {
    await withFakeHome(async (root) => {
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      writeFileSync(join(root, ".ssh", "id_ed25519"), "existing private key\n");
      writeFileSync(join(root, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAA user@host\n");
      const result = await generateSshKey("ada@fixture.invalid");
      expect(result.ok).toBe(false);
      expect(result.stdout).toContain("already a key called id_ed25519");
      // And the existing key is untouched — overwriting the private half of a
      // working key cuts the user off from every account it opens.
      expect(readFileSync(join(root, ".ssh", "id_ed25519"), "utf8")).toBe("existing private key\n");
    });
  });

  it("creates the .ssh directory when it does not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "fl-ssh-fresh-"));
    try {
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      const result = await generateSshKey();
      if (result.keyPath === undefined) {
        // Without ssh-keygen there is no key to make, and the message is the
        // thing being tested.
        expect(result.stdout.length).toBeGreaterThan(0);
        return;
      }
      expect(result.ok).toBe(true);
      expect(existsSync(join(root, ".ssh"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the provider key pages", () => {
  it("names a page for each provider a remote can name", () => {
    // A key is useless until it is pasted somewhere, and a user with three
    // remotes should not have to work out where.
    expect(PROVIDER_KEY_PAGES.map((provider) => provider.name)).toEqual(["GitHub", "GitLab", "Bitbucket"]);
    for (const provider of PROVIDER_KEY_PAGES) {
      expect(provider.url.startsWith("https://")).toBe(true);
    }
  });
});
