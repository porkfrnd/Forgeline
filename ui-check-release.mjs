import { chromium } from "@playwright/test";
const BASE = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
const minted = await (await fetch(`${BASE}/api/__test__/bootstrap`)).json();
await page.goto(`${BASE}/?t=${minted.token}`);
const cookie = (await page.context().cookies()).find((c) => c.name === "session")?.value;
await page.evaluate(async ([base, c]) => {
  await fetch(`${base}/api/__test__/roots`, { method: "POST", headers: { "content-type": "application/json", Cookie: `session=${c}` }, body: JSON.stringify({ paths: ["/tmp/fl-rl"] }) });
  await fetch(`${base}/api/__test__/register-repo`, { method: "POST", headers: { "content-type": "application/json", Cookie: `session=${c}` }, body: JSON.stringify({ path: "/tmp/fl-rl/demo" }) });
}, [BASE, cookie]);
await page.goto(BASE);
await page.waitForSelector(".work", { timeout: 10000 });
await page.waitForTimeout(1500);
await page.locator(".toolbar-release").click();
const panel = page.locator(".release-panel");
console.log("panel:", await panel.count());
console.log("plan:", (await panel.locator(".release-plan").innerText()).replace(/\n/g, " | "));
console.log("commits:", await panel.locator(".release-commit").count(), await (await panel.locator(".release-commit-list").innerText()).replace(/\n/g," | "));
await page.screenshot({ path: "screenshots/m8-release.png", fullPage: true });

// Commit the release, then check git.
await page.locator(".release-choice label", { hasText: "minor" }).click();
await panel.getByRole("button", { name: /Make the 1\.3\.0 release/ }).click();
await page.waitForTimeout(2000);
console.log("note:", await page.locator(".work-note").count() ? (await page.locator(".work-note").innerText()) : "(none)");
await browser.close();
