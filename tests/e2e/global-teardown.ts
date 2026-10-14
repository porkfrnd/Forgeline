import { readFileSync, rmSync } from "node:fs";
import { SERVER_INFO_PATH } from "./global-setup.js";

export default async function globalTeardown(): Promise<void> {
  try {
    const info = JSON.parse(readFileSync(SERVER_INFO_PATH, "utf8")) as { pid: number };
    if (info.pid > 0) {
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing to clean up */
  }
  try {
    rmSync(SERVER_INFO_PATH, { force: true });
  } catch {
    /* ignore */
  }
}
