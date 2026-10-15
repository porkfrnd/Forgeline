import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDataDir,
  appDataFile,
  readJson,
  setAppDataDirForTest,
  writeJson,
} from "./appdata.js";

describe("app-data folder", () => {
  let dir: string;
  const original = process.env.FORGELINE_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fl-data-"));
    // FORGELINE_DATA_DIR is read inside appDataDir(), which caches, so the
    // cache has to be cleared between cases as well as the env restored.
    process.env.FORGELINE_DATA_DIR = dir;
    setAppDataDirForTest(null);
  });

  afterEach(() => {
    setAppDataDirForTest(null);
    if (original === undefined) delete process.env.FORGELINE_DATA_DIR;
    else process.env.FORGELINE_DATA_DIR = original;
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the FORGELINE_DATA_DIR override when it is set", () => {
    expect(appDataDir()).toBe(dir);
  });

  it("falls back to the platform convention when the override is empty", () => {
    process.env.FORGELINE_DATA_DIR = "";
    setAppDataDirForTest(null);
    expect(appDataDir()).not.toBe("");
    expect(appDataDir().endsWith("forgeline")).toBe(true);
  });

  it("creates the folder on demand and names files inside it", async () => {
    await writeJson("settings.json", { roots: ["/tmp/x"] });
    expect(existsSync(appDataFile("settings.json"))).toBe(true);
  });
});

describe("reading and writing JSON", () => {
  let dir: string;
  const original = process.env.FORGELINE_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fl-json-"));
    process.env.FORGELINE_DATA_DIR = dir;
    setAppDataDirForTest(null);
  });

  afterEach(() => {
    setAppDataDirForTest(null);
    if (original === undefined) delete process.env.FORGELINE_DATA_DIR;
    else process.env.FORGELINE_DATA_DIR = original;
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a value", async () => {
    await writeJson("settings.json", { roots: ["/a", "/b"], n: 3 });
    expect(await readJson<{ roots: string[]; n: number }>("settings.json")).toEqual({
      roots: ["/a", "/b"],
      n: 3,
    });
  });

  it("reads a missing file as undefined rather than throwing", async () => {
    expect(await readJson("nope.json")).toBeUndefined();
  });

  it("reads a corrupt file as undefined rather than throwing", async () => {
    writeFileSync(appDataFile("broken.json"), "{ not json", "utf8");
    expect(await readJson("broken.json")).toBeUndefined();
  });

  it("leaves no temp file behind after a successful write", async () => {
    await writeJson("settings.json", { a: 1 });
    expect(existsSync(appDataFile("settings.json.tmp"))).toBe(false);
  });

  it("does not throw when the target cannot be written", async () => {
    // The slow way to prove best-effort storage is a read-only folder; the
    // reliable way is a path that fails immediately. Here the file name is
    // already a directory, so the write fails with EISDIR rather than
    // hanging, and the point is that writeJson swallows it.
    mkdirSync(appDataFile("x.json"), { recursive: true });
    await expect(writeJson("x.json", { a: 1 })).resolves.toBeUndefined();
  });

  it("overwrites a previous value, leaving only the last one", async () => {
    await writeJson("settings.json", { roots: ["/a"] });
    await writeJson("settings.json", { roots: ["/b"] });
    const raw = readFileSync(appDataFile("settings.json"), "utf8");
    expect(raw).toContain("/b");
    expect(raw).not.toContain("/a");
  });
});
