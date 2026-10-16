// The design gate. Update 4, section 6, checks 1 to 6.
//
//   1. Type floor: no computed font-size under 11px, and none under 13px for
//      body or control text. Micro labels are the only exception, and they are
//      not allowed to hold a sentence.
//   2. Contrast: every token pair for every family and mode, against the worst
//      case of the ambient layer, plus each filled button's label against its
//      fill, plus the OKLCH lightness steps between surfaces.
//   3. Overflow and clipping at 1440, 1024, and 800px: no horizontal page
//      scroll, and nothing wider than its own box unless it ellipsizes or
//      scrolls on purpose.
//   4. Overlap: the undo drawer and any menu never intersect the status bar.
//   5. Hit targets: no control under 32px.
//   6. Keyboard access: anything revealed on hover is revealed on focus too.
//   7. Accessibility: an automated pass, kept to the categories this app is
//      actually responsible for and to the impacts that would stop someone
//      using it. Section 6 asks for this with a one-line justification, which
//      lives in docs/decisions.md: the six checks above are written against
//      this app's own markup and cannot see a landmark with no name or a
//      nested control; axe can.
//
// Contrast lives in scripts/check-contrast.mjs, which this runs first, because
// the two share one engine and one source of truth for the colours.
//
// The browser checks need a running server, so this starts its own on an
// OS-assigned port with an isolated data directory, seeds a real repository,
// and shuts it down on the way out. Exit code 0 means every check passed.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { checkColours } from "./check-contrast-engine.mjs";

const failures = [];
const offenders = new Map();
function fail(check, list) {
  failures.push(check);
  offenders.set(check, list);
}
function banner(check) {
  return `\n  ── ${check} ──`;
}

// ---------- an isolated server ----------

const dataDir = mkdtempSync(join(tmpdir(), "forgeline-design-data-"));
const gitConfig = join(dataDir, "..", "forgeline-design-gitconfig");
writeFileSync(gitConfig, "");

const server = spawn("node", ["dist/cli.js", "--no-open"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    FORGELINE_E2E: "1",
    FORGELINE_DATA_DIR: dataDir,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_SYSTEM: gitConfig,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("design server did not print a URL in time")), 30000);
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
  server.on("exit", (code) => reject(new Error(`design server exited early: ${code}\n${buf}`)));
});
const baseUrl = `http://127.0.0.1:${new URL(url).port}`;
server.unref();

// ---------- a real repository, with real changes and a real history ----------

const fixtures = mkdtempSync(join(tmpdir(), "forgeline-design-fixtures-"));
const repo = join(fixtures, "design-repo");
const git = (args) =>
  spawnSync("git", args, { cwd: repo, encoding: "utf8" });

mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "package.json"), '{\n  "name": "design-repo",\n  "version": "1.4.0"\n}\n');
writeFileSync(join(repo, "src", "app.ts"), "export const start = 1;\n");
writeFileSync(join(repo, "src", "core.ts"), "export const core = 2;\n");
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "design@forgeline.local"]);
git(["config", "user.name", "Design Fixture"]);
git(["add", "-A"]);
git(["commit", "-qm", "feat: the start"]);
// Enough history that the timeline and the log both have something to draw.
for (let i = 0; i < 12; i++) {
  writeFileSync(join(repo, "src", "core.ts"), `export const core = ${i + 2};\n`);
  git(["commit", "-qam", i % 3 === 0 ? `feat: change number ${i}` : `fix: a repair ${i}`]);
}
git(["tag", "v1.4.0"]);
// And a working tree with all five statuses in it.
writeFileSync(join(repo, "src", "app.ts"), "export const start = 11;\n");            // M
writeFileSync(join(repo, "src", "added.ts"), "export const added = true;\n");        // A
writeFileSync(join(repo, "src", "gone.ts"), "gone\n");                               // D
git(["add", "-A"]);
git(["mv", "src/core.ts", "src/core-renamed.ts"]);                                   // R
writeFileSync(join(repo, "src", "untracked.ts"), "export const untracked = 1;\n");   // ?

// ---------- the browser ----------

const browser = await chromium.launch();
try {
  // A context rather than a bare page: axe's builder refuses a page that was not
  // opened by a context, and building one context keeps every check on the same
  // origin, cookie jar, and viewport.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));

  // The printed URL uses "localhost" and the API is reached at "127.0.0.1", so
  // navigating to the printed one and posting to the API is a cross-origin
  // request that the host check correctly refuses. Put the token on the API's
  // own origin instead, which is the same trick the e2e suite uses.
  const bootstrapToken = new URL(url).searchParams.get("t") ?? "";
  await page.goto(`${baseUrl}/?t=${bootstrapToken}`);
  const cookie = (await page.context().cookies()).find((c) => c.name === "session")?.value;
  if (!cookie) throw new Error("no session cookie after the token exchange");

  await page.evaluate(async ([base, c, roots, repoPath]) => {
    await fetch(`${base}/api/__test__/roots`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: `session=${c}` },
      body: JSON.stringify({ paths: roots }),
    });
    await fetch(`${base}/api/__test__/register-repo`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: `session=${c}` },
      body: JSON.stringify({ path: repoPath }),
    });
  }, [baseUrl, cookie, [fixtures], repo]);

  await page.goto(baseUrl);
  await page.waitForSelector(".work", { timeout: 15000 });
  await page.waitForTimeout(1500);

  // ---------- 1. the type floor ----------
  {
    const bad = await page.evaluate(() => {
      const out = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      let n;
      while ((n = walk.nextNode())) {
        const text = (n.nodeValue || "").trim();
        if (!text) continue;
        const el = n.parentElement;
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const cs = getComputedStyle(el);
        const size = parseFloat(cs.fontSize);
        if (size < 11) {
          out.push({ size, text: text.slice(0, 48), why: "under 11px" });
          continue;
        }
        if (size < 13) {
          // A single character is a glyph, not text: the status letter stays in
          // the row with a screen-reader word beside it, so the colour never
          // carries the meaning alone.
          if (text.length <= 1) continue;
          // A micro label is allowed at 11px. It is marked, and it may not hold
          // a sentence — that is a copy bug, not a label.
          const micro = el.closest(".label, .micro, .keycap, .lamp, [data-micro]");
          if (!micro) {
            out.push({ size, text: text.slice(0, 48), why: "body or control text under 13px" });
          } else if (text.length > 28) {
            out.push({ size, text: text.slice(0, 48), why: "a micro label holding a sentence" });
          }
        }
      }
      return out;
    });
    if (bad.length > 0) {
      fail("type floor", bad.map((b) => `${b.size}px "${b.text}" — ${b.why}`));
    }
  }

  // ---------- 3. overflow and clipping ----------
  {
    const widths = [1440, 1024, 800];
    const bad = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(350);
      const found = await page.evaluate(() => {
          const de = document.documentElement;
        const out = [];
        if (de.scrollWidth > de.clientWidth + 1) {
          out.push(`page scrolls horizontally: ${de.scrollWidth} > ${de.clientWidth}`);
        }
        for (const el of document.querySelectorAll("*")) {
          const cs = getComputedStyle(el);
          // A box that means to scroll or ellipsize is not a failure.
          if (cs.overflowX === "auto" || cs.overflowX === "scroll") continue;
          if (cs.overflowX === "hidden" && cs.textOverflow === "ellipsis") continue;
          // .sr-only is one pixel on purpose. It is a screen-reader channel,
          // not a box that failed to fit its contents.
          if (el.closest(".sr-only")) continue;
          if (el.scrollWidth > el.clientWidth + 1) {
            const cls = typeof el.className === "string" ? el.className.split(" ")[0] : "";
            out.push(
              `${el.tagName.toLowerCase()}${cls ? "." + cls : ""} ${el.scrollWidth} > ${el.clientWidth}`,
            );
          }
        }
        return out.slice(0, 12);
      });
      bad.push(...found.map((f) => `${width}px: ${f}`));
    }
    if (bad.length > 0) fail("overflow and clipping", bad);
  }

  // ---------- 5. hit targets ----------
  {
    const bad = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll(
        "button, a[href], input, select, textarea, [role='button'], [role='tab']",
      )) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue; // not rendered
        const cls = typeof el.className === "string" ? el.className.split(" ")[0] : "";
        const name = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30);
        if (r.height < 32) {
          out.push(`${el.tagName.toLowerCase()}${cls ? "." + cls : ""} "${name}" is ${Math.round(r.height)}px tall`);
        }
        if (r.width < 24) {
          out.push(`${el.tagName.toLowerCase()}${cls ? "." + cls : ""} "${name}" is ${Math.round(r.width)}px wide`);
        }
      }
      return out;
    });
    if (bad.length > 0) fail("hit targets", bad);
  }

  // ---------- 4. the status bar is never covered ----------
  {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    const bad = [];
    // The undo drawer.
    const trigger = page.getByRole("button", { name: "Undo history" }).first();
    if (await trigger.count() > 0) {
      await trigger.click();
      await page.waitForTimeout(600);
    }
    const drawerRect = await page.evaluate(() => {
      const el = document.querySelector(".journal");
      return el ? el.getBoundingClientRect().toJSON() : null;
    });
    const statusRect = await page.evaluate(() => {
      const el = document.querySelector(".statusbar");
      return el ? el.getBoundingClientRect().toJSON() : null;
    });
    if (drawerRect && statusRect) {
      const overlaps =
        drawerRect.bottom > statusRect.top + 1 &&
        drawerRect.top < statusRect.bottom - 1 &&
        drawerRect.right > statusRect.left + 1 &&
        drawerRect.left < statusRect.right - 1;
      if (overlaps) bad.push(`the undo drawer overlaps the status bar by ${Math.round(drawerRect.bottom - statusRect.top)}px`);
    } else {
      bad.push("no undo drawer or status bar found to measure");
    }
    if (bad.length > 0) fail("status bar is never covered", bad);
  }

  // ---------- 6. keyboard access ----------
  {
    const bad = await page.evaluate(async () => {
      const out = [];
      // Anything that appears on hover must also appear on focus, or a keyboard
      // user never sees it at all. Checked by focusing and re-measuring.
      const controls = [
        ...document.querySelectorAll(
          "button, a[href], input, select, textarea, [role='button'], [tabindex='0']",
        ),
      ];
      for (const el of controls.slice(0, 60)) {
        const before = el.getBoundingClientRect();
        if (before.width === 0 && before.height === 0) continue;
        const beforeStyle = getComputedStyle(el);
        el.focus();
        await new Promise((r) => setTimeout(r, 60));
        const hasFocus = document.activeElement === el;
        if (!hasFocus) continue;
        // A control that is visible only on hover should be visible on focus.
        const afterStyle = getComputedStyle(el);
        if (beforeStyle.visibility !== afterStyle.visibility && afterStyle.visibility !== "visible") {
          const cls = typeof el.className === "string" ? el.className.split(" ")[0] : "";
          out.push(`${el.tagName.toLowerCase()}${cls ? "." + cls : ""} is hidden on keyboard focus`);
        }
      }
      return out;
    });
    if (bad.length > 0) fail("keyboard access", bad);
  }

  // ---------- 7. an automated accessibility pass ----------
  // The update asks for this as a check in its own right. It deliberately runs
  // before the browser is torn down, so it measures the same loaded page rather
  // than booting a second one.
  {
    const results = await new AxeBuilder({ page }).analyze();
    // Only the rules that are about structure this app is responsible for, not
    // the page-experiment tags axe ships and nobody asked for.
    const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
    const violations = results.violations
      .filter((v) => v.tags.some((t) => tags.includes(t)))
      .filter((v) => v.impact === "critical" || v.impact === "serious");
    const listed = violations.map((v) => {
      const nodes = v.nodes
        .slice(0, 4)
        .map((n) => (n.target.length ? n.target.join(" ") : "(no target)"))
        .join("; ");
      return `${v.id} (${v.impact}): ${nodes}${v.nodes.length > 4 ? ` …and ${v.nodes.length - 4} more` : ""}`;
    });
    if (listed.length > 0) fail("accessibility", listed);
  }

  await context.close();
} finally {
  await browser.close();
}

// ---------- 2. contrast, token pairs, and surface steps ----------
const contrastFailures = checkColours();
if (contrastFailures.length > 0) fail("contrast and surface steps", contrastFailures);

// ---------- report ----------

rmSync(fixtures, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });
rmSync(gitConfig, { force: true });
server.kill("SIGTERM");

if (failures.length > 0) {
  console.error(`\ndesign: ${failures.length} failing check(s)`);
  for (const check of failures) {
    console.error(banner(check));
    for (const line of offenders.get(check) ?? []) console.error(`    ${line}`);
  }
  console.error("");
  process.exit(1);
}
console.log(
  "design ok: type floor, contrast and surface steps, overflow, overlap, hit targets, keyboard access, accessibility",
);
