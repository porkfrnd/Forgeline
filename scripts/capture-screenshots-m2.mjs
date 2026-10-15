// Captures Milestone 2 screenshots: the dashboard with real repos listed.
// Usage: npm run build && node scripts/capture-screenshots-m2.mjs
//
// Unlike the Milestone 1 script this one has to put repos on screen, so it
// builds three throwaway git repos in a temp folder, scans them through the
// real API, and screenshots the result. The server is started with
// FORGELINE_E2E=1 only so the test-only bootstrap endpoint can mint a token
// for each exchange; nothing else about the run is special.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "screenshots", "milestone-2");
mkdirSync(OUT, { recursive: true });

const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
};

/** Three repos with visibly different states, so the status line earns its
 *  place in the screenshot: clean, uncommitted work, and an unpushed commit. */
function makeRepos() {
  const root = mkdtempSync(join(tmpdir(), "fl-shot-"));
  const make = (name) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "demo@example.com"]);
    git(dir, ["config", "user.name", "Demo"]);
    writeFileSync(join(dir, "README.md"), `# ${name}\n`);
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-m", "Initial commit"]);
    return dir;
  };
  const calm = make("calm-notes");
  const busy = make("busy-side-project");
  writeFileSync(join(busy, "notes.md"), "draft ideas\n");
  git(busy, ["add", "notes.md"]);
  writeFileSync(join(busy, "scratch.txt"), "not staged yet\n");
  const pushed = make("website-rebuild");
  writeFileSync(join(pushed, "index.html"), "<h1>hello</h1>\n");
  git(pushed, ["add", "index.html"]);
  git(pushed, ["commit", "-m", "Add landing page"]);
  return { root, repos: [calm, busy, pushed] };
}

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

async function mintToken(base) {
  const res = await fetch(`${base}/api/__test__/bootstrap`);
  const { token } = await res.json();
  return token;
}

/** Exchange a bootstrap token for a `session=...` cookie value. */
async function sessionCookie(base) {
  const res = await fetch(`${base}/?t=${await mintToken(base)}`, { redirect: "manual" });
  const m = (res.headers.get("set-cookie") ?? "").match(/session=([^;]*)/);
  await res.arrayBuffer();
  if (!m) throw new Error("no session cookie set");
  return `session=${m[1]}`;
}

const { root } = makeRepos();
const server = spawn("node", ["dist/cli.js", "--no-open"], {
  cwd: ROOT,
  env: { ...process.env, FORGELINE_E2E: "1" },
});
const problems = [];

try {
  const url = await waitForUrl(server);
  const base = `http://127.0.0.1:${new URL(url).port}`;
  const cookie = await sessionCookie(base);

  const scan = await fetch(`${base}/api/repos/scan`, {
    method: "POST",
    headers: { cookie, origin: `${base}`, "content-type": "application/json" },
    body: JSON.stringify({ roots: [root] }),
  });
  const { repos: listed } = await scan.json();
  console.log(`scanned ${listed.length} repos from ${root}`);

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
      // Each page load needs its own token: they are single-use.
      await page.goto(`${base}/?t=${await mintToken(base)}`);
      if (theme === "midnight") {
        await page.getByRole("button", { name: /switch to .* theme/i }).click();
      }
      await page.locator(".repo-item").first().waitFor({ state: "visible" });
      await page.screenshot({ path: join(OUT, `dashboard-${theme}-${name}.png`) });
    }
    await context.close();
  }
  await browser.close();
  console.log(problems.length === 0 ? "No console errors or failed requests." : problems.join("\n"));
} finally {
  server.kill();
  rmSync(root, { recursive: true, force: true });
}
