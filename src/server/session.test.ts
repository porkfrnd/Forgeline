import { describe, it, expect } from "vitest";
import {
  createAuth,
  parseCookie,
  BOOTSTRAP_TTL_MS,
  SESSION_IDLE_MS,
} from "./session.js";

describe("bootstrap token exchange", () => {
  it("hands out a session id once, then refuses the replay", () => {
    const auth = createAuth();
    const token = auth.currentBootstrapToken();
    expect(token.length).toBeGreaterThan(0);
    const session = auth.consumeBootstrap(token);
    expect(typeof session).toBe("string");
    expect(auth.consumeBootstrap(token)).toBeNull();
    expect(auth.currentBootstrapToken()).toBe("");
  });

  it("rejects a token it never minted", () => {
    const auth = createAuth();
    expect(auth.consumeBootstrap("not-the-token")).toBeNull();
  });

  it("lets the bootstrap link expire after five minutes", () => {
    let now = 1_000_000;
    const auth = createAuth(() => now);
    const token = auth.currentBootstrapToken();
    now += BOOTSTRAP_TTL_MS + 1;
    expect(auth.consumeBootstrap(token)).toBeNull();
  });

  it("expireBootstrapForTest backdates the token past expiry", () => {
    const auth = createAuth();
    const token = auth.currentBootstrapToken();
    auth.expireBootstrapForTest(BOOTSTRAP_TTL_MS + 1);
    expect(auth.consumeBootstrap(token)).toBeNull();
  });

  it("drops a session that has been idle too long", () => {
    let now = 1_000_000;
    const auth = createAuth(() => now);
    const session = auth.consumeBootstrap(auth.currentBootstrapToken());
    expect(typeof session).toBe("string");
    if (typeof session !== "string") return;
    expect(auth.validateSession(session)).toBe(true);
    now += SESSION_IDLE_MS + 1;
    expect(auth.validateSession(session)).toBe(false);
  });

  it("slides the idle window forward while the session is in use", () => {
    let now = 1_000_000;
    const auth = createAuth(() => now);
    const first = auth.consumeBootstrap(auth.currentBootstrapToken());
    expect(typeof first).toBe("string");
    if (typeof first !== "string") return;
    now += SESSION_IDLE_MS - 1000;
    expect(auth.validateSession(first)).toBe(true);
    now += SESSION_IDLE_MS - 1000;
    expect(auth.validateSession(first)).toBe(true);
  });

  it("mints a fresh link only when nobody holds a live session", () => {
    const auth = createAuth();
    const first = auth.currentBootstrapToken();
    expect(auth.refreshBootstrap()).toBe(first);
    auth.consumeBootstrap(first);
    expect(auth.hasActiveSession()).toBe(true);
    expect(auth.refreshBootstrap()).toBeNull();
  });
});

describe("parseCookie", () => {
  it("finds the named cookie among others", () => {
    expect(parseCookie("a=1; session=abc123; b=2", "session")).toBe("abc123");
  });

  it("returns null when the cookie is absent", () => {
    expect(parseCookie("a=1", "session")).toBeNull();
    expect(parseCookie(undefined, "session")).toBeNull();
  });
});
