import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The operating system's standard app-data folder for Forgeline.
 *
 *  Settings, the journal, notes and the scan cache live here and nowhere else.
 *  Two rules follow from that, and both are load-bearing:
 *
 *  1. It is never inside a repository. The spec says so, and a journal
 *     written into a repo would show up in the user's `status` the next
 *     morning as a mystery modified file.
 *  2. Failure to read or write it never breaks the app. A read-only home
 *     directory, a full disk, or a sandbox with no home at all must not stop
 *     Forgeline starting; the feature that wanted the data degrades instead.
 *
 *  Resolution order:
 *  1. `$FORGELINE_DATA_DIR`, if set. An escape hatch for a portable install,
 *     a read-only home, and the test suite, which must never touch a real
 *     home directory.
 *  2. Otherwise the platform convention:
 *  - Linux:   $XDG_DATA_HOME, else ~/.local/share      + /forgeline
 *  - macOS:   ~/Library/Application Support            + /forgeline
 *  - Windows: %APPDATA%, else ~/AppData/Roaming        + /forgeline
 */
let cachedDir: string | null = null;

export function appDataDir(): string {
  if (cachedDir !== null) return cachedDir;
  const override = process.env.FORGELINE_DATA_DIR;
  if (override !== undefined && override.length > 0) {
    cachedDir = override;
    return cachedDir;
  }
  const home = homedir();
  const platform = process.platform;
  let base: string;
  if (platform === "win32") {
    base = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  } else if (platform === "darwin") {
    base = join(home, "Library", "Application Support");
  } else {
    base = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  }
  cachedDir = join(base, "forgeline");
  return cachedDir;
}

/** Override for tests, so a test never writes to a real home directory. */
export function setAppDataDirForTest(dir: string | null): void {
  cachedDir = dir;
}

/** A specific file inside the app-data folder. */
export function appDataFile(name: string): string {
  return join(appDataDir(), name);
}

/** Create the app-data folder if it does not exist. Throws only if the
 *  platform refuses outright; callers that must not fail use `writeJson`
 *  instead, which swallows the failure. */
export async function ensureAppDataDir(): Promise<void> {
  await mkdir(appDataDir(), { recursive: true });
}

/** Read and parse a JSON file from app-data. A missing or unreadable file
 *  yields `undefined` rather than throwing, so a first run and a corrupted
 *  file look the same to the caller. */
export async function readJson<T>(name: string): Promise<T | undefined> {
  try {
    const raw = await readFile(appDataFile(name), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Write JSON to app-data atomically: a sibling temp file, then rename. A
 *  process killed mid-write leaves either the old file or the new one whole,
 *  never a half-written journal. */
export async function writeJson(name: string, value: unknown): Promise<void> {
  try {
    await ensureAppDataDir();
    const target = appDataFile(name);
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, target);
  } catch {
    // Storage is best-effort. The journal and the settings cache must never
    // take the app down, so a failure here is swallowed deliberately and the
    // feature degrades to memory-only.
  }
}
