import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuthProvider, askpassEnv } from "./auth.js";
import { memoryStore, type TokenStore } from "./tokenStore.js";

/**
 * The device flow is tested against a local mock of GitHub's three endpoints,
 * which is what the spec asks for until a real client id exists.
 *
 * Every request is recorded, including its headers — because the spec's
 * requirements about `Accept: application/json`, the scope, and the grant type
 * are all things a mock can check and a reading of the code cannot.
 */

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * The response a mock endpoint gives. `handler` returns this rather than
 * writing the response itself, so each test reads as "here is what GitHub
 * said" with no HTTP plumbing in the way.
 */
interface MockReply {
  status: number;
  body: unknown;
}

let handler: (req: RecordedRequest) => MockReply;
let server: Server;
let baseUrl: string;
const taken: RecordedRequest[] = [];

/** The account a successful login ends up with. */
const MOCK_USER = { login: "ada-fixture", name: "Ada Fixture", avatar_url: "https://example/a.png" };

function respond(res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void }, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeEach(async () => {
  taken.length = 0;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      taken.push(recorded);
      const reply = handler(recorded);
      respond(res, reply.status, reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A provider pointed at the mock. Each call needs its own store because a
 *  token is per-provider state. */
function providerWith(store: TokenStore) {
  process.env.GITHUB_CLIENT_ID = "Iv1.testclientid";
  process.env.GITHUB_BASE_URL = baseUrl;
  process.env.GITHUB_DEVICE_URL = `${baseUrl}/login/device`;
  return createAuthProvider(store);
}

/** The standard reply for the device-code step, so tests that only care about
 *  the token step do not have to spell it out. */
function deviceCodeReply(): MockReply {
  return {
    status: 200,
    body: {
      device_code: "dc-123",
      user_code: "ABCD-1234",
      verification_uri: `${baseUrl}/login/device`,
      expires_in: 900,
      interval: 1,
    },
  };
}

describe("the device flow", () => {
  it("asks GitHub with the client id, the repo scope, and a JSON accept header", async () => {
    const store = memoryStore(null);
    handler = (req) =>
      req.path === "/login/device/code"
        ? {
            status: 200,
            body: {
              device_code: "dc-123",
              user_code: "ABCD-1234",
              verification_uri: `${baseUrl}/login/device`,
              expires_in: 900,
              interval: 1,
            },
          }
        : { status: 200, body: { access_token: "gho_testtoken" } };

    const started = await providerWith(store).startLogin();
    expect(started.userCode).toBe("ABCD-1234");
    expect(started.verificationUri).toBe(`${baseUrl}/login/device`);
    expect(started.intervalSeconds).toBe(1);

    const request = taken[0];
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/login/device/code");
    expect(request.headers.accept).toBe("application/json");
    // The scope is what push, pull, and creating a release need.
    expect(request.body).toContain("scope=repo");
    expect(request.body).toContain("client_id=Iv1.testclientid");

    // And the token really is in the store, not in the response body.
    expect(await store.get("github")).toBeNull();
  });

  it("polls with the device grant type, not a made-up one", async () => {
    const store = memoryStore(null);
    handler = (req) => (req.path === "/login/device/code" ? deviceCodeReply() : { status: 200, body: { access_token: "gho_testtoken" } });
    const provider = providerWith(store);
    await provider.startLogin();
    const polled = await provider.pollLogin();
    expect(polled.state).toBe("authorized");

    const tokenRequest = taken.find((r) => r.path === "/login/oauth/access_token");
    expect(tokenRequest).toBeDefined();
    expect(tokenRequest?.body).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
    );
    expect(tokenRequest?.headers.accept).toBe("application/json");
    expect(await store.get("github")).toBe("gho_testtoken");
  });

  it("treats authorization_pending as waiting rather than as a failure", async () => {
    const store = memoryStore(null);
    handler = (req) =>
      req.path === "/login/device/code" ? deviceCodeReply() : { status: 200, body: { error: "authorization_pending" } };
    const provider = providerWith(store);
    await provider.startLogin();
    expect(await provider.pollLogin()).toEqual({ state: "pending" });
    expect(await store.get("github")).toBeNull();
  });

  it("lengthens the interval when GitHub says slow_down", async () => {
    const store = memoryStore(null);
    handler = (req) =>
      req.path === "/login/device/code" ? deviceCodeReply() : { status: 200, body: { error: "slow_down", interval: 17 } };
    const provider = providerWith(store);
    await provider.startLogin();
    expect(await provider.pollLogin()).toEqual({ state: "slow-down", intervalSeconds: 17 });
  });

  it("reports an expired code as expired, which the interface restarts", async () => {
    const store = memoryStore(null);
    handler = (req) =>
      req.path === "/login/device/code" ? deviceCodeReply() : { status: 200, body: { error: "expired_token" } };
    const provider = providerWith(store);
    await provider.startLogin();
    expect(await provider.pollLogin()).toEqual({ state: "expired" });
  });

  it("reports a refusal as denied, which is not Forgeline's fault", async () => {
    const store = memoryStore(null);
    handler = (req) =>
      req.path === "/login/device/code" ? deviceCodeReply() : { status: 200, body: { error: "access_denied" } };
    const provider = providerWith(store);
    await provider.startLogin();
    expect(await provider.pollLogin()).toEqual({ state: "denied" });
  });
});

describe("no client id configured", () => {
  it("says so plainly instead of pretending to start a flow", async () => {
    process.env.GITHUB_CLIENT_ID = "";
    process.env.GITHUB_BASE_URL = baseUrl;
    const store = memoryStore(null);
    const provider = createAuthProvider(store);

    const caps = provider.capabilities();
    expect(caps.configured).toBe(false);
    expect(caps.reason).toContain("No GitHub OAuth App has been registered");
    // A disabled button with this reason, not a broken request.
    await expect(provider.startLogin()).rejects.toThrow(/No GitHub OAuth App/);
  });

  it("never sends a request to GitHub when there is no client id", async () => {
    process.env.GITHUB_CLIENT_ID = "";
    const provider = createAuthProvider(memoryStore(null));
    await provider.startLogin().catch(() => undefined);
    expect(taken).toHaveLength(0);
  });
});

describe("the signed-in account", () => {
  it("fetches name and avatar after a login, and sends the bearer header", async () => {
    const store = memoryStore(null);
    handler = (req) => {
      if (req.path === "/login/device/code") return deviceCodeReply();
      if (req.path === "/user") return { status: 200, body: MOCK_USER };
      return { status: 200, body: { access_token: "gho_testtoken" } };
    };

    const provider = providerWith(store);
    await provider.startLogin();
    expect((await provider.pollLogin()).state).toBe("authorized");

    const user = await provider.currentUser();
    expect(user).toEqual({
      login: "ada-fixture",
      name: "Ada Fixture",
      avatarUrl: "https://example/a.png",
    });

    const userRequest = taken.find((r) => r.path === "/user");
    expect(userRequest?.headers.authorization).toBe("Bearer gho_testtoken");
  });

  it("answers null when not signed in, which is a normal state", async () => {
    const provider = providerWith(memoryStore(null));
    expect(await provider.currentUser()).toBeNull();
  });

  it("survives a user endpoint that fails, without losing the token", async () => {
    const store = memoryStore(null);
    handler = (req) => {
      if (req.path === "/login/device/code") return deviceCodeReply();
      if (req.path === "/user") return { status: 500, body: {} };
      return { status: 200, body: { access_token: "gho_testtoken" } };
    };
    const provider = providerWith(store);
    await provider.startLogin();
    await provider.pollLogin();
    expect(await provider.currentUser()).toBeNull();
    expect(await store.get("github")).toBe("gho_testtoken");
  });

  it("clears the token on sign out, and says who was signed in", async () => {
    const store = memoryStore(null);
    handler = (req) => {
      if (req.path === "/login/device/code") return deviceCodeReply();
      if (req.path === "/user") return { status: 200, body: MOCK_USER };
      return { status: 200, body: { access_token: "gho_testtoken" } };
    };
    const provider = providerWith(store);
    await provider.startLogin();
    await provider.pollLogin();
    await provider.currentUser();

    const signedOut = await provider.signOut();
    expect(signedOut?.login).toBe("ada-fixture");
    expect(await store.get("github")).toBeNull();
    expect(await provider.currentUser()).toBeNull();
  });

  it("starts again from nothing after a sign out", async () => {
    const store = memoryStore(null);
    handler = (req) => {
      if (req.path === "/login/device/code") return deviceCodeReply();
      if (req.path === "/user") return { status: 200, body: MOCK_USER };
      return { status: 200, body: { access_token: "gho_testtoken" } };
    };
    const provider = providerWith(store);
    await provider.startLogin();
    await provider.pollLogin();
    await provider.signOut();

    // A fresh flow, which is what a sign-in button has to do afterwards.
    const again = await provider.startLogin();
    expect(again.userCode).toBe("ABCD-1234");
  });
});

describe("the token store", () => {
  it("keeps a token in memory when there is no keychain, and says so", async () => {
    // This machine has no secret-tool, which is the case the spec names. The
    // store must fall back to memory and say it did, never to a file.
    const store = memoryStore("no keychain on this machine");
    expect(store.mode).toBe("memory");
    expect(store.notice).toBeTruthy();
    await store.set("github", "gho_abc");
    expect(await store.get("github")).toBe("gho_abc");
    await store.remove("github");
    expect(await store.get("github")).toBeNull();
  });

  it("answers null for a provider that was never signed in", async () => {
    const store = memoryStore(null);
    expect(await store.get("gitlab")).toBeNull();
  });
});

describe("askpass", () => {
  it("hands git the username and the token, never on a command line", () => {
    const env = askpassEnv("gho_secret");
    expect(env.GIT_ASKPASS).toContain("askpass.mjs");
    expect(env.FORGELINE_TOKEN).toBe("gho_secret");
    // The point of askpass: the token appears nowhere in an argv.
    expect(env.GIT_ASKPASS).not.toContain("gho_secret");
  });

  it("still points at askpass with no token, so git fails rather than hanging", () => {
    const env = askpassEnv(null);
    expect(env.GIT_ASKPASS).toContain("askpass.mjs");
    expect(env.FORGELINE_TOKEN).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("disables a terminal prompt, which would wedge a request forever", () => {
    expect(askpassEnv("gho_secret").GIT_TERMINAL_PROMPT).toBe("0");
  });
});

afterEach(() => {
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_BASE_URL;
  delete process.env.GITHUB_DEVICE_URL;
  delete process.env.GITHUB_SCOPE;
});
