import { chromium } from "@playwright/test";
const BASE = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const minted = await (await fetch(`${BASE}/api/__test__/bootstrap`)).json();
await page.goto(`${BASE}/?t=${minted.token}`);
const cookie = (await page.context().cookies()).find((c) => c.name === "session")?.value;
await page.evaluate(async ([base, c]) => {
  await fetch(`${base}/api/__test__/roots`, { method: "POST", headers: { "content-type": "application/json", Cookie: `session=${c}` }, body: JSON.stringify({ paths: ["/tmp/fl-fin"] }) });
  await fetch(`${base}/api/__test__/register-repo`, { method: "POST", headers: { "content-type": "application/json", Cookie: `session=${c}` }, body: JSON.stringify({ path: "/tmp/fl-fin/demo" }) });
}, [BASE, cookie]);
await page.goto(BASE);
await page.waitForSelector(".work", { timeout: 15000 });
await page.waitForTimeout(2000);
const show = async (label, sel, action) => {
  if (action) await page.locator(action).click();
  await page.waitForTimeout(2200);
  const el = page.locator(sel);
  if (await el.count() === 0) { console.log(`--- ${label}: MISSING`); return; }
  const t = (await el.first().innerText()).replace(/\n+/g, " | ").slice(0, 250);
  console.log(`--- ${label}: ${t}`);
};
console.log("### toolbar buttons:");
console.log((await page.locator(".toolbar").innerText()).replace(/\n+/g, " "));
await show("rail", ".rail");
await show("changes", ".worktable");
await show("history", ".history-panel", ".toolbar-history");
await show("stash", ".stash-panel", ".toolbar-stash");
await show("branches", ".branch-panel", ".brand-branch");
await show("doctor", ".doctor-panel", ".toolbar-doctor");
await show("release", ".release-panel", ".toolbar-release");
await show("note", ".note-panel", ".toolbar-note");
await show("ssh", ".ssh-panel", ".toolbar-ssh");
await show("statusbar", ".statusbar");
await browser.close();
