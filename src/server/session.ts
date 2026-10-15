import { randomBytes, timingSafeEqual } from "node:crypto";

/** Bootstrap links live for five minutes, then must be re-minted. */
export const BOOTSTRAP_TTL_MS = 5 * 60 * 1000;
/** A session with no requests for this long is dropped. */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

export interface AuthManager {
  /** The bootstrap token currently valid for exchange, or "" once consumed. */
  currentBootstrapToken(): string;
  /** Exchange a bootstrap token for a fresh session id. Returns null if the
   *  token is unknown, already used, or expired. Single-use. */
  consumeBootstrap(token: string): string | null;
  /** True when the session id is known and within the idle window; slides the
   *  window forward on success. */
  validateSession(id: string): boolean;
  /** True when at least one live session exists. */
  hasActiveSession(): boolean;
  /** Mint a fresh bootstrap token. Only used by the terminal "press Enter"
   *  path (guarded so it will not clobber a live session) and by tests. */
  refreshBootstrap(): string | null;
  /** Always mint a fresh bootstrap token regardless of active sessions.
   *  Reachable only through the test-guarded endpoint; never in production. */
  forceBootstrap(): string;
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Pull a single cookie value out of a Cookie header. */
export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return part.slice(idx + 1).trim();
    }
  }
  return null;
}

export function createAuth(now: () => number = Date.now): AuthManager {
  let bootstrap = newToken();
  let bootstrapMint = now();
  let consumed = false;
  const sessions = new Map<string, number>();

  function prune(): void {
    const t = now();
    for (const [id, last] of sessions) {
      if (t - last > SESSION_IDLE_MS) sessions.delete(id);
    }
  }

  return {
    currentBootstrapToken(): string {
      return consumed ? "" : bootstrap;
    },

    consumeBootstrap(token: string): string | null {
      const t = now();
      if (consumed) return null;
      if (t - bootstrapMint > BOOTSTRAP_TTL_MS) return null;
      if (!safeEqual(token, bootstrap)) return null;
      consumed = true;
      const id = newToken();
      sessions.set(id, t);
      return id;
    },

    validateSession(id: string): boolean {
      const t = now();
      prune();
      const last = sessions.get(id);
      if (last === undefined) return false;
      if (t - last > SESSION_IDLE_MS) {
        sessions.delete(id);
        return false;
      }
      sessions.set(id, t);
      return true;
    },

    hasActiveSession(): boolean {
      prune();
      return sessions.size > 0;
    },

    refreshBootstrap(): string | null {
      if (this.hasActiveSession()) return null;
      const t = now();
      if (!consumed && t - bootstrapMint <= BOOTSTRAP_TTL_MS) return bootstrap;
      bootstrap = newToken();
      bootstrapMint = t;
      consumed = false;
      return bootstrap;
    },

    forceBootstrap(): string {
      bootstrap = newToken();
      bootstrapMint = now();
      consumed = false;
      return bootstrap;
    },
  };
}
