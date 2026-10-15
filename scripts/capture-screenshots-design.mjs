// Captures screenshots of the Workbench design across themes.
// Usage: npm run build && node scripts/capture-screenshots-design.mjs
//
// Builds three throwaway repos with genuinely different states, scans them
// through the real API, then screenshots each theme. Themes are applied by
// seeding localStorage before the app boots, which is the same code path the
// appearance panel uses.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "screenshots", "design");
mkdirSync(OUT, { recursive: true });

const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
};

/** Three repos with visibly different states, so the status line and the
 *  counters have something real to show. */
function makeRepos() {
  const root = mkdtempSync(join(tmpdir(), "fl-shot-"));
  const make = (name, files) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "ada@fixture.invalid"]);
    git(dir, ["config", "user.name", "Ada Fixture"]);
    for (const [file, body] of files) {
      mkdirSync(join(dir, dirname(file)), { recursive: true });
      writeFileSync(join(dir, file), body);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "Base"]);
    return dir;
  };

  // Quiet: nothing changed.
  const calm = make("calm-notes", [["README.md", "# Calm notes\n"], ["notes.md", "a line\n"]]);

  // Busy: staged plus further unstaged edits, which is the case that has to
  // stay straight in the worktable.
  const busy = make("busy-side-project", [
    ["README.md", "# Side project\n"],
    ["src/app.ts", "export const one = 1;\nexport const two = 2;\nexport const three = 3;\n"],
  ]);
  writeFileSync(join(busy, "src", "app.ts"), "export const one = 1;\nexport const TWO = 2;\nexport const three = 3;\n");
  git(busy, ["add", "src/app.ts"]);
  writeFileSync(join(busy, "src", "app.ts"), "export const one = 1;\nexport const TWO = 2;\nexport const three = 3;\nexport const four = 4;\n");
  writeFileSync(join(busy, "draft.md"), "not staged yet\n");

  // Ahead: one unpushed commit.
  const ahead = make("website-rebuild", [
    ["index.html", "<h1>hello</h1>\n"],
    ["styles.css", "body { color: #333; }\n"],
  ]);
  writeFileSync(join(ahead, "index.html"), "<h1>hello again</h1>\n");
  git(ahead, ["add", "index.html"]);
  git(ahead, ["commit", "-m", "Add landing page"]);

  return { root, repos: [calm, busy, ahead] };
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
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });
}

async function mintToken(base) {
  const res = await fetch(`${base}/api/__test__/bootstrap`);
  const { token } = await res.json();
  return token;
}

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

/** Appearance as the panel would write it. */
const appearance = (patch) =>
  JSON.stringify({
    family: "lagoon",
    mode: "dark",
    surface: "glass",
    effects: "full",
    density: "cozy",
    ...patch,
  });

const SHOTS = [
  ["lagoon-dark-desktop", appearance({}), { width: 1440, height: 900 }],
  ["cathode-dark-desktop", appearance({ family: "cathode" }), { width: 1440, height: 900 }],
  ["paper-light-desktop", appearance({ family: "paper", mode: "light" }), { width: 1440, height: 900 }],
  ["mono-dark-solid", appearance({ family: "mono", surface: "solid" }), { width: 1440, height: 900 }],
  ["lagoon-dark-narrow", appearance({}), { width: 800, height: 900 }],
  ["lagoon-effects-off", appearance({ effects: "off" }), { width: 1440, height: 900 }],
  ["nord-dark-desktop", appearance({ family: "nord" }), { width: 1440, height: 900 }],
];

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
  console.log(`scanned ${listed.length} repos`);

  const browser = await chromium.launch();
  const problemsSeen = [];

  for (const [name, stored, viewport] of SHOTS) {
    const context = await browser.newContext({ viewport });
    // Seed the appearance before any of the app's code runs.
    await context.addInitScript((value) => {
      window.localStorage.setItem("forgeline-appearance", value);
    }, stored);

    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") problemsSeen.push(`[${name}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => problemsSeen.push(`[${name}] ${err.message}`));

    await page.goto(`${base}/?t=${await mintToken(base)}`);
    await page.locator(".rail-row").first().waitFor({ state: "visible", timeout: 15000 });
    // Select the busy repo so the worktable shows a real changed count.
    await page.getByRole("button", { name: /busy-side-project/ }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    await context.close();
  }

  await browser.close();
  problems.push(...problemsSeen);
  console.log(problems.length === 0 ? "No console errors or failed requests." : problems.join("\n"));
} finally {
  server.kill();
  rmSync(root, { recursive: true, force: true });
}
