import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? ".", "..");
const BANNED_FILE = join(ROOT, "scripts", "banned-phrases.txt");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".swarm", ".opencode", "screenshots"]);
const SKIP_FILES = new Set(["banned-phrases.txt"]);
const SCAN_EXTS = new Set([".ts", ".tsx", ".md", ".json"]);

function walk(dir, out) {
  for (const e of readdirSync(dir)) {
    if (e === "docs") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(e)) continue;
      walk(p, out);
    } else if (st.isFile()) {
      if (SKIP_FILES.has(e)) continue;
      const dot = e.lastIndexOf(".");
      const ext = dot >= 0 ? e.slice(dot) : "";
      if (!SCAN_EXTS.has(ext)) continue;
      if (p.endsWith("package.json.pending") || p.endsWith(".pending")) continue;
      out.push(p);
    }
  }
}

const phrases = readFileSync(BANNED_FILE, "utf8")
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith("#"));

const files = [];
const srcDir = join(ROOT, "src");
if (existsSync(srcDir)) walk(srcDir, files);
const readme = join(ROOT, "README.md");
if (existsSync(readme)) files.push(readme);

let failed = false;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const lower = text.toLowerCase();
  for (const phrase of phrases) {
    if (lower.includes(phrase.toLowerCase())) {
      console.error(`${f}: banned phrase "${phrase}"`);
      failed = true;
    }
  }
}
if (failed) {
  console.error("lint:copy failed: banned phrases found.");
  process.exit(1);
} else {
  console.log("lint:copy ok");
}
