import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ServerInfo {
  baseUrl: string;
  token: string;
  port: number;
  pid: number;
}

export const SERVER_INFO_PATH = join(tmpdir(), "forgeline-e2e-server.json");

/** An isolated app-data directory for the e2e run. The server persists roots
 *  and a journal to app-data, and neither may land in the developer's real
 *  home directory — nor survive to pollute the next run. */
const E2E_DATA_DIR = mkdtempSync(join(tmpdir(), "forgeline-e2e-data-"));

export default async function globalSetup(): Promise<void> {
  const child = spawn("node", ["dist/cli.js", "--no-open"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FORGELINE_E2E: "1",
      FORGELINE_DATA_DIR: E2E_DATA_DIR,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("E2E server did not print a URL in time")), 30000);
    let buf = "";
    const onData = (d: Buffer): void => {
      buf += d.toString();
      const m = buf.match(/Forgeline is running at (http:\/\/localhost:\d+\/\?t=\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`E2E server exited early with code ${code}\n${buf}`));
    });
  });

  const parsed = new URL(url);
  const token = parsed.searchParams.get("t") ?? "";
  const info: ServerInfo = {
    baseUrl: `http://127.0.0.1:${parsed.port}`,
    token,
    port: Number(parsed.port),
    pid: child.pid ?? -1,
  };
  writeFileSync(SERVER_INFO_PATH, JSON.stringify(info), "utf8");
  child.unref();
}
