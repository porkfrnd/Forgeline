import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNote, writeNote } from "./notes.js";
import { appDataDir, appDataFile } from "./appdata.js";

/**
 * Notes are the feature with the one rule that is easy to violate by accident:
 * they never go inside a repository. A note written into the user's working
 * tree shows up in their next `git status`, gets committed, and is exactly the
 * kind of surprise the app promises not to produce. So the test asserts it
 * against a real repository rather than trusting the module.
 */

const originalDataDir = process.env.FORGELINE_DATA_DIR;

beforeEach(() => {
  // Every test gets its own app-data folder, so the notes are the ones this
  // test wrote and not leftovers from the one before it.
  process.env.FORGELINE_DATA_DIR = mkdtempSync(join(tmpdir(), "fl-notes-"));
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.FORGELINE_DATA_DIR;
  else process.env.FORGELINE_DATA_DIR = originalDataDir;
});

describe("reading and writing a note", () => {
  it("returns an empty string when there is no note", async () => {
    // An empty string rather than null, so the textarea is always a string and
    // the browser never renders the word "null" into a user's note.
    expect(await readNote("/tmp/never-written")).toBe("");
  });

  it("writes a note and reads the same one back", async () => {
    await writeNote("/tmp/repo-a", "remember to check the docs");
    expect(await readNote("/tmp/repo-a")).toBe("remember to check the docs");
  });

  it("keeps notes for different repositories apart", async () => {
    await writeNote("/tmp/repo-a", "note for a");
    await writeNote("/tmp/repo-b", "note for b");
    expect(await readNote("/tmp/repo-a")).toBe("note for a");
    expect(await readNote("/tmp/repo-b")).toBe("note for b");
  });

  it("overwrites the note for a repository rather than adding a second one", async () => {
    await writeNote("/tmp/repo-a", "first thought");
    await writeNote("/tmp/repo-a", "the thought I actually want");
    expect(await readNote("/tmp/repo-a")).toBe("the thought I actually want");
  });

  it("treats an empty note as no note, and reading it back gives an empty string", async () => {
    await writeNote("/tmp/repo-a", "something");
    await writeNote("/tmp/repo-a", "   ");
    expect(await readNote("/tmp/repo-a")).toBe("");
  });

  it("starts from nothing after the store is removed, rather than erroring", async () => {
    await writeNote("/tmp/repo-a", "gone soon");
    rmSync(appDataFile("notes.json"), { force: true });
    expect(await readNote("/tmp/repo-a")).toBe("");
  });
});

describe("the storage rule", () => {
  it("stores notes in app-data, and writes nothing into a repository", async () => {
    // The whole point of this feature, asserted rather than intended.
    const home = mkdtempSync(join(tmpdir(), "fl-notes-home-"));
    const repo = join(home, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "file.txt"), "untouched\n");
    const before = readFileSync(join(repo, "file.txt"), "utf8");

    await writeNote(repo, "my note");

    // Nothing new appeared in the repository, and its one file is unchanged.
    const entries = readdirSync(repo).sort();
    expect(entries).toEqual(["file.txt"]);
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe(before);

    // And the note really did persist, into app-data.
    expect(await readNote(repo)).toBe("my note");
    expect(appDataDir()).not.toContain(repo);

    rmSync(home, { recursive: true, force: true });
  });
});
