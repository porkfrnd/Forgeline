import { chromium } from "@playwright/test";
const BASE = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
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
const check = async (label) => {
  const r = await page.evaluate(() => {
    const de = document.documentElement;
    const wide = [...document.querySelectorAll("*")]
      .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className.toString().split(" ")[0]}`);
    return { scrollW: de.scrollWidth, clientW: de.clientWidth, wide: [...new Set(wide)].slice(0, 4) };
  });
  console.log(`${label}: scroll ${r.scrollW} / client ${r.clientW} ${r.scrollW > r.clientW ? "OVERFLOW " + JSON.stringify(r.wide) : "ok"}`);
};
await check("dashboard");
for (const [label, sel] of [["history", ".toolbar-history"], ["stash", ".toolbar-stash"], ["branches", ".brand-branch"], ["doctor", ".toolbar-doctor"], ["release", ".toolbar-release"], ["note", ".toolbar-note"], ["ssh", ".toolbar-ssh"]]) {
  await page.locator(sel).click();
  await page.waitForTimeout(1800);
  await check(label);
  await page.locator(sel).click();
  await page.waitForTimeout(600);
}
await browser.close();
