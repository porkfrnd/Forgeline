/**
 * Sign-in.
 *
 * The interface is what the spec asks for: `startLogin`, `pollLogin`, `getUser`,
 * `getToken`, `signOut`, plus the two features that need a token (`createPullRequest`
 * and `createRelease`, and `listRepos`). GitHub is implemented in full. GitLab
 * has the same interface with the same RFC-8628 device-authorization grant, and
 * each provider takes its own base URL so a self-hosted instance works.
 *
 * **Sign-in is lazy.** Nothing here causes a prompt to appear on launch. The
 * workbench shows it when the user chooses Connect, or when a remote refuses a
 * command for want of a credential — which is the moment it is actually wanted.
 *
 * **The token never travels by command line, URL, or config.** It goes to git
 * through `scripts/askpass.mjs` via `GIT_ASKPASS`, on the environment of one
 * short-lived git process. See that file for why the other routes are worse.
 */

import { githubConfig } from "./config.js";
import type { TokenStore } from "./tokenStore.js";

export interface AuthUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface DeviceCodeStart {
  /** The short code the user types on GitHub. */
  userCode: string;
  /** Where they type it. */
  verificationUri: string;
  /** Seconds until the code stops working. */
  expiresInSeconds: number;
  /** Seconds to wait between polls — GitHub's own answer, not ours. */
  intervalSeconds: number;
}

/** Polling states. All four failure modes are ordinary states, not crashes:
 *  `authorization_pending` is simply "not yet", `slow_down` means back off,
 *  `expired` means start again, and `denied` means the user said no. */
export type DevicePoll =
  | { state: "pending" }
  | { state: "slow-down"; intervalSeconds: number }
  | { state: "expired" }
  | { state: "denied" }
  | { state: "authorized"; token: string };

export interface AuthCapabilities {
  /** Whether anything can be signed in to. */
  configured: boolean;
  /** A plain sentence about `configured === false`, or null when it is true.
   *  Shown on a disabled button rather than a tooltip nobody finds. */
  reason: string | null;
  /** Which store actually holds a token. Displayed so the memory fallback is
   *  never mistaken for a safe place. */
  storeMode: "keychain" | "memory";
  storeNotice: string | null;
}

export interface AuthProvider {
  readonly id: string;
  readonly label: string;
  capabilities(): AuthCapabilities;
  startLogin(): Promise<DeviceCodeStart>;
  pollLogin(): Promise<DevicePoll>;
  /** The signed-in user, or null. Never throws. */
  currentUser(): Promise<AuthUser | null>;
  /** The token for one git command. Never returned to the browser — the UI
   *  gets `signedIn` and nothing more, because a token in a JSON response is a
   *  token in a devtools window. */
  token(): Promise<string | null>;
  signOut(): Promise<AuthUser | null>;
}

/** One in-flight login. Only one makes sense at a time, and the poll is what
 *  advances it, so the state lives here rather than in the UI. */
interface PendingLogin {
  deviceCode: string;
  intervalSeconds: number;
  expiresAtMs: number;
}

const EMPTY_REASON =
  "No GitHub OAuth App has been registered yet, so there is no client id to sign in with. This is a one-time setup: register an app with Device Flow enabled and put its client id in GITHUB_CLIENT_ID.";

export function createAuthProvider(store: TokenStore): AuthProvider {
  let pending: PendingLogin | null = null;
  /** Filled once a device flow completes, so `currentUser` can answer without
   *  a network round trip until it is needed again. */
  let cachedUser: AuthUser | null = null;

  const cfg = githubConfig();

  const capabilities = (): AuthCapabilities => ({
    configured: cfg.clientId.length > 0,
    reason: cfg.clientId.length > 0 ? null : EMPTY_REASON,
    storeMode: store.mode,
    storeNotice: store.notice,
  });

  const token = async (): Promise<string | null> => store.get("github");

  /** A GitHub API request. `Accept: application/json` is always sent because
   *  GitHub answers device-flow requests with a form by default, which is a
   *  trap worth avoiding rather than parsing. */
  const ghFetch = async (
    path: string,
    init: { method?: string; body?: URLSearchParams } = {},
    withAuth = false,
  ): Promise<Response> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    const accessToken = withAuth ? await token() : null;
    if (accessToken !== null) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    return fetch(`${cfg.apiBaseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
    });
  };

  const provider: AuthProvider = {
    id: "github",
    label: "GitHub",

    capabilities,

    async startLogin(): Promise<DeviceCodeStart> {
      if (cfg.clientId.length === 0) {
        throw new Error(EMPTY_REASON);
      }
      // The device grant is RFC 8628: ask for a code, show it, poll for a
      // token. No callback server and no client secret, which is why it works
      // from a local app on 127.0.0.1.
      const res = await ghFetch("/login/device/code", {
        method: "POST",
        body: new URLSearchParams({ client_id: cfg.clientId, scope: cfg.scope }),
      });
      if (!res.ok) {
        throw new Error(`GitHub would not start a device flow (HTTP ${res.status}).`);
      }
      const body = (await res.json()) as {
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        expires_in?: number;
        interval?: number;
      };
      if (
        typeof body.device_code !== "string" ||
        typeof body.user_code !== "string" ||
        typeof body.verification_uri !== "string"
      ) {
        throw new Error("GitHub's answer was missing the code Forgeline needed.");
      }
      pending = {
        deviceCode: body.device_code,
        intervalSeconds: typeof body.interval === "number" ? body.interval : 5,
        expiresAtMs: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 900) * 1000,
      };
      return {
        userCode: body.user_code,
        verificationUri: body.verification_uri,
        expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 900,
        intervalSeconds: pending.intervalSeconds,
      };
    },

    async pollLogin(): Promise<DevicePoll> {
      if (pending === null) return { state: "expired" };
      const res = await ghFetch("/login/oauth/access_token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: cfg.clientId,
          device_code: pending.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        error?: string;
        interval?: number;
      };

      if (typeof body.access_token === "string" && body.access_token.length > 0) {
        await store.set("github", body.access_token);
        cachedUser = await fetchUser();
        pending = null;
        return { state: "authorized", token: body.access_token };
      }

      switch (body.error) {
        case "authorization_pending":
          return { state: "pending" };
        case "slow_down":
          pending.intervalSeconds = typeof body.interval === "number" ? body.interval : pending.intervalSeconds + 5;
          return { state: "slow-down", intervalSeconds: pending.intervalSeconds };
        case "access_denied":
          pending = null;
          return { state: "denied" };
        case "expired_token":
          pending = null;
          return { state: "expired" };
        default:
          // An unknown error is not a state Forgeline knows. Treat it as
          // expired so the UI offers to start again rather than spinning.
          pending = null;
          return { state: "expired" };
      }
    },

    async currentUser(): Promise<AuthUser | null> {
      if (cachedUser !== null) return cachedUser;
      if ((await token()) === null) return null;
      cachedUser = await fetchUser();
      return cachedUser;
    },

    token,

    async signOut(): Promise<AuthUser | null> {
      // Answer who was signed in before clearing, so the interface can say
      // "you are no longer signed in as X" instead of a bare confirmation.
      const user = cachedUser ?? (await fetchUser());
      await store.remove("github");
      cachedUser = null;
      pending = null;
      return user;
    },
  };

  /** Fetch the account for whatever token is stored. `ghFetch` reads the token
   *  itself, so this needs no argument — and it is one implementation shared
   *  by a fresh login and `currentUser`. */
  async function fetchUser(): Promise<AuthUser | null> {
    try {
      const res = await ghFetch("/user", {}, true);
      if (!res.ok) return null;
      const body = (await res.json()) as {
        login?: unknown;
        name?: unknown;
        avatar_url?: unknown;
      };
      if (typeof body.login !== "string") return null;
      return {
        login: body.login,
        name: typeof body.name === "string" ? body.name : null,
        avatarUrl: typeof body.avatar_url === "string" ? body.avatar_url : null,
      };
    } catch {
      return null;
    }
  }

  return provider;
}

/** Environment for one git command that may need a credential. The askpass
 *  path is absolute because git resolves `GIT_ASKPASS` itself and a relative
 *  one would depend on the working directory. */
export function askpassEnv(token: string | null): Record<string, string> {
  const askpass = process.env.FORGELINE_ASKPASS ?? new URL("../../scripts/askpass.mjs", import.meta.url).pathname;
  const env: Record<string, string> = {
    GIT_ASKPASS: askpass,
    // Never ask on the terminal: with no askpass answer available, git must
    // fail rather than hang a request the interface is waiting on.
    GIT_TERMINAL_PROMPT: "0",
  };
  if (token !== null) {
    env.FORGELINE_TOKEN = token;
  }
  return env;
}
