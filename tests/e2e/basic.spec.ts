import { test, expect } from "@playwright/test";
import { serverInfo } from "./helpers.js";

test.describe("Forgeline skeleton", () => {
  test("dashboard loads, token is exchanged for a session cookie and removed from the URL", async ({
    page,
  }) => {
    const { baseUrl, token } = serverInfo();
    await page.goto(`${baseUrl}/?t=${token}`);

    // Token must be stripped from the address bar after the exchange.
    await expect(page).toHaveURL(new RegExp(`^${baseUrl}/$`));

    await expect(page.getByText("Forgeline").first()).toBeVisible();
    await expect(page.getByText("No folders scanned yet.")).toBeVisible();

    // The session cookie must be HttpOnly and SameSite=Strict.
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "session");
    expect(session).toBeTruthy();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Strict");
  });

  test("theme toggles between paper and midnight", async ({ page }) => {
    const { baseUrl, token } = serverInfo();
    await page.goto(`${baseUrl}/?t=${token}`);
    const toggle = page.getByRole("button", { name: /switch to .* theme/i });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  });

  test("health endpoint requires the session cookie", async ({ request }) => {
    const { baseUrl } = serverInfo();
    const res = await request.get(`${baseUrl}/api/health`);
    expect(res.status()).toBe(401);
  });

  test("health endpoint succeeds with the session cookie", async ({ request }) => {
    const { baseUrl, token } = serverInfo();
    const res = await request.get(`${baseUrl}/api/health`, {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("requests with a bad Host header are rejected", async ({ request }) => {
    const { baseUrl, token } = serverInfo();
    const res = await request.get(`${baseUrl}/api/health`, {
      headers: { cookie: `session=${token}`, host: "evil.example.com" },
    });
    expect(res.status()).toBe(403);
  });
});
