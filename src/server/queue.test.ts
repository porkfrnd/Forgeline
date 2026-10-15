import { describe, expect, it } from "vitest";
import { RepoQueue } from "./queue.js";

describe("RepoQueue", () => {
  it("runs tasks for the same repo one at a time, in order", async () => {
    const queue = new RepoQueue();
    const log: string[] = [];
    const task = (label: string, ms: number) => async () => {
      log.push(`${label}:enter`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${label}:exit`);
    };
    await Promise.all([
      queue.run("/repo", task("a", 30)),
      queue.run("/repo", task("b", 5)),
      queue.run("/repo", task("c", 1)),
    ]);
    // Serialized: no task enters before the previous one has exited.
    expect(log).toEqual(["a:enter", "a:exit", "b:enter", "b:exit", "c:enter", "c:exit"]);
  });

  it("lets different repos run concurrently", async () => {
    const queue = new RepoQueue();
    const log: string[] = [];
    const task = (label: string, ms: number) => async () => {
      log.push(`${label}:enter`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${label}:exit`);
    };
    const slow = queue.run("/one", task("slow", 40));
    const fast = queue.run("/two", task("fast", 5));
    await Promise.all([slow, fast]);
    // The second repo starts before the first finishes: independent chains.
    expect(log.indexOf("fast:enter")).toBeLessThan(log.indexOf("slow:exit"));
  });

  it("keeps the chain alive after a task rejects", async () => {
    const queue = new RepoQueue();
    const order: string[] = [];
    const failing = queue.run("/repo", async () => {
      order.push("failing");
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    const next = await queue.run("/repo", async () => {
      order.push("next");
      return "ok";
    });
    expect(next).toBe("ok");
    expect(order).toEqual(["failing", "next"]);
  });

  it("returns each task's own value and error, not its predecessor's", async () => {
    const queue = new RepoQueue();
    await queue.run("/repo", async () => "first").catch(() => undefined);
    expect(await queue.run("/repo", async () => "second")).toBe("second");
  });

  it("counts pending work per key and forgets it on demand", async () => {
    const queue = new RepoQueue();
    // Initialised to a no-op so the type stays callable: the executor assigns
    // the real resolver synchronously, but TypeScript cannot see that.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const running = queue.run("/repo", async () => {
      await gate;
      return 1;
    });
    const queued = queue.run("/repo", async () => 2);
    expect(queue.pending("/repo")).toBe(2);
    expect(queue.pending("/other")).toBe(0);
    release();
    await Promise.all([running, queued]);
    expect(queue.pending("/repo")).toBe(0);
    queue.run("/repo", async () => 3);
    queue.forget("/repo");
    expect(queue.pending("/repo")).toBe(0);
    expect(queue.keys()).not.toContain("/repo");
  });
});
