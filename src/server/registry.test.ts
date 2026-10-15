import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoRegistry } from "./registry.js";
import { resolveRealpath } from "./paths.js";

describe("RepoRegistry", () => {
  let dir = "";
  let registry: RepoRegistry;

  beforeEach(async () => {
    // Resolve first: on some systems the temp dir itself is a symlink.
    dir = await resolveRealpath(mkdtempSync(join(tmpdir(), "fl-reg-")));
    registry = new RepoRegistry();
    registry.setRoots([dir]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands out an opaque id for a repo inside its roots", async () => {
    const repo = join(dir, "demo");
    mkdirSync(repo, { recursive: true });
    const entry = await registry.register(repo);
    expect(entry).not.toBeNull();
    const id = entry?.id ?? "";
    expect(id.length).toBeGreaterThan(0);
    expect(id).not.toContain("demo");
    expect(registry.get(id)?.path).toBe(entry?.path);
  });

  it("returns the same entry when the same repo is registered twice", async () => {
    const repo = join(dir, "demo");
    mkdirSync(repo, { recursive: true });
    const first = await registry.register(repo);
    const second = await registry.register(repo);
    expect(first?.id).toBe(second?.id);
    expect(registry.list()).toHaveLength(1);
  });

  it("refuses a path outside its roots", async () => {
    const outside = mkdtempSync(join(tmpdir(), "fl-outside-"));
    try {
      expect(await registry.register(outside)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // Symlinked roots need elevated rights on Windows CI runners.
  it.runIf(process.platform !== "win32")(
    "accepts a repo reached through a symlinked root",
    async () => {
      const real = mkdtempSync(join(tmpdir(), "fl-realroot-"));
      const link = join(tmpdir(), `fl-linkroot-${process.pid}`);
      try {
        symlinkSync(real, link);
        const repo = join(real, "demo");
        mkdirSync(repo, { recursive: true });
        const linked = new RepoRegistry();
        linked.setRoots([link]);
        const entry = await linked.register(join(link, "demo"));
        expect(entry).not.toBeNull();
        expect(entry?.path).toBe(await resolveRealpath(repo));
      } finally {
        rmSync(link, { force: true });
        rmSync(real, { recursive: true, force: true });
      }
    },
  );

  it("answers undefined for a forged id", () => {
    expect(registry.get("does-not-exist")).toBeUndefined();
  });

  it("rejects escaping paths even for a known repo", async () => {
    const repo = join(dir, "demo");
    mkdirSync(repo, { recursive: true });
    const entry = await registry.register(repo);
    const id = entry?.id ?? "";
    expect(registry.child(id, "../escape").ok).toBe(false);
    expect(registry.child(id, "-weird").ok).toBe(false);
    expect(registry.child(id, join("src", "app.ts")).ok).toBe(true);
    expect(registry.child("no-such-id", "x").ok).toBe(false);
  });
});
