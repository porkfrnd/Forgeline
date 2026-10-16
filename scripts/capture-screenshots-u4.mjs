// Captures the Update 4, section 7 set: nine states across seven themes at
// 1440x900 and device pixel ratio 2, plus 1024x768, the 800px narrow layout, and
// Cathode Dark in Effects Off and in Solid.
//
// Full-size PNGs, never downscaled, into screenshots/design/. Everything on
// screen comes from real git repositories built by build-design-fixture.mjs and
// torn down again afterwards.
//
//   node scripts/capture-screenshots-u4.mjs              # all of it
//   node scripts/capture-screenshots-u4.mjs lag-dark     # one theme
//
//   1440x900 dpr 2 | browser Chrome
//   sRGB, full page

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { buildFixture } from "./build-design-fixture.mjs";

const ROOT = process.cwd();
const OUT = join(ROOT, "screenshots", "design");
mkdirSync(OUT, { recursive: true });

const THEMES = [
  ["lagoon", "dark"],
  ["lagoon", "light"],
  ["cathode", "dark"],
  ["cathode", "light"],
  ["mono", "dark"],
  ["nord", "dark"],
  ["paper", "light"],
];
// Any number of "family-mode" arguments, so a subset can be recaptured after a
// change that only affects some themes without paying for all of them again.
const args = process.argv.slice(2).filter(Boolean);
const themes = args.length > 0
  ? args.flatMap((a) => a.includes(",") ? a.split(",") : [a]).map((a) => a.split("-"))
  : THEMES;

/** One temp data dir and an empty git config per process, so a fixture repo can
 *  be built without the author's identity leaking into it. */
function makeEnv() {
  const dataDir = mkdtempSync(join(tmpdir(), "forgeline-design-data-"));
  const gitConfig = join(dataDir, "..", "forgeline-design-gitconfig");
  writeFileSync(gitConfig, "");
  return { dataDir, gitConfig };
}

async function startServer({ dataDir, gitConfig }) {
  const server = spawn("node", [join(ROOT, "dist", "cli.js"), "--no-open"], {
    cwd: ROOT,
    env: {
      ...process.env,
      FORGELINE_E2E: "1",
      FORGELINE_DATA_DIR: dataDir,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_SYSTEM: gitConfig,
      EMAIL: "fixture@forgeline.local",
      GIT_AUTHOR_NAME: "Fixture Author",
      GIT_COMMITTER_NAME: "Fixture Author",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.unref();
  const printed = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not print a URL in 30s")), 30000);
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/Forgeline is running at (http:\/\/localhost:\d+\/\?t=\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    server.stdout?.on("data", onData);
    server.stderr?.on("data", onData);
    server.on("exit", (c) => reject(new Error(`server exited with ${c}\n${buf}`)));
  });
  return { server, port: new URL(printed).port };
}

const problems = [];

/** Set the appearance through the stored preference and reload, so the theme is
 *  genuinely applied rather than painted on afterwards. */
async function applyTheme(page, family, mode, appearance = {}) {
  await page.evaluate(
    ([f, m, ap]) => {
      const current = JSON.parse(localStorage.getItem("forgeline-appearance") || "{}");
      localStorage.setItem(
        "forgeline-appearance",
        JSON.stringify({ ...current, family: f, mode: m, ...ap }),
      );
    },
    [family, mode, appearance],
  );
  await page.reload();
  await page.waitForSelector(".work", { timeout: 25000 });
  // The ambient layer and the reader both settle over a moment; catching a frame
  // mid-fade would make a screenshot lie about the final appearance.
  await page.waitForTimeout(2200);
}

async function register(page, port, cookie, repos) {
  await page.evaluate(
    async ([base, c, paths]) => {
      const call = async (url, body) => {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: `session=${c}` },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`${url} -> ${r.status}`);
      };
      await call(`${base}/api/__test__/roots`, { paths: [new URL("/tmp", base).pathname] });
      for (const p of paths) {
        await call(`${base}/api/__test__/register-repo`, { path: p });
      }
    },
    [`http://127.0.0.1:${port}`, cookie, repos],
  );
}

/** A failed capture should cost a state loudly rather than silently. */
async function shot(page, filename, expect) {
  if (process.env.DESIGN_DEBUG) {
    const d = await page.evaluate(() => ({
      fileRows: document.querySelectorAll(".file-row").length,
      diff: document.querySelectorAll('[class*="diff-"]').length,
      drawer: !!document.querySelector(".journal"),
      palette: !!document.querySelector('[class*="palette"'),
      conflict: !!document.querySelector('[class*="conflict"]'),
    }));
    console.log(`  [shot] ${filename} :: ${JSON.stringify(d)}`);
  }
  try {
    await page.screenshot({ path: join(OUT, filename) });
    if (expect) {
      const seen = await page.evaluate(() => ({
        fileRows: document.querySelectorAll(".file-row").length,
        drawer: !!document.querySelector(".journal"),
        palette: !!document.querySelector('[class*="palette"]'),
        conflict: !!document.querySelector('[class*="conflict"]'),
      }));
      const got = expect(seen);
      if (got) {
        problems.push(`${filename}: ${got}`);
        console.error(`  PROBLEM ${filename}: ${got}`);
      }
    }
  } catch (error) {
    problems.push(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`  FAILED ${filename}: ${error instanceof Error ? error.message : error}`);
  }
}

/** Open a repository by its rail label and wait for its reader to finish. */
async function openRepo(page, name, port) {
  await page.goto(`http://127.0.0.1:${port}`);
  // The rail fills in once the repo list resolves, so waiting for the first row
  // is the difference between clicking a real row and clicking nothing.
  await page.waitForSelector(".rail-row", { timeout: 25000 });
  await page.waitForTimeout(1500);
  const row = page.locator(".rail-row", { hasText: name }).first();
  if (await row.count()) {
    await row.click();
  } else {
    await page.locator(".rail-row").first().click();
  }
  await page.waitForTimeout(3000);
}

async function openPage(page, port, repos, family, mode, appearance = {}) {
  const minted = await (await fetch(`http://127.0.0.1:${port}/api/__test__/bootstrap`)).json();
  await page.goto(`http://127.0.0.1:${port}/?t=${minted.token}`);
  const cookie = (await page.context().cookies()).find((c) => c.name === "session")?.value ?? "";
  await register(page, port, cookie, repos);
  await applyTheme(page, family, mode, appearance);
  return cookie;
}

// ---------------------------------------------------------------------------
// 1. The nine states, one theme at a time.
// ---------------------------------------------------------------------------
for (const [family, mode] of themes) {
  const browser = await chromium.launch();
  const env = makeEnv();
  env.fixtureRoot = mkdtempSync(join(tmpdir(), "forgeline-design-fx-"));
  const repos = Object.values(buildFixture(env.fixtureRoot));
  // A fresh data dir means no stored roots, so the server starts genuinely
  // empty and the first-run state is reachable without faking it.
  const { server, port } = await startServer(env);
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    page.on("pageerror", (e) => console.error(`  PAGE ERROR: ${e.message}`));
    await openPage(page, port, repos, family, mode);

    // 1. default dashboard — a real repo, selected, clean-ish, right after boot
    await openRepo(page, "ordinary", port);
    await shot(page, `${family}-${mode}-1-dashboard.png`, (s) =>
      s.fileRows === 0 ? "no files shown for ordinary" : null);

    // 2. a repo with many changes in every status
    await openRepo(page, "busy", port);
    await shot(page, `${family}-${mode}-2-many-changes.png`, (s) =>
      s.fileRows < 10 ? `only ${s.fileRows} files shown, expected the fourteen from busy` : null);

    // 3. composer filled, so its primary button is lit beside a disabled sibling
    const summary = page.locator('textarea[placeholder^="Describe"], textarea[aria-label="Commit message"]').first();
    if (await summary.count()) {
      await summary.fill("reach into 1.4.0 and move the widget");
      await page.waitForTimeout(1200);
    }
    await shot(page, `${family}-${mode}-3-composer.png`, (s) =>
      s.fileRows < 10 ? "the composer state lost the busy repo" : null);

    // 4. a diff open
    const firstFile = page.locator(".file-path-button").first();
    if (await firstFile.count()) {
      await firstFile.click();
      await page.waitForTimeout(2500);
      await shot(page, `${family}-${mode}-4-diff.png`, (s) =>
        s.diff === 0 ? "no diff lines rendered" : null);
    }

    // 5. undo history open
    // The toolbar control reads "Undo history" now, and its visible text is its
    // name. Matching it by role and name finds it the way a user would.
    const undo = page.getByRole("button", { name: "Undo history" }).first();
    if (await undo.count()) {
      await undo.click();
      await page.waitForTimeout(2200);
      await shot(page, `${family}-${mode}-5-undo.png`, (s) =>
        s.drawer === false ? "the undo drawer did not open" : null);
      await undo.click();
      await page.waitForTimeout(700);
    }

    // 6. An error card, from a real git failure rather than a manufactured one.
    //    The conflicted fixture is left in a stopped merge, so this is the app
    //    explaining a merge it cannot finish by itself.
    await openRepo(page, "conflicted", port);
    await page.waitForTimeout(2600);
    await shot(page, `${family}-${mode}-6-error.png`, (s) =>
      s.conflict === false ? "the stopped merge did not surface" : null);

    // 7. the empty first-run state, on a server with a fresh data dir, hence no
    //    stored roots. The registry fills itself the moment a repo is
    //    registered, so a server that has served the other states can never
    //    honestly show first-run again. This runs in its own page and context so
    //    minting a token there does not cost the session on the main server.
    {
      const emptyEnv = makeEnv();
      const { server: emptyServer, port: emptyPort } = await startServer(emptyEnv);
      const emptyPage = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      });
      try {
        const minted = await (await fetch(`http://127.0.0.1:${emptyPort}/api/__test__/bootstrap`)).json();
        await emptyPage.goto(`http://127.0.0.1:${emptyPort}/?t=${minted.token}`);
        await applyTheme(emptyPage, family, mode);
        await shot(emptyPage, `${family}-${mode}-7-empty.png`);
        console.log(`  captured ${family}-${mode}-7-empty.png on a first-run server`);
      } finally {
        await emptyPage.close();
        emptyServer.kill("SIGTERM");
        rmSync(emptyEnv.dataDir, { recursive: true, force: true });
        rmSync(emptyEnv.gitConfig, { force: true });
      }
    }

    // 8. command palette open
    await page.goto(`http://127.0.0.1:${port}`);
    await openRepo(page, "ordinary", port);
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForSelector(".palette-results", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1600);
    await shot(page, `${family}-${mode}-8-palette.png`, (s) =>
      s.palette === false ? "the palette did not open" : null);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);

    // 9. activity on the repository with two thousand commits. Opening the
    //    repository alone is not this state: a clean repository's default view is
    //    the changes list, which is empty, so the capture looked exactly like the
    //    dashboard. The history panel is what shows the graph.
    await openRepo(page, "deep-history", port);
    const activity = page.locator("button.toolbar-history").first();
    if (await activity.count()) {
      await activity.click();
      await page.waitForTimeout(4000);
    }
    await shot(page, `${family}-${mode}-9-activity.png`);

    await browser.close();
    console.log(`captured ${family}-${mode}: 9 states`);
  } finally {
    rmSync(env.fixtureRoot, { recursive: true, force: true });
    rmSync(env.dataDir, { recursive: true, force: true });
    rmSync(env.gitConfig, { force: true });
    server.kill("SIGTERM");
  }
}


// ---------------------------------------------------------------------------
// 2. The extra views.
// ---------------------------------------------------------------------------
function startRepoWithFixture() {
  const env = makeEnv();
  env.fixtureRoot = mkdtempSync(join(tmpdir(), "forgeline-design-fx-"));
  const repos = Object.values(buildFixture(env.fixtureRoot));
  return { env, repos };
}

const viewportCases = [
  { name: "lagoon-dark-1024-dashboard.png", viewport: { width: 1024, height: 768 }, family: "lagoon", mode: "dark" },
  { name: "lagoon-dark-800-narrow.png", viewport: { width: 800, height: 900 }, family: "lagoon", mode: "dark" },
  { name: "cathode-dark-effects-off.png", viewport: { width: 1440, height: 900 }, family: "cathode", mode: "dark", appearance: { effects: "off" } },
  { name: "cathode-dark-solid.png", viewport: { width: 1440, height: 900 }, family: "cathode", mode: "dark", appearance: { effects: "full", surface: "solid" } },
];
for (const { name, viewport, family, mode, appearance } of viewportCases) {
  const { env, repos } = startRepoWithFixture();
  const { server, port } = await startServer(env);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    await openPage(page, port, repos, family, mode, appearance || {});
    await openRepo(page, "busy", port);
    await shot(page, name, (s) => (s.fileRows === 0 ? "no repo content in this extra view" : null));
    console.log(`captured ${name}`);
  } finally {
    await browser.close();
    rmSync(env.fixtureRoot, { recursive: true, force: true });
    rmSync(env.dataDir, { recursive: true, force: true });
    rmSync(env.gitConfig, { force: true });
    server.kill("SIGTERM");
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log(`\ncaptured ${themes.length} theme(s) and ${viewportCases.length} extra views into screenshots/design/`);
}
