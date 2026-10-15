import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAppDataDirForTest } from "./appdata.js";
import {
  MAX_HISTORY_ENTRIES,
  fixScorecard,
  readErrorHistory,
  recordErrorShown,
  recordFixChosen,
  recordFixDismissed,
  recordFixOutcome,
} from "./errorHistory.js";

describe("error history", () => {
  let dir: string;
  const original = process.env.FORGELINE_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fl-errhist-"));
    process.env.FORGELINE_DATA_DIR = dir;
    setAppDataDirForTest(null);
  });

  afterEach(() => {
    setAppDataDirForTest(null);
    if (original === undefined) delete process.env.FORGELINE_DATA_DIR;
    else process.env.FORGELINE_DATA_DIR = original;
    rmSync(dir, { recursive: true, force: true });
  });

  it("records an error that was shown, with its fix offers", async () => {
    const record = await recordErrorShown({
      repoPath: "/srv/app",
      code: "push-rejected",
      command: "push origin main",
      offered: ["pull-then-push", "force-push"],
    });

    expect(record.code).toBe("push-rejected");
    expect(record.offered).toEqual(["pull-then-push", "force-push"]);
    expect(record.chosen).toBeNull();
    expect(record.outcome).toBe("pending");
  });

  it("survives a restart, because that is the point of storing it", async () => {
    await recordErrorShown({
      repoPath: "/srv/app",
      code: "index-lock",
      command: "add -A",
      offered: ["check-running-git", "remove-lock"],
    });
    // Drop the in-process cache, exactly as a restart would.
    setAppDataDirForTest(null);

    const history = await readErrorHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.code).toBe("index-lock");
  });

  it("reads a corrupt history file as empty rather than throwing", async () => {
    // A truncated write or a half-written JSON file is the realistic case.
    writeFileSync(join(dir, "error-history.json"), '{"version":1,"entries":[');
    expect(await readErrorHistory()).toEqual([]);
  });

  it("reads a history with an unknown version as empty", async () => {
    writeFileSync(join(dir, "error-history.json"), JSON.stringify({ version: 99, entries: [] }));
    expect(await readErrorHistory()).toEqual([]);
  });

  it("records which fix was chosen and whether it worked", async () => {
    const record = await recordErrorShown({
      repoPath: "/srv/app",
      code: "remote-auth",
      command: "fetch origin",
      offered: ["open-sign-in", "retry"],
    });

    await recordFixChosen(record.id, "open-sign-in");
    const history = await readErrorHistory();
    expect(history[0]?.chosen).toBe("open-sign-in");
    expect(history[0]?.outcome).toBe("pending");

    await recordFixOutcome(record.id, "worked");
    const after = await readErrorHistory();
    expect(after[0]?.outcome).toBe("worked");
  });

  it("does not let a later outcome overwrite a dismissal", async () => {
    const record = await recordErrorShown({
      repoPath: null,
      code: "pathspec",
      command: "checkout HEAD -- nope.txt",
      offered: ["retry"],
    });

    await recordFixDismissed(record.id);
    // A fix that was never tried must never be recorded as having failed.
    await recordFixOutcome(record.id, "failed");

    const history = await readErrorHistory();
    expect(history[0]?.outcome).toBe("dismissed");
    expect(history[0]?.chosen).toBeNull();
  });

  it("returns null for an id it does not recognise", async () => {
    expect(await recordFixChosen("err-does-not-exist", "retry")).toBeNull();
    expect(await recordFixOutcome("err-does-not-exist", "worked")).toBeNull();
    expect(await recordFixDismissed("err-does-not-exist")).toBeNull();
  });

  it("scores each fix by whether it actually worked", async () => {
    const shot = async (chosen: string, outcome: "worked" | "failed") => {
      const r = await recordErrorShown({
        repoPath: "/srv/app",
        code: "push-rejected",
        command: "push origin main",
        offered: ["pull-then-push", "force-push"],
      });
      await recordFixChosen(r.id, chosen);
      await recordFixOutcome(r.id, outcome);
    };

    await shot("pull-then-push", "worked");
    await shot("pull-then-push", "worked");
    await shot("pull-then-push", "failed");
    await shot("force-push", "failed");

    const scorecard = await fixScorecard("push-rejected");
    const pull = scorecard.find((s) => s.fixId === "pull-then-push");
    const force = scorecard.find((s) => s.fixId === "force-push");

    // This is the whole reason the scorecard exists: it can tell a card that
    // one button works and the other does not.
    expect(pull).toEqual({ fixId: "pull-then-push", tried: 3, worked: 2 });
    expect(force).toEqual({ fixId: "force-push", tried: 1, worked: 0 });
  });

  it("scores nothing for an error code it has never seen", async () => {
    await recordErrorShown({
      repoPath: null,
      code: "index-lock",
      command: "add -A",
      offered: ["remove-lock"],
    });
    expect(await fixScorecard("remote-auth")).toEqual([]);
  });

  it("ignores entries whose fix was never chosen", async () => {
    await recordErrorShown({
      repoPath: null,
      code: "remote-unreachable",
      command: "fetch origin",
      offered: ["retry"],
    });
    expect(await fixScorecard("remote-unreachable")).toEqual([]);
  });

  it("keeps at most MAX_HISTORY_ENTRIES and drops the oldest", async () => {
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 20; i++) {
      await recordErrorShown({
        repoPath: `/srv/app-${i}`,
        code: "pathspec",
        command: "rev-parse nosuchref",
        offered: ["retry"],
      });
    }

    const history = await readErrorHistory();
    expect(history).toHaveLength(MAX_HISTORY_ENTRIES);
    // The survivors are the newest, so the history shows recent failures.
    expect(history.at(-1)?.repoPath).toBe(`/srv/app-${MAX_HISTORY_ENTRIES + 19}`);
    expect(history[0]?.repoPath).toBe("/srv/app-20");
  });

  it("stores it in the app-data folder and never next to a repo", async () => {
    await recordErrorShown({
      repoPath: "/srv/app",
      code: "not-a-repo",
      command: "status",
      offered: ["init-here"],
    });

    const onDisk = readFileSync(join(dir, "error-history.json"), "utf8");
    expect(JSON.parse(onDisk).version).toBe(1);
    // The path recorded is the repo it happened in, not where history lives.
    expect(onDisk).toContain("/srv/app");
  });
});
