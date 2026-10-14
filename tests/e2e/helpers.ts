import { readFileSync } from "node:fs";
import { SERVER_INFO_PATH, type ServerInfo } from "./global-setup.js";

export function serverInfo(): ServerInfo {
  return JSON.parse(readFileSync(SERVER_INFO_PATH, "utf8")) as ServerInfo;
}
