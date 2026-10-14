// Captures Milestone 1 screenshots and reports console errors / failed requests.
// Usage: node scripts/capture-screenshots.mjs   (expects `npm run build` already done)
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "screenshots", "milestone-1");
mkdirSync(OUT, { recursive: true });

function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 30000);
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/Forgeline is running at (http:\/\/localhost:\d+\/\?t=\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
}

const server = spawn("node", ["dist/cli.js", "--no-open"], { cwd: ROOT });
const problems = [];

try {
  const url = await waitForUrl(server);
  const parsed = new URL(url);
  const base = `http://127.0.0.1:${parsed.port}`;
  const token = parsed.searchParams.get("t");

  const browser = await chromium.launch();
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["narrow", { width: 800, height: 900 }],
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") problems.push(`[${name}] console.error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => problems.push(`[${name}] pageerror: ${err.message}`));
    page.on("requestfailed", (req) =>
      problems.push(`[${name}] requestfailed: ${req.url()} ${req.failure()?.errorText ?? ""}`),
    );

    for (const theme of ["paper", "midnight"]) {
      await page.goto(`${base}/?t=${token}`);
      // Initial theme is paper. Click the real toggle so React state and the
      // button label stay in sync (honest screenshot of the shipped control).
      if (theme === "midnight") {
        await page.getByRole("button", { name: /switch to .* theme/i }).click();
      }
      await page.waitForTimeout(150);
      await page.screenshot({ path: join(OUT, `dashboard-${theme}-${name}.png`), fullPage: true });
    }
    await context.close();
  }
  await browser.close();

  server.kill("SIGTERM");

  if (problems.length > 0) {
    writeFileSync(join(OUT, "console-errors.txt"), problems.join("\n") + "\n", "utf8");
    console.error("PROBLEMS FOUND:\n" + problems.join("\n"));
    process.exit(1);
  } else {
    console.log("Screenshots captured. No console errors or failed requests.");
  }
} catch (err) {
  server.kill("SIGTERM");
  console.error(err);
  process.exit(1);
}
