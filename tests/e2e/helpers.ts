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

/** Age the current bootstrap token so it is older than the 5-minute TTL. */
export async function expireTokenForTest(baseUrl: string, ageMs: number): Promise<void> {
  const res = await fetch(`${baseUrl}/api/__test__/expire-bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ageMs }),
  });
  if (!res.ok) {
    throw new Error(`could not expire the test token: HTTP ${res.status}`);
  }
  await res.arrayBuffer();
}

/** Point the e2e server's registry at the given root folders (test-only). */
export async function setRootsForTest(baseUrl: string, paths: string[]): Promise<void> {
  const res = await fetch(`${baseUrl}/api/__test__/roots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) {
    throw new Error(`could not set test roots: HTTP ${res.status}`);
  }
  await res.arrayBuffer();
}

/** Register a repo path in the e2e server's registry; returns its opaque id. */
export async function registerRepoForTest(baseUrl: string, cookie: string, path: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/__test__/register-repo`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: cookie },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    throw new Error(`could not register test repo: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { id?: unknown };
  if (typeof body.id !== "string" || body.id.length === 0) {
    throw new Error("test register-repo endpoint returned no id");
  }
  return body.id;
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

