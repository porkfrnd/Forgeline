import { readFileSync } from "node:fs";
import { SERVER_INFO_PATH, type ServerInfo } from "./global-setup.js";

export function serverInfo(): ServerInfo {
  return JSON.parse(readFileSync(SERVER_INFO_PATH, "utf8")) as ServerInfo;
}

/** Mint a fresh single-use bootstrap token from the test-only endpoint. */
export async function mintToken(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/__test__/bootstrap`);
  if (!res.ok) {
    throw new Error(`could not mint a test token: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { token?: unknown };
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("test bootstrap endpoint returned no token");
  }
  return body.token;
}

/** Mint a token and exchange it for a session cookie value (`session=...`). */
export async function sessionCookie(baseUrl: string): Promise<string> {
  const token = await mintToken(baseUrl);
  const res = await fetch(`${baseUrl}/?t=${token}`, { redirect: "manual" });
  try {
    if (res.status !== 303) {
      throw new Error(`bootstrap exchange failed: HTTP ${res.status}`);
    }
    const setCookie = res.headers.get("set-cookie") ?? "";
    const m = setCookie.match(/session=([^;]*)/);
    if (!m) throw new Error("bootstrap exchange set no session cookie");
    return `session=${m[1]}`;
  } finally {
    await res.arrayBuffer();
  }
}

