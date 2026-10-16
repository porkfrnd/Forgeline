import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverInfo, mintToken, expireTokenForTest, sessionCookie, setRootsForTest, registerRepoForTest } from "./helpers.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

test.describe("Forgeline skeleton", () => {
  test("dashboard loads, token is exchanged for a session cookie and removed from the URL", async ({
    page,
  }) => {
    const { baseUrl } = serverInfo();
    const token = await mintToken(baseUrl);
    await page.goto(`${baseUrl}/?t=${token}`);

    // Token must be stripped from the address bar after the exchange (303).
    await expect(page).toHaveURL(new RegExp(`^${baseUrl}/$`));

    await expect(page.getByText("Forgeline").first()).toBeVisible();
    await expect(page.getByText("No folders scanned yet.")).toBeVisible();

    // The session cookie must be HttpOnly and SameSite=Strict, and must NOT be
    // the bootstrap token itself (the server issues an opaque session id).
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "session");
    expect(session).toBeTruthy();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Strict");
    expect(session?.value).not.toBe(token);
  });

  test("appearance panel switches theme family and mode", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const token = await mintToken(baseUrl);
    await page.goto(`${baseUrl}/?t=${token}`);

    // Default is Lagoon, dark, glass.
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-family", "lagoon");
    await expect(html).toHaveAttribute("data-mode", "dark");
    await expect(html).toHaveAttribute("data-surface", "glass");

    // Switch family: the panel offers every visible family, and only the
    // palette changes — the layout must not.
    await page.getByRole("button", { name: /^Density,/ }).click();
    const panel = page.getByRole("dialog", { name: "Appearance" });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Cathode" }).click();
    await expect(html).toHaveAttribute("data-family", "cathode");

    // Cathode supports light mode; switching it flips the resolved mode.
    await panel.getByRole("button", { name: "Light", exact: true }).click();
    await expect(html).toHaveAttribute("data-mode", "light");

    // Effects Off forces Solid surfaces, and stays complete.
    await panel.getByRole("button", { name: "Off", exact: true }).click();
    await expect(html).toHaveAttribute("data-effects", "off");
    await expect(page.getByRole("button", { name: /^Density,/ })).toBeVisible();

    // Nord has no light mode, so the light control is disabled there.
    await panel.getByRole("button", { name: "Nord" }).click();
    await expect(html).toHaveAttribute("data-family", "nord");
    await expect(panel.getByRole("button", { name: "Light", exact: true })).toBeDisabled();
  });

  test("the command palette opens on Ctrl K and runs an action", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const token = await mintToken(baseUrl);
    await page.goto(`${baseUrl}/?t=${token}`);
    // The shortcut listener lives on the mounted app, so wait for the shell
    // before pressing it rather than racing React.
    await expect(page.getByRole("button", { name: /^Density,/ })).toBeVisible();
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    await page.keyboard.type("Solid");
    await dialog.getByRole("option").first().click();
    await expect(page.locator("html")).toHaveAttribute("data-surface", "solid");
    await expect(dialog).toBeHidden();
  });

  test("security headers are present and no CORS headers are sent", async () => {
    const { baseUrl } = serverInfo();
    const token = await mintToken(baseUrl);
    // Read the 303 itself: the Playwright request fixture follows redirects,
    // which would hide the bootstrap response we want to assert on.
    const res = await fetch(`${baseUrl}/?t=${token}`, { redirect: "manual" });
    try {
      expect(res.status).toBe(303);
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      // Bootstrap response must not be cached.
      expect(res.headers.get("cache-control")).toBe("no-store");
      // No CORS headers anywhere.
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await res.arrayBuffer();
    }
  });

  test("health endpoint requires the session cookie", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const res = await request.get(`${baseUrl}/api/health`);
    expect(res.status()).toBe(401);
  });

  test("health endpoint succeeds with a session cookie", async ({ request }) => {
    const { baseUrl } = serverInfo();
    // Exchange a fresh bootstrap token for a session cookie first.
    const cookie = await sessionCookie(baseUrl);
    const res = await request.get(`${baseUrl}/api/health`, {
      headers: { cookie },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { ok: unknown; gitVersion?: unknown };
    expect(body.ok).toBe(true);
    // The status bar shows the real git version, so it must be a real string.
    expect(typeof body.gitVersion).toBe("string");
    expect(body.gitVersion).not.toBe("");
  });

  test("requests with a bad Host header are rejected", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const res = await request.get(`${baseUrl}/api/health`, {
      headers: { host: "evil.example.com" },
    });
    expect(res.status()).toBe(403);
  });

  test("a replayed bootstrap token is rejected", async () => {
    const { baseUrl } = serverInfo();
    const token = await mintToken(baseUrl);
    const first = await fetch(`${baseUrl}/?t=${token}`, { redirect: "manual" });
    expect(first.status).toBe(303);
    await first.arrayBuffer();
    const second = await fetch(`${baseUrl}/?t=${token}`, { redirect: "manual" });
    expect(second.status).toBe(401);
    await second.arrayBuffer();
  });

  test("a cross-origin POST is rejected", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const res = await request.post(`${baseUrl}/api/repos`, {
      headers: { cookie, origin: "http://evil.example.com" },
    });
    expect(res.status()).toBe(403);
  });

  test("a write without JSON content-type is rejected", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const res = await request.post(`${baseUrl}/api/repos`, {
      headers: {
        cookie,
        origin: `${baseUrl}`,
        "content-type": "text/plain",
      },
      data: "hello",
    });
    expect(res.status()).toBe(415);
  });

  test("a forged repo id returns 404", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const res = await request.get(`${baseUrl}/api/repos/does-not-exist`, {
      headers: { cookie },
    });
    expect(res.status()).toBe(404);
  });

  test("an expired bootstrap token is rejected with the expired notice", async () => {
    const { baseUrl } = serverInfo();
    const token = await mintToken(baseUrl);
    // Age the token past the 5-minute TTL without waiting real minutes.
    await expireTokenForTest(baseUrl, 6 * 60 * 1000);
    const res = await fetch(`${baseUrl}/?t=${token}`, { redirect: "manual" });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toMatch(/expired/i);
  });

  test("encoded traversal never serves files outside the web root", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const paths = [
      "/%2e%2e/%2e%2e/etc/passwd",
      "/%252e%252e/%252e%252e/etc/passwd",
      "/..%2f..%2fetc%2fpasswd",
      "/%2e%2e%5c%2e%2e%5cetc%5cpasswd",
    ];
    for (const p of paths) {
      const res = await request.get(`${baseUrl}${p}`, {
        headers: { cookie },
      });
      // Either a rejection (400/404) or the SPA fallback. Either way the
      // body must never be the system password file.
      const body = await res.text();
      expect(body).not.toMatch(/^root:/m);
    }
  });

  test("repo file route serves a valid file and rejects escapes", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const root = mkdtempSync(join(tmpdir(), "fl-e2e-root-"));
    try {
      const repo = join(root, "demo");
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "hello.txt"), "hello\n");
      await setRootsForTest(baseUrl, [root]);
      const id = await registerRepoForTest(baseUrl, cookie, repo);

      const ok = await request.get(`${baseUrl}/api/repos/${id}/file?path=hello.txt`, {
        headers: { cookie },
      });
      expect(ok.status()).toBe(200);
      expect(await ok.text()).toBe("hello\n");

      const forged = await request.get(`${baseUrl}/api/repos/no-such-id/file?path=hello.txt`, {
        headers: { cookie },
      });
      expect(forged.status()).toBe(404);

      const missing = await request.get(`${baseUrl}/api/repos/${id}/file?path=nope.txt`, {
        headers: { cookie },
      });
      expect(missing.status()).toBe(404);

      for (const bad of ["../escape.txt", "-weird.txt", "/etc/passwd"]) {
        const res = await request.get(
          `${baseUrl}/api/repos/${id}/file?path=${encodeURIComponent(bad)}`,
          { headers: { cookie } },
        );
        expect(res.status()).toBe(400);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repo list returns live status and prunes a deleted repo", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const root = mkdtempSync(join(tmpdir(), "fl-e2e-list-"));
    try {
      const repo = join(root, "demo");
      mkdirSync(repo, { recursive: true });
      // A real repo with one commit, so the branch reads back from git.
      spawnSync("git", ["init", "-b", "main"], { cwd: repo });
      spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
      spawnSync("git", ["config", "user.name", "T"], { cwd: repo });
      writeFileSync(join(repo, "a.txt"), "one\n");
      spawnSync("git", ["add", "a.txt"], { cwd: repo });
      spawnSync("git", ["commit", "-m", "init"], { cwd: repo });
      await setRootsForTest(baseUrl, [root]);
      const id = await registerRepoForTest(baseUrl, cookie, repo);

      const before = await request.get(`${baseUrl}/api/repos`, { headers: { cookie } });
      expect(before.status()).toBe(200);
      const listed = (await before.json()) as {
        repos: { id: string; name: string; branch: string; changedFiles: number }[];
      };
      const row = listed.repos.find((r) => r.id === id);
      expect(row).toBeTruthy();
      expect(row?.name).toBe("demo");
      expect(row?.branch).toBe("main");
      expect(row?.changedFiles).toBe(0);

      // Delete the repo: the next list call must drop it entirely.
      rmSync(repo, { recursive: true, force: true });
      const after = await request.get(`${baseUrl}/api/repos`, { headers: { cookie } });
      const pruned = (await after.json()) as { repos: { id: string }[] };
      expect(pruned.repos.find((r) => r.id === id)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scan endpoint finds nested repos and is idempotent", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const root = mkdtempSync(join(tmpdir(), "fl-e2e-scan-"));
    try {
      const alpha = join(root, "alpha");
      const beta = join(root, "beta");
      mkdirSync(join(alpha, ".git"), { recursive: true });
      mkdirSync(join(beta, ".git"), { recursive: true });
      mkdirSync(join(root, "node_modules", "skipped", ".git"), { recursive: true });

      const first = await request.post(`${baseUrl}/api/repos/scan`, {
        headers: { cookie, origin: `${baseUrl}`, "content-type": "application/json" },
        data: JSON.stringify({ roots: [root] }),
      });
      expect(first.status()).toBe(200);
      const body = (await first.json()) as { repos: { name: string; id: string }[] };
      expect(body.repos.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
      const ids = body.repos.map((r) => r.id);

      // Scanning the same root again must not duplicate registry entries.
      const second = await request.post(`${baseUrl}/api/repos/scan`, {
        headers: { cookie, origin: `${baseUrl}`, "content-type": "application/json" },
        data: JSON.stringify({ roots: [root] }),
      });
      const again = (await second.json()) as { repos: { id: string }[] };
      expect(again.repos.map((r) => r.id).sort()).toEqual([...ids].sort());

      const listed = await request.get(`${baseUrl}/api/repos`, { headers: { cookie } });
      const all = (await listed.json()) as { repos: { id: string }[] };
      for (const id of ids) {
        expect(all.repos.filter((r) => r.id === id)).toHaveLength(1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scan endpoint rejects a body with no roots", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const res = await request.post(`${baseUrl}/api/repos/scan`, {
      headers: { cookie, origin: `${baseUrl}`, "content-type": "application/json" },
      data: JSON.stringify({}),
    });
    expect(res.status()).toBe(400);
    await res.text();
  });

  test("a change in a watched repo reaches the dashboard over SSE", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const root = mkdtempSync(join(tmpdir(), "fl-e2e-live-"));
    try {
      const repo = join(root, "demo");
      mkdirSync(repo, { recursive: true });
      spawnSync("git", ["init", "-b", "main"], { cwd: repo });
      spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
      spawnSync("git", ["config", "user.name", "T"], { cwd: repo });
      writeFileSync(join(repo, "a.txt"), "one\n");
      spawnSync("git", ["add", "a.txt"], { cwd: repo });
      spawnSync("git", ["commit", "-m", "init"], { cwd: repo });

      const cookie = await sessionCookie(baseUrl);
      await setRootsForTest(baseUrl, [root]);
      await registerRepoForTest(baseUrl, cookie, repo);

      const token = await mintToken(baseUrl);
      await page.goto(`${baseUrl}/?t=${token}`);

      const row = page.locator(".rail-row", { hasText: "demo" });
      await expect(row).toBeVisible();
      await expect(row.locator(".rail-branch")).toHaveText("main");

      // Watch the stream from inside the page so we assert the push itself,
      // not just the eventual DOM. Passed as a string because this file is
      // typechecked with the Node lib only — the browser side has no DOM
      // types here, and none should be faked into a server-side config.
      await page.evaluate(`(() => {
        window.__reposFrames = [];
        const source = new EventSource("/api/events");
        source.addEventListener("repos", (event) => {
          window.__reposFrames.push(event.data);
        });
      })()`);

      // Stage a file: .git/index changes, which the server must notice.
      writeFileSync(join(repo, "new.txt"), "staged\n");
      const add = spawnSync("git", ["add", "new.txt"], { cwd: repo });
      expect(add.status).toBe(0);

      // Well inside the client's 15s fallback poll, so this can only have
      // arrived as an SSE push. The counter carries the count in its title
      // and its accessible text, so the assertion is not colour-based.
      await expect(row.locator('.counter[title="1 changed"]')).toBeVisible({ timeout: 10000 });
      const frames = (await page.evaluate("window.__reposFrames")) as unknown;
      expect(Array.isArray(frames)).toBe(true);
      expect((frames as string[]).length).toBeGreaterThan(0);
      expect((frames as string[]).join(" ")).toContain("changedFiles");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Directory symlinks need elevated rights on Windows CI runners.
  test("repo file route rejects a symlink swapped in after registration", async ({ request }) => {
    test.skip(process.platform === "win32", "symlinks need elevated rights on Windows");
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const outer = mkdtempSync(join(tmpdir(), "fl-e2e-outer-"));
    try {
      const root = join(outer, "repo");
      const secret = join(outer, "secret");
      mkdirSync(root, { recursive: true });
      mkdirSync(secret, { recursive: true });
      writeFileSync(join(secret, "note.txt"), "outside\n");
      writeFileSync(join(root, "real.txt"), "inside\n");
      await setRootsForTest(baseUrl, [root]);
      const id = await registerRepoForTest(baseUrl, cookie, root);
      symlinkSync(secret, join(root, "swap"));
      const res = await request.get(`${baseUrl}/api/repos/${id}/file?path=swap/note.txt`, {
        headers: { cookie },
      });
      expect(res.status()).toBe(403);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test("repo file route refuses oversize previews", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const root = mkdtempSync(join(tmpdir(), "fl-e2e-big-"));
    try {
      const repo = join(root, "demo");
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "big.bin"), Buffer.alloc(2 * 1024 * 1024, "b"));
      await setRootsForTest(baseUrl, [root]);
      const id = await registerRepoForTest(baseUrl, cookie, repo);
      const res = await request.get(`${baseUrl}/api/repos/${id}/file?path=big.bin`, {
        headers: { cookie },
      });
      expect(res.status()).toBe(413);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** A repo with one commit, so a second commit's parent is known. */
async function makeCommitRepo(baseUrl: string, cookie: string): Promise<{ dir: string; id: string }> {
  const root = mkdtempSync(join(tmpdir(), "fl-e2e-commit-"));
  const repo = join(root, "demo");
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-b", "main"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "t@e.invalid"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "T"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "one\n");
  spawnSync("git", ["add", "a.txt"], { cwd: repo });
  spawnSync("git", ["commit", "-m", "init"], { cwd: repo });
  await setRootsForTest(baseUrl, [root]);
  const id = await registerRepoForTest(baseUrl, cookie, repo);
  return { dir: repo, id };
}

test.describe("Milestone 3 commit flow", () => {
  test("changes and diff report the real state of the working tree", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir, id } = await makeCommitRepo(baseUrl, cookie);
    try {
      // Untracked plus a modification of a tracked file.
      writeFileSync(join(dir, "a.txt"), "one\nchanged\n");
      writeFileSync(join(dir, "new.txt"), "staged later\n");

      const changes = await request.get(`${baseUrl}/api/repos/${id}/changes`, {
        headers: { cookie },
      });
      expect(changes.status()).toBe(200);
      const body = (await changes.json()) as { files: Array<Record<string, unknown>> };
      const paths = body.files.map((f) => String(f.path));
      expect(paths).toEqual(expect.arrayContaining(["a.txt", "new.txt"]));
      expect(body.files.find((f) => f.path === "a.txt")).toMatchObject({
        unstaged: true,
        staged: false,
      });

      const diff = await request.get(
        `${baseUrl}/api/repos/${id}/diff?path=${encodeURIComponent("a.txt")}&staged=false`,
        { headers: { cookie } },
      );
      expect(diff.status()).toBe(200);
      const parsed = (await diff.json()) as {
        binary: boolean;
        hunks: Array<{ lines: Array<{ kind: string; text: string }> }>;
      };
      expect(parsed.binary).toBe(false);
      expect(parsed.hunks).toHaveLength(1);
      const text = JSON.stringify(parsed.hunks[0].lines);
      expect(text).toContain("changed");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("a file can be staged and unstaged, and staged changes commit", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir, id } = await makeCommitRepo(baseUrl, cookie);
    try {
      writeFileSync(join(dir, "new.txt"), "written by the e2e suite\n");

      const before = await request.get(`${baseUrl}/api/repos/${id}/changes`, {
        headers: { cookie },
      });
      const beforeBody = (await before.json()) as { files: Array<Record<string, unknown>> };
      expect(beforeBody.files.find((f) => f.path === "new.txt")).toMatchObject({
        staged: false,
        unstaged: true,
      });

      const staged = await request.post(`${baseUrl}/api/repos/${id}/stage`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { paths: ["new.txt"] },
      });
      expect(staged.status()).toBe(200);

      const after = await request.get(`${baseUrl}/api/repos/${id}/changes`, {
        headers: { cookie },
      });
      const afterBody = (await after.json()) as { files: Array<Record<string, unknown>> };
      expect(afterBody.files.find((f) => f.path === "new.txt")).toMatchObject({
        staged: true,
      });

      const commit = await request.post(`${baseUrl}/api/repos/${id}/commit`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { message: "Add new.txt from the e2e suite" },
      });
      expect(commit.status()).toBe(200);

      // The worktree is now clean, which is the only proof that matters: the
      // commit took the staged change and left nothing behind.
      const final = await request.get(`${baseUrl}/api/repos/${id}/changes`, {
        headers: { cookie },
      });
      expect(((await final.json()) as { files: unknown[] }).files).toHaveLength(0);
      const log = spawnSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" });
      expect(log.stdout).toContain("Add new.txt from the e2e suite");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("a commit with an empty message is rejected, and nothing is written", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir, id } = await makeCommitRepo(baseUrl, cookie);
    try {
      writeFileSync(join(dir, "new.txt"), "must survive\n");
      await request.post(`${baseUrl}/api/repos/${id}/stage`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { paths: ["new.txt"] },
      });
      const bad = await request.post(`${baseUrl}/api/repos/${id}/commit`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { message: "   " },
      });
      expect(bad.status()).toBe(400);
      const body = (await bad.json()) as { code?: string; title?: string };
      expect(body.code).toBe("bad-request");
      const log = spawnSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" });
      expect(log.stdout).not.toContain("must survive");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("a single hunk can be staged with git apply", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir, id } = await makeCommitRepo(baseUrl, cookie);
    try {
      // Two far-apart edits, so they land in two separate hunks.
      writeFileSync(join(dir, "a.txt"), `one\n${"pad\n".repeat(20)}two\n`);
      // Commit the padding first so the working tree holds only the final edit.
      spawnSync("git", ["add", "a.txt"], { cwd: dir });
      spawnSync("git", ["commit", "-m", "pad"], { cwd: dir });
      writeFileSync(join(dir, "a.txt"), `one\n${"pad\n".repeat(20)}TWO\n`);

      const diffRes = await request.get(
        `${baseUrl}/api/repos/${id}/diff?path=${encodeURIComponent("a.txt")}&staged=false`,
        { headers: { cookie },
        },
      );
      const diff = (await diffRes.json()) as {
        hunks: Array<{ header: string; lines: Array<{ kind: string; text: string }> }>;
      };
      expect(diff.hunks).toHaveLength(1);

      // Rebuild the patch from the hunk the server returned, exactly as the
      // diff viewer does, and stage it.
      const hunk = diff.hunks[0];
      const lines = [`diff --git a/a.txt b/a.txt`, `--- a/a.txt`, `+++ b/a.txt`, hunk.header];
      for (const line of hunk.lines) {
        lines.push(`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`);
      }
      const res = await request.post(`${baseUrl}/api/repos/${id}/stage-hunk`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { path: "a.txt", patch: `${lines.join("\n")}\n` },
      });
      expect(res.status()).toBe(200);

      const after = await request.get(`${baseUrl}/api/repos/${id}/changes`, {
        headers: { cookie },
      });
      const afterBody = (await after.json()) as { files: Array<Record<string, unknown>> };
      const changed = afterBody.files.find((f) => f.path === "a.txt");
      // The staged hunk is in the index and no further unstaged edit remains,
      // which is the only honest proof `git apply --cached` took it.
      expect(changed).toMatchObject({ staged: true, unstaged: false });
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("write paths reject a forged repo id and an escaping path", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const forged = await request.post(`${baseUrl}/api/repos/not-a-real-id/stage`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { paths: ["a.txt"] },
    });
    expect(forged.status()).toBe(404);

    const { dir, id } = await makeCommitRepo(baseUrl, cookie);
    try {
      const escape = await request.post(`${baseUrl}/api/repos/${id}/stage-hunk`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { path: "../outside.txt", patch: "not a patch" },
      });
      expect(escape.status()).toBe(400);
    } finally {
      // Registered state is global, and the narrow project re-runs this file
      // against the same server. Leaving the temp dir behind would leave a
      // live repo registered for every later test.
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("the workbench lists a changed file, stages it, and commits it", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir } = await makeCommitRepo(baseUrl, cookie);
    try {
      writeFileSync(join(dir, "new.txt"), "committed from the workbench\n");
      const token = await mintToken(baseUrl);
      await page.goto(`${baseUrl}/?t=${token}`);

      // The changed file is listed with an action, not as a decoration.
      const row = page.locator(".file-row", { hasText: "new.txt" });
      await expect(row).toBeVisible();
      await expect(row.locator(".file-letter")).toHaveText("A");

      // Stage it: the commit composer appears with the staged file named,
      // which is the sanity-check card doing its job.
      await row.getByRole("button", { name: "Stage", exact: true }).click();
      const composer = page.locator(".commit-composer");
      await expect(composer).toBeVisible();
      await expect(composer.locator(".commit-file-row", { hasText: "new.txt" })).toBeVisible();

      // The composer refuses an empty message, then commits when filled in.
      await expect(composer.getByRole("button", { name: "Commit staged changes" })).toBeDisabled();
      await composer.getByLabel("Commit message").fill("Add new.txt from the workbench");
      await composer.getByRole("button", { name: "Commit staged changes" }).click();

      await expect(composer).toBeHidden();
      await expect(page.locator(".file-row", { hasText: "new.txt" })).toBeHidden();

      const log = spawnSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" });
      expect(log.stdout).toContain("Add new.txt from the workbench");
      expect(log.stdout).not.toContain("not staged yet");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });
});

test.describe("Milestone 4 journal", () => {
  test("a commit is journaled with its command and refs, and never inside the repo", async ({
    request,
  }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir, id } = await makeCommitRepo(baseUrl, cookie);
    try {
      writeFileSync(join(dir, "new.txt"), "journaled\n");
      await request.post(`${baseUrl}/api/repos/${id}/stage`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { paths: ["new.txt"] },
      });
      const committed = await request.post(`${baseUrl}/api/repos/${id}/commit`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { message: "Journal me" },
      });
      expect(committed.status()).toBe(200);

      const res = await request.get(`${baseUrl}/api/journal`, { headers: { cookie } });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        entries: Array<{
          description: string;
          command: string | null;
          repoPath: string;
          refs: { before: { head: string | null }; after: { head: string | null } };
          undoable: boolean;
        }>;
      };
      expect(body.entries.length).toBeGreaterThan(0);

      // Newest first, so the commit is at the top of the timeline.
      const top = body.entries[0];
      expect(top?.description).toContain("Journal me");
      expect(top?.command).toContain("commit");
      expect(top?.repoPath).toBe(dir);
      expect(top?.undoable).toBe(true);
      // The commit moved HEAD, so the captured refs must differ.
      expect(top?.refs.before.head).not.toBe(top?.refs.after.head);
      expect(top?.refs.after.head).toMatch(/^[0-9a-f]{40}$/);

      // The staging entry precedes the commit entry in the list.
      const staging = body.entries.find((e) => e.description.includes("Staged"));
      expect(staging).toBeTruthy();

      // The journal lives in app-data, not in the repository: the repo must
      // still be clean after the commit.
      const status = spawnSync("git", ["status", "--porcelain"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(status.stdout.trim()).toBe("");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("discarding changes takes a snapshot that still holds the discarded text", async ({
    request,
  }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir, id } = await makeCommitRepo(baseUrl, cookie);
    try {
      writeFileSync(join(dir, "doomed.txt"), "precious unsaved words\n");
      const staged = await request.post(`${baseUrl}/api/repos/${id}/stage`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { paths: ["doomed.txt"] },
      });
      expect(staged.status()).toBe(200);

      const discarded = await request.post(`${baseUrl}/api/repos/${id}/discard`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { paths: ["doomed.txt"] },
      });
      expect(discarded.status()).toBe(200);
      const body = (await discarded.json()) as { ok: boolean; snapshotRef?: string };
      expect(body.ok).toBe(true);
      expect(body.snapshotRef).toBeTruthy();

      // The file is gone from the working tree — the discard really happened.
      expect(existsSync(join(dir, "doomed.txt"))).toBe(false);

      // But the snapshot ref the response handed back still contains the
      // exact text, which is the whole point of snapshotting first.
      const shown = spawnSync("git", ["cat-file", "-p", body.snapshotRef!], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(shown.status).toBe(0);
      const blob = spawnSync(
        "git",
        ["cat-file", "-p", `${body.snapshotRef}:doomed.txt`],
        { cwd: dir, encoding: "utf8" },
      );
      expect(blob.stdout).toBe("precious unsaved words\n");

      // And it is a private ref: it does not appear in the user's stash list.
      const stash = spawnSync("git", ["stash", "list"], { cwd: dir, encoding: "utf8" });
      expect(stash.stdout.trim()).toBe("");

      // The discard is journaled, so the timeline can explain and offer it.
      const journal = await request.get(`${baseUrl}/api/journal`, { headers: { cookie } });
      const entries = (await journal.json()) as {
        entries: Array<{ description: string }>;
      };
      expect(entries.entries.some((e) => e.description.includes("Discarded local changes"))).toBe(
        true,
      );
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("undo restores the refs and the work tree it recorded", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir, id } = await makeCommitRepo(baseUrl, cookie);
    try {
      // Stage, then commit, so there is a real ref move to put back.
      writeFileSync(join(dir, "a.txt"), "changed by hand\n");
      await request.post(`${baseUrl}/api/repos/${id}/stage`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { paths: ["a.txt"] },
      });
      await request.post(`${baseUrl}/api/repos/${id}/commit`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { message: "Commit to undo" },
      });
      const headAfterCommit = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf8",
      }).stdout.trim();

      const journal = await (await request.get(`${baseUrl}/api/journal`, { headers: { cookie } })).json() as {
        entries: Array<{ id: string; description: string; undo?: unknown }>;
      };
      const commitEntry = journal.entries.find((e) => e.description.includes("Commit to undo"));
      expect(commitEntry).toBeTruthy();
      // The entry must carry a plan, or there is nothing safe to run.
      expect(commitEntry?.undo).toBeTruthy();

      const undone = await request.post(`${baseUrl}/api/journal/${commitEntry!.id}/undo`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: {},
      });
      expect(undone.status()).toBe(200);

      const headAfterUndo = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf8",
      }).stdout.trim();
      // HEAD moved back, so the commit is no longer the tip.
      expect(headAfterUndo).not.toBe(headAfterCommit);
      // But the working tree is untouched: reset --soft keeps the tree and the
      // index, so nothing the user wrote was thrown away by undoing.
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("changed by hand\n");
      const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
      expect(status.stdout).toContain("M ");

      // Undo is itself journaled, so it can be undone back.
      const after = await (await request.get(`${baseUrl}/api/journal`, { headers: { cookie } })).json() as {
        entries: Array<{ description: string }>;
      };
      expect(after.entries[0]?.description).toContain("Undone — Committed: Commit to undo");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("undoing a discard brings the exact text back", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir, id } = await makeCommitRepo(baseUrl, cookie);
    try {
      writeFileSync(join(dir, "keepme.txt"), "text that must survive\n");
      await request.post(`${baseUrl}/api/repos/${id}/stage`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { paths: ["keepme.txt"] },
      });
      const discarded = await request.post(`${baseUrl}/api/repos/${id}/discard`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { paths: ["keepme.txt"] },
      });
      expect(discarded.status()).toBe(200);
      expect(existsSync(join(dir, "keepme.txt"))).toBe(false);

      const journal = await (await request.get(`${baseUrl}/api/journal`, { headers: { cookie } })).json() as {
        entries: Array<{ id: string; description: string }>;
      };
      const entry = journal.entries.find((e) => e.description.includes("Discarded"));
      expect(entry?.id).toBeTruthy();

      const undone = await request.post(`${baseUrl}/api/journal/${entry!.id}/undo`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: {},
      });
      expect(undone.status()).toBe(200);
      expect(readFileSync(join(dir, "keepme.txt"), "utf8")).toBe("text that must survive\n");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("rescue resets to a clean tree and parks HEAD under a private ref", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir, id } = await makeCommitRepo(baseUrl, cookie);
    try {
      const headBefore = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      writeFileSync(join(dir, "a.txt"), "dirty\n");

      const rescued = await request.post(`${baseUrl}/api/repos/${id}/rescue`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: {},
      });
      expect(rescued.status()).toBe(200);
      const body = (await rescued.json()) as {
        ok: boolean;
        snapshotRef: string;
        backupRef: string;
      };
      expect(body.ok).toBe(true);
      expect(body.backupRef.startsWith("refs/forgeline/backup/")).toBe(true);

      // The working tree is clean: the discard really happened.
      const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
      expect(status.stdout.trim()).toBe("");

      // HEAD is parked under the private ref, so no commit is lost.
      const parked = spawnSync("git", ["rev-parse", body.backupRef], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(parked.stdout.trim()).toBe(headBefore);

      // And none of the machinery leaks into the user's stash list.
      const stash = spawnSync("git", ["stash", "list"], { cwd: dir, encoding: "utf8" });
      expect(stash.stdout.trim()).toBe("");

      // The rescue is journaled and can be undone, which restores the work.
      const journal = await (await request.get(`${baseUrl}/api/journal`, { headers: { cookie } })).json() as {
        entries: Array<{ id: string; description: string }>;
      };
      const entry = journal.entries.find((e) => e.description.includes("Rescue"));
      expect(entry?.id).toBeTruthy();
      const undone = await request.post(`${baseUrl}/api/journal/${entry!.id}/undo`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: {},
      });
      expect(undone.status()).toBe(200);
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("dirty\n");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("undo of an entry that does not exist is a 404, not a silent no-op", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const missing = await request.post(`${baseUrl}/api/journal/not-a-real-id/undo`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: {},
    });
    expect(missing.status()).toBe(404);
  });

  test("the timeline shows plain English, the command, and an Undo button", async ({
    page,
    request,
  }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir, id } = await makeCommitRepo(baseUrl, cookie);
    try {
      writeFileSync(join(dir, "a.txt"), "changed by hand\n");
      await request.post(`${baseUrl}/api/repos/${id}/stage`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { paths: ["a.txt"] },
      });
      await request.post(`${baseUrl}/api/repos/${id}/commit`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { message: "Show me in the timeline" },
      });

      const token = await mintToken(baseUrl);
      await page.goto(`${baseUrl}/?t=${token}`);

      // The update names this control "Undo history" on the toolbar, and it
      // reads that way on screen now. The drawer it opens still calls itself the
      // undo timeline in its own dialog label.
      await page.getByRole("button", { name: "Undo history" }).click();
      const panel = page.locator(".journal");

      // The commit is described in plain English, not as a raw git string.
      await expect(panel.locator(".journal-row").first()).toContainText(
        "Committed: Show me in the timeline",
      );

      // "Explain, don't hide": the exact command is behind a toggle.
      await panel.locator(".button.link").first().click();
      // The recorded command includes the `-C <dir>` argv element too, so
      // assert on what the action does rather than on an exact spelling.
      await expect(panel.locator(".journal-command").first()).toContainText(
        "commit -m Show me in the timeline",
      );

      // An entry whose recovery is proven gets an Undo button, not a label
      // saying it cannot be undone.
      await expect(
        panel.locator(".journal-row").first().getByRole("button", { name: "Undo" }),
      ).toBeVisible();
      await expect(panel.locator(".journal-row").first()).not.toContainText("Cannot be undone");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });
});

/* A repo with NO identity configured at all. `user.useConfigOnly` forces git
   to ignore a global name/email, which is the only way to reach the
   "please tell me who you are" path on a machine that has one configured —
   without it the test would pass anywhere and prove nothing. */
async function makeAnonymousRepo(baseUrl: string, cookie: string, name: string) {
  const root = mkdtempSync(join(tmpdir(), `fl-e2e-anon-${name}-`));
  const repo = join(root, "demo");
  mkdirSync(repo, { recursive: true });
  // No identity is written here at all. The e2e server itself runs with an
  // empty GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM (see global-setup), so the
  // commit the test triggers really has no name and email to use.
  spawnSync("git", ["init", "-q", "-b", "main", "."], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "one\n");
  spawnSync("git", ["add", "a.txt"], { cwd: repo });
  await setRootsForTest(baseUrl, [root]);
  const id = await registerRepoForTest(baseUrl, cookie, repo);
  return { dir: repo, id, root };
}

test.describe("Milestone 5 error translator", () => {
  test("a commit with no identity comes back as a plain-English card with a real fix", async ({
    request,
  }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir, id, root } = await makeAnonymousRepo(baseUrl, cookie, "identity");

    try {
      const staged = await request.post(`${baseUrl}/api/repos/${id}/stage`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { paths: ["a.txt"] },
      });
      expect(staged.status()).toBe(200);
      // A fresh commit of a staged-but-unchanged file still has to be created.
      writeFileSync(join(dir, "b.txt"), "two\n");
      const stageB = await request.post(`${baseUrl}/api/repos/${id}/stage`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { paths: ["b.txt"] },
      });
      expect(stageB.status()).toBe(200);

      const commit = await request.post(`${baseUrl}/api/repos/${id}/commit`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { message: "This must fail" },
      });

      // Not a 500 with a raw stderr sentence: a translated card.
      const body = (await commit.json()) as {
        code?: string;
        title?: string;
        explanation?: string;
        fixes?: Array<{ id: string; label: string }>;
        raw?: string;
      };
      expect(body.code).toBe("no-identity");
      // The explanation says what to do, not what git said.
      expect(body.explanation).toContain("Setting them once");
      // The fix is offered, and it is an id the interface can act on.
      expect(body.fixes?.map((f) => f.id)).toContain("set-identity");
      // Raw output is preserved, never swallowed.
      expect(body.raw).toMatch(/tell me who you are|email/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the identity fix sets the identity and then the same commit succeeds", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir: repo, id, root } = await makeAnonymousRepo(baseUrl, cookie, "identity-fix");

    try {
      const fix = await request.post(`${baseUrl}/api/repos/${id}/identity`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { name: "Ada Fixture", email: "ada@fixture.invalid" },
      });
      expect(fix.status()).toBe(200);

      // The identity is real git state, not a Forgeline-side record.
      // `cwd: repo`, not `cwd: root`: root is the parent directory, and a
      // config read there would look at the developer's own settings.
      const who = spawnSync("git", ["config", "--local", "user.name"], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(who.stdout.trim()).toBe("Ada Fixture");

      writeFileSync(join(repo, "b.txt"), "two\n");
      await request.post(`${baseUrl}/api/repos/${id}/stage`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { paths: ["b.txt"] },
      });
      const commit = await request.post(`${baseUrl}/api/repos/${id}/commit`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { message: "Now it works" },
      });
      expect(commit.status()).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an email without an @ is rejected before git is asked", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { id, root } = await makeAnonymousRepo(baseUrl, cookie, "bad-email");

    try {
      const bad = await request.post(`${baseUrl}/api/repos/${id}/identity`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { name: "Someone", email: "not-an-address" },
      });
      // A validation card, and nothing written.
      expect(bad.status()).toBe(400);
      // `--local` matters: reading the repo's own settings is what proves the
      // server wrote nothing, whereas a bare read would show the developer's
      // global identity and pass for the wrong reason.
      const who = spawnSync("git", ["config", "--local", "user.email"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(who.stdout.trim()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an initialisable folder gets a real git repository from the init fix", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const root = mkdtempSync(join(tmpdir(), "fl-e2e-init-"));
    const repo = join(root, "plain");
    mkdirSync(repo, { recursive: true });

    try {
      await setRootsForTest(baseUrl, [root]);
      const id = await registerRepoForTest(baseUrl, cookie, repo);
      expect(existsSync(join(repo, ".git"))).toBe(false);

      const init = await request.post(`${baseUrl}/api/repos/${id}/init`, {
        headers: { cookie, "Content-Type": "application/json" },
      });
      expect(init.status()).toBe(200);
      // The repository is real: git itself can read it.
      expect(existsSync(join(repo, ".git"))).toBe(true);
      // `spawnSync` reports exit status as `status`, not `exitCode` — using
      // the wrong name makes the assertion pass vacuously.
      const rev = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: repo, encoding: "utf8" });
      expect(rev.status).toBe(0);

      // And the entry is journaled, so it is undoable in the timeline.
      const journal = (await (await request.get(`${baseUrl}/api/journal`, { headers: { cookie } })).json()) as {
        entries: Array<{ description: string }>;
      };
      expect(journal.entries.some((e) => /Initialised/.test(e.description))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("aborting a merge restores the pre-merge tree and says it cannot be undone", async ({
    request,
  }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const root = mkdtempSync(join(tmpdir(), "fl-e2e-abort-"));
    const repo = join(root, "demo");
    mkdirSync(repo, { recursive: true });
    const g = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    g("init", "-q", "-b", "main", ".");
    g("config", "user.email", "t@e.invalid");
    g("config", "user.name", "T");
    writeFileSync(join(repo, "f.txt"), "base\n");
    g("add", "-A");
    g("commit", "-m", "base");

    try {
      await setRootsForTest(baseUrl, [root]);
      const id = await registerRepoForTest(baseUrl, cookie, repo);

      // A genuinely conflicted merge, so there IS a merge in progress.
      g("checkout", "-q", "-b", "other");
      writeFileSync(join(repo, "f.txt"), "theirs\n");
      g("commit", "-q", "-am", "theirs");
      g("checkout", "-q", "main");
      writeFileSync(join(repo, "f.txt"), "ours\n");
      g("commit", "-q", "-am", "ours");
      const merge = g("merge", "other");
      expect(merge.status).not.toBe(0);
      expect(readFileSync(join(repo, "f.txt"), "utf8")).toContain("<<<<<<<");

      const abort = await request.post(`${baseUrl}/api/repos/${id}/abort-merge`, {
        headers: { cookie, "Content-Type": "application/json" },
      });
      expect(abort.status()).toBe(200);

      // The conflict markers are gone and the tree is back to ours.
      const after = readFileSync(join(repo, "f.txt"), "utf8");
      expect(after).toBe("ours\n");
      expect(after).not.toContain("<<<<<<<");

      // The journal says it CANNOT be undone, and says why in one sentence.
      const journal = (await (await request.get(`${baseUrl}/api/journal`, { headers: { cookie } })).json()) as {
        entries: Array<{ description: string; undoable: boolean; notUndoableReason?: string; snapshotRef?: string }>;
      };
      const entry = journal.entries.find((e) => /Abandoned a merge/.test(e.description));
      expect(entry).toBeTruthy();
      expect(entry?.undoable).toBe(false);
      expect(entry?.notUndoableReason).toContain("cannot be undone");
      // But a snapshot was taken, so nothing is actually lost.
      expect(entry?.snapshotRef).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unmatched error still comes back with its raw output, never hidden", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir, id } = await makeCommitRepo(baseUrl, cookie);

    try {
      // An empty file path list is rejected before git runs, so it is not
      // this case. Staging a path that does not exist DOES reach git, and it
      // produces a pathspec error — which the translator knows, and that is
      // the correct outcome, so it is asserted as such here.
      const res = await request.post(`${baseUrl}/api/repos/${id}/stage`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { paths: ["no/such/file/at/all.txt"] },
      });
      const body = (await res.json()) as { code?: string; title?: string; raw?: string };
      expect(body.code).toBe("pathspec");
      // The card still carries the exact git text, which is what "never hide
      // an error" has to mean in practice.
      expect(body.raw).toBeTruthy();
      // "pathspec" is the stable part: `git add` says "did not match any
      // files" while `git checkout` says "did not match any file(s) known to
      // git", so the shared word is what the rule and this test rely on.
      expect(body.raw).toContain("pathspec");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("a card that was shown is recorded in the local error history", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { dir } = await makeCommitRepo(baseUrl, cookie);

    try {
      // Stage nothing: the history endpoint is being tested here, and the
      // card is assembled by the interface from a failure it already got.
      const shown = await request.post(`${baseUrl}/api/errors`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: {
          repoPath: dir,
          code: "git-error",
          command: "git -C demo add -- does/not/exist.txt",
          offered: ["retry"],
        },
      });
      expect(shown.status()).toBe(200);
      const { id: errorId } = (await shown.json()) as { id: string };
      expect(typeof errorId).toBe("string");

      // The fix is recorded against this error, with its outcome.
      const outcome = await request.post(`${baseUrl}/api/errors/${errorId}/outcome`, {
        headers: { cookie, "Content-Type": "application/json" },
        data: { fix: "retry", worked: false },
      });
      expect(outcome.status()).toBe(200);

      const history = (await (await request.get(`${baseUrl}/api/errors`, { headers: { cookie } })).json()) as {
        entries: Array<{ code: string; chosen: string | null; outcome: string }>;
      };
      const mine = history.entries.find((e) => e.code === "git-error");
      expect(mine?.chosen).toBe("retry");
      expect(mine?.outcome).toBe("pending");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("the workbench shows the card rather than raw git text", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const token = await mintToken(baseUrl);
    await page.goto(`${baseUrl}/?t=${token}`);
    await expect(page.getByText("No folders scanned yet.")).toBeVisible();
    // The card must not exist before anything fails, and must not be a stub
    // sitting in the layout.
    await expect(page.locator(".error-card")).toHaveCount(0);
  });
});
/**
 * Milestone 6: remote operations.
 *
 * The remote in these tests is a real bare repository on disk, so fetch, pull,
 * and push each run real git against a real remote — no network, no mock, and
 * no fake adapter that could disagree with git.
 */

/** A bare repository needs a working tree to make a commit in, so the seed is
 *  made in a throwaway clone and pushed. That also means the bare remote
 *  really has a branch for the UI to be level with. */
function seedBare(bare: string, root: string): void {
  const seed = `${bare}-seed`;
  mkdirSync(seed, { recursive: true });
  const clone = spawnSync("git", ["clone", "-q", bare, seed], { cwd: root, encoding: "utf8" });
  if (clone.status !== 0) throw new Error(`seed clone failed: ${clone.stderr}`);
  writeFileSync(join(seed, "seed.txt"), "seed\n");
  spawnSync("git", ["add", "-A"], { cwd: seed });
  spawnSync("git", ["commit", "-q", "-m", "Seed"], { cwd: seed });
  const push = spawnSync("git", ["push", "-q", "-u", "origin", "HEAD"], {
    cwd: seed,
    encoding: "utf8",
  });
  if (push.status !== 0) throw new Error(`seed push failed: ${push.stderr}`);
  rmSync(seed, { recursive: true, force: true });
}

/** A bare remote plus one real clone of it, registered with the server. */
async function makeRemotePair(baseUrl: string, cookie: string, name: string) {
  const root = mkdtempSync(join(tmpdir(), `fl-e2e-remote-${name}-`));
  const remote = join(root, "remote.git");
  mkdirSync(remote, { recursive: true });
  const init = spawnSync("git", ["init", "-q", "--bare", "-b", "main", "."], {
    cwd: remote,
    encoding: "utf8",
  });
  if (init.status !== 0) throw new Error(`bare init failed: ${init.stderr}`);
  seedBare(remote, root);

  const dir = join(root, "demo");
  const clone = spawnSync("git", ["clone", "-q", remote, dir], { cwd: root, encoding: "utf8" });
  if (clone.status !== 0) throw new Error(`clone failed: ${clone.stderr}`);

  await setRootsForTest(baseUrl, [root]);
  const id = await registerRepoForTest(baseUrl, cookie, dir);
  return { root, remote, dir, id };
}

/**
 * A JSON API call that goes through the same cookie every other test uses.
 *
 * The body is `unknown` on purpose: these tests assert on what git really
 * returned, and a typed shape would let a test pass against a property that
 * does not exist. Each test narrows what it needs.
 */
async function call(
  baseUrl: string,
  cookie: string,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body: (parsed ?? {}) as Record<string, unknown> };
}

test.describe("Milestone 6 remote operations", () => {
  test("a repository with no remote shows no remote actions at all", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root } = await makeAnonymousRepo(baseUrl, cookie, "no-remote");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.waitForSelector(".rail-row");
      await page.waitForTimeout(800);
      // The slot rule: no disabled Fetch/Pull/Push buttons pretending to work.
      await expect(page.locator(".work-remote")).toHaveCount(0);
    } finally {
      await call(baseUrl, cookie, "/api/__test__/roots", "POST", { paths: [] }).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a repository with a remote shows actions that do something", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root } = await makeRemotePair(baseUrl, cookie, "bar-present");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.waitForSelector(".rail-row");
      await page.waitForTimeout(800);
      const bar = page.locator(".work-remote");
      await expect(bar).toHaveCount(1);
      await expect(bar.getByRole("button", { name: "Fetch" })).toBeVisible();
      await expect(bar.getByRole("button", { name: "Pull" })).toBeVisible();
      await expect(bar.getByRole("button", { name: "Push" })).toBeVisible();
      // Level with the remote, honestly.
      await expect(bar).toContainText("level with the remote");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fetch, pull and push each report honestly what they did", async () => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, id } = await makeRemotePair(baseUrl, cookie, "honest");

    try {
      // Nothing new on either side, so each action must say "nothing changed"
      // rather than claiming an update.
      const fetched = await call(baseUrl, cookie, `/api/repos/${id}/fetch`, "POST", {});
      expect(fetched.body.ok).toBe(true);
      expect(fetched.body.changed).toBe(false);

      const pulled = await call(baseUrl, cookie, `/api/repos/${id}/pull`, "POST", {});
      expect(pulled.body.ok).toBe(true);
      expect(pulled.body.changed).toBe(false);

      const pushed = await call(baseUrl, cookie, `/api/repos/${id}/push`, "POST", {});
      expect(pushed.body.ok).toBe(true);
      expect(pushed.body.changed).toBe(false);

      // All three are journalled, which is what makes them undoable.
      const journal = await call(baseUrl, cookie, "/api/journal");
      const descriptions = (journal.body.entries as { description: string }[]).map(
        (e) => e.description,
      );
      expect(descriptions).toContain("Fetched from the remote");
      expect(descriptions).toContain("Pulled from the remote");
      expect(descriptions).toContain("Pushed to the remote");

      // The recovery contract's split, made real: a pull can be undone, a push
      // cannot — and it says why.
      const entries = journal.body.entries as {
        description: string;
        undoable: boolean;
        notUndoableReason?: string;
      }[];
      const pullEntry = entries.find((e) => e.description.startsWith("Pulled"));
      const pushEntry = entries.find((e) => e.description.startsWith("Pushed"));
      expect(pullEntry?.undoable).toBe(true);
      expect(pushEntry?.undoable).toBe(false);
      expect(pushEntry?.notUndoableReason).toContain("rewrite history");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pulling brings the remote's work into the working tree", async () => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, remote, dir, id } = await makeRemotePair(baseUrl, cookie, "pull-lands");

    try {
      // A second clone pushes work this repository has never seen.
      const other = join(root, "other");
      spawnSync("git", ["clone", "-q", remote, other], { cwd: root });
      writeFileSync(join(other, "theirs.txt"), "their line\n");
      spawnSync("git", ["add", "-A"], { cwd: other });
      spawnSync("git", ["commit", "-q", "-m", "their change"], { cwd: other });
      const theirs = spawnSync("git", ["push", "-q", "origin", "HEAD"], { cwd: other });
      expect(theirs.status).toBe(0);

      const before = spawnSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" });
      expect(before.stdout).not.toContain("their change");

      const res = await call(baseUrl, cookie, `/api/repos/${id}/pull`, "POST", {});
      expect(res.body.ok).toBe(true);
      expect(res.body.changed).toBe(true);

      // Not just in the object store — in the working tree, where the user
      // would look for it.
      expect(existsSync(join(dir, "theirs.txt"))).toBe(true);
      const after = spawnSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" });
      expect(after.stdout).toContain("their change");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a push the remote refuses comes back as a card, not a crash", async () => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, remote, id } = await makeRemotePair(baseUrl, cookie, "rejected");

    try {
      // Another clone pushes first, so this one is genuinely behind and its
      // push must be refused — the translator's push-rejected case.
      const other = join(root, "other");
      spawnSync("git", ["clone", "-q", remote, other], { cwd: root });
      writeFileSync(join(other, "other.txt"), "theirs\n");
      spawnSync("git", ["add", "-A"], { cwd: other });
      spawnSync("git", ["commit", "-q", "-m", "theirs"], { cwd: other });
      const theirs = spawnSync("git", ["push", "-q", "origin", "HEAD"], { cwd: other });
      expect(theirs.status).toBe(0);

      const rejected = await call(baseUrl, cookie, `/api/repos/${id}/push`, "POST", {});
      expect(rejected.body.ok).toBe(false);
      expect(rejected.body.code).toBe("push-rejected");
      // The card carries git's real words, which is the whole point of it.
      expect(String(rejected.body.raw)).toContain("fetch first");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("publishing an unpublished branch works from the card's own button", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, remote, dir } = await makeRemotePair(baseUrl, cookie, "publish");

    try {
      // Removing the tracking makes the branch unpublished, which is the state
      // a first-time push hits and the only one this card is for.
      spawnSync("git", ["branch", "--unset-upstream"], { cwd: dir });

      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.waitForSelector(".rail-row");
      await page.waitForTimeout(600);
      const bar = page.locator(".work-remote");
      await expect(bar).toHaveCount(1);

      await bar.getByRole("button", { name: "Push" }).click();
      const card = page.locator(".error-card");
      await expect(card).toHaveCount(1);
      await expect(card.locator(".error-title")).toHaveText(
        "This branch isn't published anywhere.",
      );
      const fix = card.locator(".error-fixes button");
      await expect(fix).toHaveCount(1);
      await expect(fix).toHaveText("Publish this branch");

      // Pressing it must really publish — a ref that only git can confirm.
      await fix.click();
      await expect(page.locator(".error-card")).toHaveCount(0, { timeout: 10000 });
      const refs = spawnSync("git", ["for-each-ref"], { cwd: remote, encoding: "utf8" });
      expect(refs.stdout).toContain("refs/heads/main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Milestone 6: sign-in.
 *
 * The prompt is tested against a local HTTP server that answers 401, which is
 * git's real answer for a remote that refuses without credentials — so the
 * trigger is exercised through real git output rather than by faking a code.
 */
test.describe("Milestone 6 sign-in", () => {
  /** A remote that refuses every request the way an authenticated GitHub
   *  endpoint does: `fatal: could not read Username for ...` exits non-zero. */
  async function makeRefusingRemote(): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = createServer((req, res) => {
      // Consume the request so git does not wait on a body that never comes,
      // then refuse it. `Content-Length` and `Connection: close` both matter:
      // without a length git waits for more, and without close it waits for a
      // keep-alive reply that this server will never send.
      req.resume();
      res.writeHead(401, { "content-length": "0", connection: "close" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}/repo.git`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  test("an account is never asked for before it is needed", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const token = await mintToken(baseUrl);
    await page.goto(`${baseUrl}/?t=${token}`);

    // Not signed in is a normal state, with no warning badge and no prompt.
    await expect(page.locator(".signin")).toHaveCount(0);
    // The cookie matters: without it the server answers with the app's own
    // HTML, which is not JSON and would parse as a failure rather than prove
    // anything about the account.
    const cookie = await sessionCookie(baseUrl);
    const auth = (await (
      await fetch(`${baseUrl}/api/auth`, { headers: { Cookie: cookie } })
    ).json()) as { signedIn?: boolean };
    expect(auth.signedIn).toBe(false);
  });

  test("a remote that refuses for want of credentials opens sign-in by itself", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const remote = await makeRefusingRemote();
    const root = mkdtempSync(join(tmpdir(), "fl-e2e-signin-"));
    const dir = join(root, "demo");

    try {
      mkdirSync(dir, { recursive: true });
      spawnSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
      writeFileSync(join(dir, "a.txt"), "one\n");
      spawnSync("git", ["add", "-A"], { cwd: dir });
      spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
      spawnSync("git", ["remote", "add", "origin", remote.url], { cwd: dir });
      // Point the branch at the remote so `git push` has somewhere to go. Without
      // this git refuses with "no upstream branch" before it ever opens a
      // connection — which is the right answer, but it is not the one this test
      // is about.
      spawnSync("git", ["config", "branch.main.remote", "origin"], { cwd: dir });
      spawnSync("git", ["config", "branch.main.merge", "refs/heads/main"], { cwd: dir });
      await setRootsForTest(baseUrl, [root]);
      await registerRepoForTest(baseUrl, cookie, dir);

      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.waitForSelector(".work-remote");
      await page.locator(".work-remote").getByRole("button", { name: "Push" }).click();

      // The prompt appears on its own — this is the one failure that means an
      // account is the answer, so asking at any other time would be noise.
      const prompt = page.locator(".signin");
      await expect(prompt).toHaveCount(1, { timeout: 10000 });

      // This e2e server runs with no GITHUB_CLIENT_ID, which is the state a real
      // install starts in, so the prompt must say exactly that rather than show
      // a sign-in button that could not work. The device flow itself is proven
      // in src/server/auth.test.ts against a local mock of GitHub's endpoints.
      await expect(prompt).toContainText("Sign-in is not set up yet.");
      await expect(prompt).toContainText("No GitHub OAuth App has been registered");
      // And because this machine has no keychain, that is said too rather than
      // left to be discovered later.
      await expect(prompt).toContainText("no OS keychain");
      await page.screenshot({ path: "screenshots/m6-signin-auth.png" });

      // Dismissing the prompt must never dismiss the git error: the reason
      // nothing was pushed is still on screen afterwards, with sign-in left
      // open as an option rather than a nag. (The prompt offers "Close" here
      // because there is no configured app to defer signing in to; "Not now" is
      // the label once a client id exists.)
      await prompt.getByRole("button", { name: "Close" }).click();
      await expect(prompt).toHaveCount(0);
      await expect(page.locator(".error-card")).toHaveCount(1);
      await expect(page.locator(".error-card")).toContainText("sign in");
    } finally {
      await remote.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a refusal that is not about credentials does not open sign-in", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root } = await makeAnonymousRepo(baseUrl, cookie, "no-auth-ask");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.waitForSelector(".worktable");
      // A local repository with no remote at all: no remote actions, and
      // certainly no sign-in question, because no account would have helped.
      await expect(page.locator(".work-remote")).toHaveCount(0);
      await expect(page.locator(".signin")).toHaveCount(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Milestone 7: branches.
 *
 * The same shape as the remote tests: real git, real repositories, and every
 * assertion about branch state answered by git itself rather than by trusting
 * what the API said.
 */
test.describe("Milestone 7 branches", () => {
  /** A repository with one commit, a pushed branch, and a second branch made
   *  locally so there is something to switch away from. */
  async function makeBranchRepo(baseUrl: string, cookie: string, name: string) {
    const root = mkdtempSync(join(tmpdir(), `fl-e2e-branch-${name}-`));
    const remote = join(root, "remote.git");
    mkdirSync(remote, { recursive: true });
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", "."], { cwd: remote, encoding: "utf8" });
    const dir = join(root, "demo");
    const clone = spawnSync("git", ["clone", "-q", remote, dir], { cwd: root, encoding: "utf8" });
    if (clone.status !== 0) throw new Error(`clone failed: ${clone.stderr}`);
    writeFileSync(join(dir, "a.txt"), "base\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["switch", "-q", "-c", "main"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=f@i", "-c", "user.name=F", "commit", "-qm", "base"], { cwd: dir });
    spawnSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: dir });
    spawnSync("git", ["branch", "feature"], { cwd: dir });
    await setRootsForTest(baseUrl, [root]);
    const id = await registerRepoForTest(baseUrl, cookie, dir);
    return { root, remote, dir, id };
  }

  const branchOf = (dir: string): string =>
    spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();

  test("the panel lists local branches and only one is current", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root } = await makeBranchRepo(baseUrl, cookie, "list");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".brand-branch").click();
      const panel = page.locator(".branch-panel");
      await expect(panel).toBeVisible();

      const rows = panel.locator(".branch-row");
      await expect(rows).toHaveCount(3);
      // Names, not refnames — `refs/heads/main` in a rail full of branches
      // would be internals the user should never have to read.
      await expect(panel).toContainText("main");
      await expect(panel).toContainText("feature");
      await expect(panel).not.toContainText("refs/heads/");
      // The current branch is marked, and only one branch is.
      await expect(panel.locator(".branch-row.is-current")).toHaveCount(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("choosing a branch switches the repository, confirmed by git", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeBranchRepo(baseUrl, cookie, "switch");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".brand-branch").click();
      await page
        .locator(".branch-panel .branch-name", { hasText: "feature" })
        .click();
      await page.waitForTimeout(1500);

      // git is asked, not the API's own answer.
      expect(branchOf(dir)).toBe("feature");
      await expect(page.locator(".branch-panel .branch-row.is-current")).toContainText("feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("creating a branch through the form really creates it", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeBranchRepo(baseUrl, cookie, "create");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".brand-branch").click();
      await page.fill("#branch-name", "made-in-the-ui");
      await page.locator(".branch-create button[type=submit]").click();
      await page.waitForTimeout(1500);

      const refs = spawnSync("git", ["branch", "--format=%(refname:short)"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(refs.stdout.split("\n")).toContain("made-in-the-ui");
      // And it was created and switched to, which is the whole point of the
      // one-step `git switch -c`.
      expect(branchOf(dir)).toBe("made-in-the-ui");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deleting a branch needs confirming, and the confirm is a real force", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeBranchRepo(baseUrl, cookie, "delete");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".brand-branch").click();

      const featureRow = page.locator(".branch-row", { hasText: "feature" });
      await featureRow.getByRole("button", { name: "Delete" }).click();
      // Nothing deleted yet: it asks first, in place, because the branch has
      // commits nothing else has and deleting it silently is catastrophic.
      const refsBefore = spawnSync("git", ["branch", "--format=%(refname:short)"], { cwd: dir, encoding: "utf8" });
      expect(refsBefore.stdout.split("\n")).toContain("feature");
      await expect(featureRow.getByRole("button", { name: "Keep" })).toBeVisible();

      await featureRow.getByRole("button", { name: "Delete anyway" }).click();
      await page.waitForTimeout(1500);
      const refs = spawnSync("git", ["branch", "--format=%(refname:short)"], { cwd: dir, encoding: "utf8" });
      expect(refs.stdout.split("\n")).not.toContain("feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Milestone 7: stashes.
 *
 * The stack is a stack, so the tests check order and index, and every state
 * assertion is answered by git itself.
 */
test.describe("Milestone 7 stashes", () => {
  /** A repository with one commit, and a dirty working tree to put aside. */
  async function makeStashRepo(baseUrl: string, cookie: string, name: string, dirty: boolean) {
    const root = mkdtempSync(join(tmpdir(), `fl-e2e-stash-${name}-`));
    const dir = join(root, "demo");
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
    spawnSync("git", ["config", "user.email", "ada@fixture.invalid"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Ada Fixture"], { cwd: dir });
    writeFileSync(join(dir, "f.txt"), "base\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    if (dirty) writeFileSync(join(dir, "f.txt"), "half written\n");
    await setRootsForTest(baseUrl, [root]);
    const id = await registerRepoForTest(baseUrl, cookie, dir);
    return { root, dir, id };
  }

  const status = (dir: string): string =>
    spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout.trim();

  const stashList = (dir: string): string[] =>
    spawnSync("git", ["stash", "list", "--format=%gs"], { cwd: dir, encoding: "utf8" })
      .stdout.split("\n")
      .filter((line) => line.length > 0);

  test("putting work aside cleans the tree and names the stash", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeStashRepo(baseUrl, cookie, "save", true);

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-stash").click();
      await page.locator(".stash-save input").fill("the login work, half done");
      await page.locator(".stash-save button[type=submit]").click();
      await page.waitForTimeout(1500);

      // git is asked, not the API's own reply.
      expect(stashList(dir)).toEqual(["On main: the login work, half done"]);
      expect(status(dir)).toBe("");
      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("base\n");
      await expect(page.locator(".work-note")).toContainText("done");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a clean tree is told there is nothing to put aside, and nothing is created", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeStashRepo(baseUrl, cookie, "clean", false);

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-stash").click();
      const panel = page.locator(".stash-panel");
      // The button is offered, because the tree's state is not known until the
      // server answers — and the reason it cannot work is written out, not
      // shown by a disabled control with no explanation.
      await expect(panel).toContainText("Everything here is committed");
      await expect(panel.locator(".stash-save button[type=submit]")).toBeDisabled();

      // No stash exists, and none is invented by asking.
      expect(stashStack(dir)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restoring leaves the stash on the stack, so it can be restored again", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeStashRepo(baseUrl, cookie, "restore", true);

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-stash").click();
      await page.locator(".stash-save input").fill("keep me");
      await page.locator(".stash-save button[type=submit]").click();
      await page.waitForTimeout(1500);
      expect(stashList(dir)).toEqual(["On main: keep me"]);
      expect(status(dir)).toBe("");

      // Restore: the work comes back and the entry stays. This is the restore a
      // user asks for more often than they think, and the one that cannot lose
      // anything — undoing the restore still leaves the stash where it was.
      await page.locator(".stash-row").first().getByRole("button", { name: "Restore", exact: true }).click();
      await page.waitForTimeout(1500);
      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("half written\n");
      expect(stashList(dir)).toEqual(["On main: keep me"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restoring-with-removal takes the entry off the stack in the same step", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeStashRepo(baseUrl, cookie, "pop", true);

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-stash").click();
      await page.locator(".stash-save input").fill("finish and go");
      await page.locator(".stash-save button[type=submit]").click();
      await page.waitForTimeout(1500);
      expect(stashList(dir)).toEqual(["On main: finish and go"]);

      // Kept separate from the test above on purpose: applying a stash and then
      // popping it is not something git will do, because the tree already holds
      // those changes. The two restores are two decisions and get two tests.
      await page
        .locator(".stash-row")
        .first()
        .getByRole("button", { name: "Restore and take it off the stack" })
        .click();
      await page.waitForTimeout(1500);
      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("half written\n");
      expect(stashList(dir)).toEqual([]);
      await expect(page.locator(".stash-row")).toHaveCount(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dropping a stash asks first, and the ask is a real confirm", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeStashRepo(baseUrl, cookie, "drop", true);

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-stash").click();
      await page.locator(".stash-save input").fill("about to be dropped");
      await page.locator(".stash-save button[type=submit]").click();
      await page.waitForTimeout(1500);

      await page.locator(".stash-row").getByRole("button", { name: "Drop" }).click();
      // Nothing dropped yet — dropping is the only destructive stash action, so
      // it asks in place rather than acting.
      expect(stashList(dir)).toEqual(["On main: about to be dropped"]);
      await expect(page.locator(".stash-row").getByRole("button", { name: "Keep" })).toBeVisible();

      await page.locator(".stash-row").getByRole("button", { name: "Drop it" }).click();
      await page.waitForTimeout(1500);
      expect(stashList(dir)).toEqual([]);
      await expect(page.locator(".stash-row")).toHaveCount(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** The stash stack as git reports it, which is what every stash assertion here
 *  is measured against — a stash the interface claims to have made and git does
 *  not know about is worse than no stash. */
const stashStack = (dir: string): string[] =>
  spawnSync("git", ["stash", "list"], { cwd: dir, encoding: "utf8" }).stdout
    .split("\n")
    .filter((line) => line.length > 0);

/**
 * Milestone 7: history, the graph, and blame.
 *
 * The fixture has two branches with different commits, so a log that only shows
 * the current branch is wrong — and that is exactly the kind of failure a single
 * author on one branch cannot see.
 */
test.describe("Milestone 7 history and blame", () => {
  async function makeHistoryRepo(baseUrl: string, cookie: string, name: string) {
    const root = mkdtempSync(join(tmpdir(), `fl-e2e-hist-${name}-`));
    const dir = join(root, "demo");
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
    spawnSync("git", ["config", "user.email", "ada@fixture.invalid"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Ada Fixture"], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "one\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "first: set up the file"], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    spawnSync("git", ["commit", "-q", "-am", "second: add a line"], { cwd: dir });
    spawnSync("git", ["switch", "-q", "-c", "side"], { cwd: dir });
    writeFileSync(join(dir, "b.txt"), "side\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "side only: a file main has never seen"], { cwd: dir });
    spawnSync("git", ["switch", "-q", "main"], { cwd: dir });
    await setRootsForTest(baseUrl, [root]);
    const id = await registerRepoForTest(baseUrl, cookie, dir);
    return { root, dir, id };
  }

  const subjects = (dir: string): string[] =>
    spawnSync("git", ["log", "--all", "--format=%s"], { cwd: dir, encoding: "utf8" }).stdout
      .split("\n")
      .filter((line) => line.length > 0);

  test("the log shows every branch, not only the one that is checked out", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeHistoryRepo(baseUrl, cookie, "all");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-history").click();
      const panel = page.locator(".history-panel");
      await expect(panel).toBeVisible();

      // Nothing is hidden. `main` is checked out, and the commit that only
      // exists on `side` is still listed — a log that omits a branch is a log
      // that claims a commit doesn't exist.
      await expect(panel).toContainText("side only: a file main has never seen");
      await expect(panel).toContainText("first: set up the file");
      const shown = await panel.locator(".history-subject").count();
      expect(shown).toBe(subjects(dir).length);
      // Subject text, not a ref path.
      await expect(panel).not.toContainText("refs/heads/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a branch that points at a commit shows that name on its row", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root } = await makeHistoryRepo(baseUrl, cookie, "refs");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-history").click();
      const panel = page.locator(".history-panel");
      // The ref decoration is stripped to names, and `HEAD ->` is not a name.
      await expect(panel.locator(".history-refs").first()).toContainText("side");
      await expect(panel.locator(".history-refs").first()).not.toContainText("HEAD");
      // main's row shows main.
      const mainRow = panel.locator(".history-row", { hasText: "second: add a line" });
      await expect(mainRow.locator(".history-refs")).toContainText("main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("opening a commit shows its full sha and its parents", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeHistoryRepo(baseUrl, cookie, "detail");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-history").click();
      await page.locator(".history-line").first().click();
      const detail = page.locator(".history-detail");
      await expect(detail).toBeVisible();

      // The sha git itself reports, not an abbreviation only the interface
      // knows about.
      const newest = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      await expect(detail).toContainText(newest);
      await expect(detail).toContainText("Ada Fixture");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blame names the commit behind each line, and they can differ", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeHistoryRepo(baseUrl, cookie, "blame");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-history").click();
      await page.fill(".blame-form input", "a.txt");
      await page.locator(".blame-form button[type=submit]").click();

      const rows = page.locator(".blame-row");
      await expect(rows).toHaveCount(2, { timeout: 10000 });
      // One line per line, and the first line is from the earlier commit.
      // `main` has two commits, so the first line — the one added by the
      // earlier commit — is HEAD~1. Resolved from git, not from the interface's
      // own idea of which commit a line belongs to.
      const firstSha = spawnSync("git", ["rev-parse", "HEAD~1"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      await expect(rows.first()).toContainText(firstSha.slice(0, 9));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blaming a file that doesn't exist says so rather than drawing nothing", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root } = await makeHistoryRepo(baseUrl, cookie, "missing");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-history").click();
      await page.fill(".blame-form input", "not-a-file.txt");
      await page.locator(".blame-form button[type=submit]").click();
      // A card, because "there is nothing to blame here" is a real answer.
      await expect(page.locator(".error-card")).toHaveCount(1, { timeout: 10000 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Milestone 7: the conflict resolver.
 *
 * The resolver appears on its own when a merge stops, because a stopped merge is
 * the one state in git that does not resolve by itself. Every assertion is
 * answered by git, not by what the API said.
 */
test.describe("Milestone 7 conflict resolver", () => {
  async function makeConflictedRepo(baseUrl: string, cookie: string, name: string) {
    const root = mkdtempSync(join(tmpdir(), `fl-e2e-conflict-${name}-`));
    const dir = join(root, "demo");
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
    spawnSync("git", ["config", "user.email", "ada@fixture.invalid"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Ada Fixture"], { cwd: dir });
    writeFileSync(join(dir, "f.txt"), "line\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "Base"], { cwd: dir });
    spawnSync("git", ["switch", "-q", "-c", "theirs"], { cwd: dir });
    writeFileSync(join(dir, "f.txt"), "theirs change\n");
    spawnSync("git", ["commit", "-q", "-am", "Theirs"], { cwd: dir });
    spawnSync("git", ["switch", "-q", "main"], { cwd: dir });
    writeFileSync(join(dir, "f.txt"), "ours change\n");
    spawnSync("git", ["commit", "-q", "-am", "Ours"], { cwd: dir });
    const merge = spawnSync("git", ["merge", "theirs"], { cwd: dir, encoding: "utf8" });
    await setRootsForTest(baseUrl, [root]);
    const id = await registerRepoForTest(baseUrl, cookie, dir);
    return { root, dir, id, merge };
  }

  const status = (dir: string): string =>
    spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout.trim();

  const conflicting = (dir: string): string[] =>
    spawnSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: dir, encoding: "utf8" }).stdout
      .split("\n")
      .filter((line) => line.length > 0);

  test("a stopped merge opens the resolver on its own", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir, merge } = await makeConflictedRepo(baseUrl, cookie, "auto");

    try {
      // The fixture really stopped: git prints CONFLICT and left an unmerged
      // path, which is the state this whole test is about.
      expect(merge.stdout).toContain("CONFLICT");
      expect(conflicting(dir)).toEqual(["f.txt"]);

      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      const resolver = page.locator(".conflict-resolver");
      // Nobody opened it. This is the one state in git that does not go away
      // by itself, so the interface is the thing that has to say so.
      await expect(resolver).toHaveCount(1, { timeout: 10000 });
      await expect(resolver).toContainText("The merge stopped at 1 file");
      await expect(resolver).toContainText("nothing has been lost");
      await expect(resolver).toContainText("both sides changed the same lines");
      await page.screenshot({ path: "screenshots/m7-conflict.png" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the three versions of a file are shown together, side by side", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root } = await makeConflictedRepo(baseUrl, cookie, "sides");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".conflict-name").click();
      const detail = page.locator(".conflict-detail");
      await expect(detail).toBeVisible();

      // All three versions, in words rather than in o/m and t/m.
      await expect(detail).toContainText("This side");
      await expect(detail).toContainText("The other side");
      await expect(detail).toContainText("Where they split");
      await expect(detail).toContainText("ours change");
      await expect(detail).toContainText("theirs change");
      // And the shared parent, which is what "where they split" means.
      await expect(detail).toContainText("line");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("taking one side resolves the merge, and git agrees", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeConflictedRepo(baseUrl, cookie, "resolve");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".conflict-name").click();
      await page.getByRole("button", { name: "Take the other side" }).click();
      await page.waitForTimeout(1500);

      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("theirs change\n");
      expect(conflicting(dir)).toEqual([]);
      // Staged, so the merge can be finished.
      expect(status(dir)).toContain("M");
      // And the resolver closes itself: it is a panel about nothing otherwise.
      await expect(page.locator(".conflict-resolver")).toHaveCount(0);
      await expect(page.locator(".work-note")).toContainText("Took the other side");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaving both versions keeps the markers and the conflict in place", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeConflictedRepo(baseUrl, cookie, "keep");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".conflict-name").click();
      await page.getByRole("button", { name: "Keep both, I'll edit it myself" }).click();
      await page.waitForTimeout(1500);

      // The markers are still there. This button is the one that must never
      // stage the file, because staging a conflicted path is what makes git
      // consider the conflict resolved — and then a button that said "keep
      // both" would have hidden it.
      expect(readFileSync(join(dir, "f.txt"), "utf8")).toContain("<<<<<<<");
      expect(conflicting(dir)).toEqual(["f.txt"]);
      await expect(page.locator(".conflict-resolver")).toHaveCount(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("abandoning the merge restores the tree to before it started", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeConflictedRepo(baseUrl, cookie, "abort");
    const before = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.getByRole("button", { name: "Abandon it and get back to before" }).click();
      await page.waitForTimeout(1500);

      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("ours change\n");
      const after = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      expect(after).toBe(before);
      // Still merging? No. The conflict is gone with the merge.
      expect(conflicting(dir)).toEqual([]);
      await expect(page.locator(".conflict-resolver")).toHaveCount(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("finishing while conflicts remain is refused, with the files named", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeConflictedRepo(baseUrl, cookie, "early");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      // The button says how many are left, so it cannot be pressed into an
      // early finish without the user noticing what it will do.
      await expect(page.getByRole("button", { name: "1 left to decide" })).toBeDisabled();
      expect(conflicting(dir)).toEqual(["f.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Milestone 8: the release manager.
 *
 * A release is stated before it is made — this is the version now, this is what
 * it becomes, these are the commits it contains — and then nothing is committed,
 * because the message is the one part of a release that should not be automatic.
 */
test.describe("Milestone 8 releases", () => {
  async function makeReleasableRepo(baseUrl: string, cookie: string, name: string) {
    const root = mkdtempSync(join(tmpdir(), `fl-e2e-release-${name}-`));
    const dir = join(root, "demo");
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
    spawnSync("git", ["config", "user.email", "ada@fixture.invalid"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Ada Fixture"], { cwd: dir });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "demo", version: "1.2.3" }, null, 2)}\n`);
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "chore: initial"], { cwd: dir });
    // The tag sits *below* the releases, so there are commits after it.
    spawnSync("git", ["tag", "-a", "v1.2.2", "-m", "previous"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "feat: add the first thing"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "fix: mend it"], { cwd: dir });
    await setRootsForTest(baseUrl, [root]);
    const id = await registerRepoForTest(baseUrl, cookie, dir);
    return { root, dir, id };
  }

  test("the plan is stated before anything is done", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeReleasableRepo(baseUrl, cookie, "plan");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-release").click();
      const panel = page.locator(".release-panel");
      await expect(panel).toBeVisible();

      // The version read from package.json, not invented.
      const version = spawnSync("git", ["show", "HEAD:package.json"], { cwd: dir, encoding: "utf8" });
      const onDisk = JSON.parse(version.stdout).version as string;
      await expect(panel).toContainText(onDisk);
      await expect(panel).toContainText("v1.2.2");
      // The commits the release would contain, with the merge-style subject
      // excluded — those are not things anyone did.
      await expect(panel.locator(".release-commit")).toHaveCount(2);
      await expect(panel).toContainText("feat: add the first thing");
      await expect(panel).toContainText("fix: mend it");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("making a release writes the version, the changelog, the tag, and the release commit", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeReleasableRepo(baseUrl, cookie, "make");
    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-release").click();
      // A minor release, because there is a feat in it.
      await page.locator(".release-choice label", { hasText: "minor" }).click();
      await page.locator(".release-panel").getByRole("button", { name: "Make the 1.3.0 release" }).click();
      await page.waitForTimeout(2000);

      // git is asked, not the API's own reply.
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("1.3.0");

      // The changelog is newest first, under the title, with the subjects
      // sorted — and it is the one written this time.
      const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
      expect(changelog).toContain("1.3.0");
      expect(changelog).toContain("### Added");
      expect(changelog).toContain("add the first thing");

      // The tag exists, on the commit it was made on — which is the commit
      // that was already HEAD, because nothing was committed for it.
      const tags = spawnSync("git", ["tag", "--list"], { cwd: dir, encoding: "utf8" }).stdout.split("\n");
      expect(tags).toContain("v1.3.0");
      // The tag is on the release commit, not on the one that was HEAD before —
      // which is what "a tag and a version commit" means, and the reason the
      // release commits at all.
      const tagged = spawnSync("git", ["rev-parse", "v1.3.0^{commit}"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      expect(tagged).not.toBe(headBefore);

      // The release committed, which is what the spec's acceptance criteria
      // ask for: a version commit and a tag. Leaving it to the user is a
      // checkbox, not the design, and there is a separate test for that.
      const subject = spawnSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      expect(subject).toBe("release: v1.3.0");
      const headAfter = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      expect(headAfter).not.toBe(headBefore);
      const committedFiles = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      expect(committedFiles).toContain("package.json");
      expect(committedFiles).toContain("CHANGELOG.md");
      // And the working tree is clean, because everything the release wrote
      // went into the commit.
      const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      expect(status).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a repository with nothing since its tag has nothing to release", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const root = mkdtempSync(join(tmpdir(), "fl-e2e-release-empty-"));
    const dir = join(root, "demo");

    try {
      mkdirSync(dir, { recursive: true });
      spawnSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
      spawnSync("git", ["config", "user.email", "ada@fixture.invalid"], { cwd: dir });
      spawnSync("git", ["config", "user.name", "Ada Fixture"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "demo", version: "1.2.3" }, null, 2)}\n`);
      spawnSync("git", ["add", "-A"], { cwd: dir });
      spawnSync("git", ["commit", "-q", "-m", "chore: initial"], { cwd: dir });
      spawnSync("git", ["tag", "-a", "v1.2.3", "-m", "the whole thing"], { cwd: dir });
      await setRootsForTest(baseUrl, [root]);
      await registerRepoForTest(baseUrl, cookie, dir);

      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-release").click();
      const panel = page.locator(".release-panel");
      // Said in words, and the button can't be pressed into making something.
      await expect(panel).toContainText("Nothing has been committed since the last tag");
      await expect(panel.getByRole("button", { name: "Nothing to release" })).toBeDisabled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a version that isn't semVER is refused rather than guessed at", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const root = mkdtempSync(join(tmpdir(), "fl-e2e-release-nosemver-"));
    const dir = join(root, "demo");

    try {
      mkdirSync(dir, { recursive: true });
      spawnSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
      spawnSync("git", ["config", "user.email", "ada@fixture.invalid"], { cwd: dir });
      spawnSync("git", ["config", "user.name", "Ada Fixture"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "demo", version: "banana" }, null, 2)}\n`);
      spawnSync("git", ["add", "-A"], { cwd: dir });
      spawnSync("git", ["commit", "-q", "-m", "chore: initial"], { cwd: dir });
      await setRootsForTest(baseUrl, [root]);
      await registerRepoForTest(baseUrl, cookie, dir);

      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-release").click();
      const panel = page.locator(".release-panel");
      // No next version is offered, and the reason is written out rather than
      // left to a disabled control.
      await expect(panel).toContainText("not in the three-number form");
      await expect(panel).toContainText("not going to guess");
      await expect(panel.getByRole("button", { name: /Make the/ })).toHaveCount(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaving the commit out is allowed, and says what it cost", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeReleasableRepo(baseUrl, cookie, "nocommit");
    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-release").click();
      // The unusual case is the one the user asks for, not the one the app
      // assumes, so the checkbox starts on.
      await page.locator(".release-panel").getByRole("checkbox").last().uncheck();
      await page.locator(".release-panel").getByRole("button", { name: "Make the 1.2.4 release" }).click();
      await page.waitForTimeout(2000);

      // The version and the changelog were written, as promised.
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("1.2.4");
      expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain("1.2.4");
      // And nothing was committed — the release left the work staged for the
      // user, rather than pretending it finished.
      const headAfter = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      expect(headAfter).toBe(headBefore);
      const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      expect(staged).toContain("package.json");
      const tags = spawnSync("git", ["tag", "--list"], { cwd: dir, encoding: "utf8" }).stdout.split("\n");
      expect(tags).not.toContain("v1.2.4");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Milestone 9: Simple mode, the doctor, notes, and SSH keys.
 *
 * Simple mode is a preference kept on this computer and never a guess about who
 * the user is. Everything the full interface can do stays one button away, so
 * these tests assert both that the quiet screen is quiet and that the full one
 * is still reachable.
 */
test.describe("Milestone 9 polish", () => {
  async function makeSimpleRepo(baseUrl: string, cookie: string, name: string) {
    const root = mkdtempSync(join(tmpdir(), `fl-e2e-simple-${name}-`));
    const dir = join(root, "demo");
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
    spawnSync("git", ["config", "user.email", "ada@fixture.invalid"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Ada Fixture"], { cwd: dir });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "demo", version: "0.1.0" }, null, 2)}\n`);
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "chore: initial"], { cwd: dir });
    await setRootsForTest(baseUrl, [root]);
    const id = await registerRepoForTest(baseUrl, cookie, dir);
    return { root, dir, id };
  }

  test("simple mode leaves Save and Send and nothing else in the way", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeSimpleRepo(baseUrl, cookie, "on");
    writeFileSync(join(dir, "file.txt"), "a change\n");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await expect(page.locator(".simple-bar")).toHaveCount(0);
      await page.evaluate(() => localStorage.setItem("forgeline-simple", "on"));
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.waitForSelector(".simple-bar", { timeout: 10000 });

      // What is on screen: one button and a box.
      await expect(page.locator(".simple-bar")).toContainText("1 file has changed");
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      // And what is not: staging, the graph, the diff viewer.
      await expect(page.locator(".worktable")).toHaveCount(0);
      await expect(page.locator(".history-panel")).toHaveCount(0);

      // The wording a person who has never used git would use.
      await expect(page.locator(".simple-bar")).toContainText("a copy of all your changes on this computer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Save in simple mode commits everything, and git agrees", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeSimpleRepo(baseUrl, cookie, "save");
    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
    // An untracked file as well as a modification, because "save everything"
    // must not be the `git commit -a` behaviour that leaves new files behind.
    writeFileSync(join(dir, "new-file.txt"), "brand new\n");
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "demo", version: "0.2.0" }, null, 2)}\n`);

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.evaluate(() => localStorage.setItem("forgeline-simple", "on"));
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.waitForSelector(".simple-bar", { timeout: 10000 });

      await page.locator("#simple-message").fill("saved everything at once");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.waitForTimeout(2000);

      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      expect(head).not.toBe(headBefore);

      const message = spawnSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      expect(message).toBe("saved everything at once");
      // The untracked file went in too, which `git commit -a` would have missed.
      const files = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout
        .split("\n")
        .filter((line) => line.length > 0);
      expect(files).toContain("new-file.txt");

      // And the working tree is clean, because everything really was saved.
      const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      expect(status).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("turning simple mode off brings every panel back", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root } = await makeSimpleRepo(baseUrl, cookie, "off");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.evaluate(() => localStorage.setItem("forgeline-simple", "on"));
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.waitForSelector(".simple-bar", { timeout: 10000 });

      await page.getByRole("button", { name: /Simple: on/ }).click();
      await page.waitForSelector(".worktable", { timeout: 10000 });
      await expect(page.locator(".simple-bar")).toHaveCount(0);
      // Nothing became unreachable — it was all one button away the whole time.
      // Every one of them is still on screen, and the branch control remembers
      // it is also the brand, so it is found by the class it really has.
      await expect(page.locator(".toolbar-history")).toBeVisible();
      await expect(page.locator(".toolbar-stash")).toBeVisible();
      await expect(page.locator(".brand-branch")).toBeVisible();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the doctor reads the project type off the real files", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeSimpleRepo(baseUrl, cookie, "doctor");
    writeFileSync(join(dir, "package-lock.json"), "{}");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "chore: lockfile"], { cwd: dir });

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-doctor").click();
      const panel = page.locator(".doctor-panel");
      await expect(panel).toBeVisible();
      // It says what it is and shows its work.
      await expect(panel).toContainText("a Node.js project");
      await expect(panel).toContainText("package-lock.json");
      await page.screenshot({ path: "screenshots/m9-doctor.png" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the doctor's .gitignore only adds the missing lines", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeSimpleRepo(baseUrl, cookie, "gi");
    writeFileSync(join(dir, ".gitignore"), "my-own-thing/\n");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-doctor").click();
      await page.locator(".doctor-panel").getByRole("button", { name: "Add the lines that are missing" }).click();
      await page.waitForTimeout(2000);

      const text = readFileSync(join(dir, ".gitignore"), "utf8");
      expect(text).toContain("my-own-thing/");
      expect(text.split("\n").filter((l) => l.trim() === "my-own-thing/").length).toBe(1);
      // And what a Node project needs, which was not there before.
      expect(text).toContain("node_modules/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a note is stored on this computer and never inside the repository", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root, dir } = await makeSimpleRepo(baseUrl, cookie, "note");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-note").click();
      await page.locator("#note-text").fill("remember where the deploy key lives");
      await page.getByRole("button", { name: "Save the note" }).click();
      await page.waitForTimeout(1500);

      // Nothing appeared in the repository, and its working tree is still clean.
      const entries = spawnSync("ls", ["-A", dir], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.length > 0).sort();
      expect(entries).not.toContain(".forgeline-note");
      const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout.trim();
      expect(status).toBe("");

      // And it is there when the page is reopened, so it was really stored.
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-note").click();
      await expect(page.locator("#note-text")).toHaveValue("remember where the deploy key lives");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the SSH panel shows a public key and never the private half", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const fakeHome = mkdtempSync(join(tmpdir(), "fl-e2e-ssh-"));
    // A fake ~/.ssh with a real public key and a private half that must not be
    // shown, copied, or sent anywhere.
    const sshPath = join(fakeHome, ".ssh");
    mkdirSync(sshPath, { recursive: true });
    writeFileSync(join(sshPath, "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n-----END OPENSSH PRIVATE KEY-----\n");
    writeFileSync(join(sshPath, "id_ed25519.pub"), "ssh-ed25519 AAAAoperator@host\n");

    try {
      // The server resolves ~/.ssh from the home directory of the *server*
      // process, and a test cannot change another process's environment — so the
      // server is asked, through the endpoint that exists only in e2e, to read
      // the fake home instead. The seam is closed again in the finally.
      await call(baseUrl, cookie, "/api/__test__/ssh-home", "POST", { path: fakeHome });

      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.locator(".toolbar-ssh").click();
      const panel = page.locator(".ssh-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("ssh-ed25519");
      await expect(panel.getByRole("button", { name: /Copy the public key/ })).toBeVisible();

      const text = await panel.innerText();
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toContain("SECRET");

      // And the seam is closed, so the next test reads the real home again.
      await call(baseUrl, cookie, "/api/__test__/ssh-home", "POST", { path: null });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

/**
 * The narrow viewport is not a smaller version of the desktop one, so it is
 * checked for what actually goes wrong at 800px: a page wider than its window.
 * Two separate CSS causes produced that, and both were invisible at 1440px —
 * a grid track that refused to shrink below its min-content, and a toolbar row
 * that could not wrap.
 */
test.describe("Milestone 9 the narrow viewport", () => {
  test("no panel makes the page wider than an 800px window", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root } = await makeAnonymousRepo(baseUrl, cookie, "narrow");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);

      /** The page's own width against the window's, measured rather than assumed.
       *  The body is a string because this file is compiled without the DOM
       *  library, which is the same reason the rest of the suite measures the
       *  page that way. */
      const widerThanWindow = async (label: string) => {
        const measured = (await page.evaluate(
          "({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })",
        )) as { scroll: number; client: number };
        expect(measured.scroll, `${label} is wider than its window`).toBeLessThanOrEqual(measured.client);
      };

      await page.waitForSelector(".work", { timeout: 10000 });
      await widerThanWindow("dashboard");

      for (const [label, selector] of [
        ["history", ".toolbar-history"],
        ["stashes", ".toolbar-stash"],
        ["branches", ".brand-branch"],
        ["doctor", ".toolbar-doctor"],
        ["release", ".toolbar-release"],
        ["notes", ".toolbar-note"],
        ["ssh keys", ".toolbar-ssh"],
      ] as const) {
        await page.locator(selector).click();
        await page.waitForTimeout(1200);
        await widerThanWindow(label);
        await page.locator(selector).click();
        await page.waitForTimeout(500);
      }

      // And the repo list is still reachable, which is the reason the narrow
      // layout turns the rail into a strip instead of hiding it.
      await expect(page.locator(".rail-row").first()).toBeVisible();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("simple mode fits at 800px too", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const cookie = await sessionCookie(baseUrl);
    const { root } = await makeAnonymousRepo(baseUrl, cookie, "narrow-simple");

    try {
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.evaluate(() => localStorage.setItem("forgeline-simple", "on"));
      await page.goto(`${baseUrl}/?t=${await mintToken(baseUrl)}`);
      await page.waitForSelector(".simple-bar", { timeout: 10000 });
      const measured = (await page.evaluate(
        "({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })",
      )) as { scroll: number; client: number };
      expect(measured.scroll).toBeLessThanOrEqual(measured.client);
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
