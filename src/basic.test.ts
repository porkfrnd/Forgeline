import { describe, it, expect } from "vitest";
import { parsePortArg } from "./cli.js";
import { parseGitVersion, meetsMinVersion } from "./server/git/git.js";
import { makeFixtureRepos } from "../scripts/make-fixture-repos.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("parsePortArg", () => {
  it("returns 0 when no port given", () => {
    expect(parsePortArg(undefined)).toEqual({ port: 0 });
  });
  it("accepts a free valid port", () => {
    expect(parsePortArg("4700")).toEqual({ port: 4700 });
  });
  it("rejects non-numbers and out-of-range ports", () => {
    expect(parsePortArg("abc").port).toBeNull();
    expect(parsePortArg("80").port).toBeNull();
    expect(parsePortArg("99999").port).toBeNull();
  });
});

describe("parseGitVersion", () => {
  it("parses real git output", () => {
    expect(parseGitVersion("git version 2.47.3")).toEqual({ major: 2, minor: 47 });
    expect(meetsMinVersion({ major: 2, minor: 47 }, 2, 31)).toBe(true);
    expect(meetsMinVersion({ major: 2, minor: 20 }, 2, 31)).toBe(false);
    expect(meetsMinVersion(null, 2, 31)).toBe(false);
  });
});

describe("makeFixtureRepos", () => {
  it("builds clean and dirty fixtures with real git", () => {
    const fx = makeFixtureRepos();
    try {
      expect(existsSync(join(fx.repos.clean, ".git"))).toBe(true);
      expect(existsSync(join(fx.repos.dirty, "notes.txt"))).toBe(true);
      expect(existsSync(join(fx.repos.noRemote, ".git"))).toBe(true);
    } finally {
      fx.cleanup();
    }
  }, 60000);
});
