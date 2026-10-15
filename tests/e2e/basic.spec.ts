import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverInfo, mintToken, expireTokenForTest, sessionCookie, setRootsForTest, registerRepoForTest } from "./helpers.js";

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

  test("theme toggles between paper and midnight", async ({ page }) => {
    const { baseUrl } = serverInfo();
    const token = await mintToken(baseUrl);
    await page.goto(`${baseUrl}/?t=${token}`);
    const toggle = page.getByRole("button", { name: /switch to .* theme/i });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
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
    expect(await res.json()).toEqual({ ok: true });
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

