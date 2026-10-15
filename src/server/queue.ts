/** Per-repo single-writer queue.
 *
 *  Git mutates a repository through several processes and expects only one
 *  writer at a time: a `status` reading the index while an `add` rewrites it,
 *  or two commits racing for the same lock, is exactly the class of bug that
 *  silently corrupts a user's work. Every git call against a repo is therefore
 *  funnelled through one queue keyed by that repo's path, and each call waits
 *  for the previous one in the same repo to finish.
 *
 *  Different repos never block each other — the keys are independent chains —
 *  so scanning twenty folders still runs in parallel.
 *
 *  A rejection does not poison the chain: the next task runs even if the
 *  previous one failed, and the caller sees its own error, not its
 *  predecessor's. */
export class RepoQueue {
  private tails = new Map<string, Promise<void>>();
  private counts = new Map<string, number>();

  /** Run `task` after every task already queued for `key` has settled. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Chain off a copy that always resolves, so one failure cannot reject
    // the tail every later task waits on.
    const tail = previous.then(() => undefined, () => undefined);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    const decrement = () => {
      const left = (this.counts.get(key) ?? 1) - 1;
      if (left <= 0) this.counts.delete(key);
      else this.counts.set(key, left);
    };
    const result = tail.then(task);
    this.tails.set(key, result.then(decrement, decrement));
    return result;
  }

  /** How many tasks for `key` are still queued or running. */
  pending(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** Forget a key entirely (a repo that was unregistered or pruned), so the
   *  map does not grow without bound over a long session. */
  forget(key: string): void {
    this.tails.delete(key);
    this.counts.delete(key);
  }

  /** Keys currently held. Mostly for tests and diagnostics. */
  keys(): string[] {
    return [...this.tails.keys()];
  }
}
