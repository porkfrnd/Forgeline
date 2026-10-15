// Round 3, corrected. The first version hung because spawnSync BLOCKS the
// event loop, so an HTTP fixture started by the same process could never
// answer its request. The fixture must be served while git runs.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const root = mkdtempSync(join(tmpdir(), "fl-err3-"));
const sync = (cwd, args) =>
  spawnSync("git", ["-c", "user.name=F", "-c", "user.email=f@i", ...args], { cwd, encoding: "utf8" });

const fresh = (name) => {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  sync(d, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(d, "f.txt"), "v1\n");
  sync(d, ["add", "-A"]); sync(d, ["commit", "-q", "-m", "base"]);
  return d;
};

const asyncGit = (cwd, args, extraEnv) =>
  new Promise((resolve) => {
    const child = spawn("git", ["-c", "user.name=F", "-c", "user.email=f@i", ...args], {
      cwd, encoding: "utf8", env: { ...process.env, ...extraEnv },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("KILLED (timed out)"); }, 12000);
    child.on("exit", (code) => { clearTimeout(timer); resolve(`[${code}] ${out.trim()}`); });
  });

const show = (label, text) => console.log(`\n===== ${label} =====\n` + text);

for (const code of [401, 403]) {
  const body = `${code} Unauthorized`;
  const server = createServer((req, res) => {
    res.writeHead(code, {
      "Content-Type": "text/plain",
      "Content-Length": Buffer.byteLength(body),
      Connection: "close",
      "WWW-Authenticate": 'Basic realm="forgeline-fixture"',
    });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const repo = fresh(`http${code}`);
  sync(repo, ["remote", "add", "origin", `http://127.0.0.1:${port}/repo.git`]);
  show(`http-${code}`, await asyncGit(repo, ["fetch", "origin"], { GIT_TERMINAL_PROMPT: "0" }));
  show(`http-${code}-push`, await asyncGit(repo, ["push", "origin", "main"], { GIT_TERMINAL_PROMPT: "0" }));
  show(`http-${code}-askpass-off`, await asyncGit(repo, ["fetch", "origin"], {
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "",
  }));
  server.close();
}

console.log("\nROOT:", root);
rmSync(root, { recursive: true, force: true });
