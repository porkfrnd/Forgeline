import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createAuth, parseCookie, type AuthManager } from "./session.js";
import { RepoRegistry } from "./registry.js";
import { resolveRealpath, stillInside } from "./paths.js";

export interface ServerHandle {
  app: Hono;
  server: ReturnType<typeof serve>;
  actualPort: number;
  token: string;
  auth: AuthManager;
  registry: RepoRegistry;
  /** Mint a fresh bootstrap URL (used when the terminal user presses Enter). */
  refreshUrl: () => string | null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function webRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled layout: <pkg>/dist/server/index.js -> web build at <pkg>/dist/web
  return join(here, "..", "web");
}

async function serveStaticFile(root: string, pathname: string): Promise<Response | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const safe = decoded.replace(/^[/\\]+/, "").replace(/\.\./g, "");
  const full = join(root, safe);
  if (!full.startsWith(root)) return null;
  try {
    const info = await stat(full);
    if (!info.isFile()) return null;
    const body = await readFile(full);
    const type = MIME[extname(full).toLowerCase()] ?? "application/octet-stream";
    return new Response(body, { headers: { "Content-Type": type } });
  } catch {
    return null;
  }
}

/** Headers applied to every response so a hostile page cannot frame, sniff, or
 *  leak the referrer. The CSP allows only the app's own origin. */
function securityHeaders(): Record<string, string> {
  return {
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
}

export interface CreateAppOptions {
  auth?: AuthManager;
  registry?: RepoRegistry;
}

export function createApp(getPort: () => number, opts: CreateAppOptions = {}): Hono {
  const auth = opts.auth ?? createAuth();
  const registry = opts.registry ?? new RepoRegistry();
  const app = new Hono();

  app.use("*", async (c, next) => {
    const port = getPort();
    const host = c.req.header("host") ?? "";
    const okHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!okHosts.includes(host)) {
      return c.text("Forbidden: bad host", 403);
    }
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const origin = c.req.header("origin");
      if (origin !== undefined) {
        const okOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
        if (!okOrigins.includes(origin)) {
          return c.text("Forbidden: bad origin", 403);
        }
      }
      const contentType = c.req.header("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        return c.text("Content-Type must be application/json", 415);
      }
    }
    await next();
    for (const [k, v] of Object.entries(securityHeaders())) {
      if (!c.res.headers.has(k)) c.res.headers.set(k, v);
    }
  });

  app.use("/api/*", async (c, next) => {
    const id = parseCookie(c.req.header("cookie"), "session");
    if (c.req.path !== "/api/__test__/bootstrap" && (id === null || !auth.validateSession(id))) {
      return c.text("Unauthorized", 401);
    }
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  // Test-only helper: mint a fresh single-use bootstrap token so each e2e
  // test can exchange its own. Always 404 unless the server was started
  // with FORGELINE_E2E=1, which only the Playwright global setup does.
  app.get("/api/__test__/bootstrap", (c) => {
    if (process.env.FORGELINE_E2E !== "1") {
      return c.text("Not found", 404);
    }
    return c.json({ token: auth.forceBootstrap() });
  });

  // Repo identity: the browser only ever sees opaque IDs. An unknown ID -> 404.
  app.get("/api/repos", (c) => {
    return c.json({ repos: registry.list().map((r) => ({ id: r.id })) });
  });

  // Milestone 2 will register scanned repos server-side. This endpoint exists
  // now so the write-path guards (Origin, Content-Type) have a route to
  // protect and the security tests can exercise them end to end.
  app.post("/api/repos", async (c) => {
    const body = await c.req.json<{ path?: unknown }>();
    if (typeof body.path !== "string" || body.path.length === 0) {
      return c.json({ code: "bad-request", title: "Missing path." }, 400);
    }
    const entry = await registry.register(body.path);
    if (!entry) return c.notFound();
    return c.json({ id: entry.id });
  });

  app.get("/api/repos/:id", (c) => {
    const repo = registry.get(c.req.param("id"));
    if (!repo) return c.notFound();
    return c.json({ id: repo.id });
  });

  app.get("/api/events", (c) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(": connected\n\nretry: 3000\n\n"));
        let open = true;
        const stop = () => {
          if (!open) return;
          open = false;
          try {
            controller.close();
          } catch {
            open = false;
          }
        };
        const signal = c.req.raw.signal;
        if (signal) {
          signal.addEventListener("abort", stop);
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  app.get("*", async (c) => {
    const url = new URL(c.req.url);
    const t = url.searchParams.get("t");
    if (t !== null) {
      // Single-use bootstrap exchange: sets the session cookie and answers 303
      // so the token never lingers in the address bar. A used or expired token
      // is rejected; the page then shows the plain "expired" notice.
      const sessionId = auth.consumeBootstrap(t);
      if (sessionId !== null) {
        url.searchParams.delete("t");
        const target = url.pathname + (url.search ? url.search : "");
        c.header("Cache-Control", "no-store");
        c.header("Set-Cookie", `session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`);
        return c.redirect(target || "/", 303);
      }
      return c.text("This link has expired. Press Enter in the Forgeline terminal for a new one.", 401);
    }
    const root = webRoot();
    const direct = await serveStaticFile(root, url.pathname);
    if (direct) return direct;
    if (!url.pathname.startsWith("/assets/")) {
      const index = await serveStaticFile(root, "/index.html");
      if (index) return index;
    }
    return c.text("Not found", 404);
  });

  return app;
}

export interface StartOptions {
  port: number;
  hostname: string;
  token?: string;
  roots?: string[];
}

export async function startServer(opts: StartOptions): Promise<ServerHandle> {
  const auth = createAuth();
  const token = auth.currentBootstrapToken();
  const registry = new RepoRegistry();
  registry.setRoots(opts.roots ?? []);
  let actualPort = opts.port;
  const app = createApp(() => actualPort, { auth, registry });
  const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.hostname });
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.on("error", onError);
    server.on("listening", onListening);
  });
  const addr = server.address();
  if (addr && typeof addr === "object" && typeof (addr as AddressInfo).port === "number") {
    actualPort = (addr as AddressInfo).port;
  }
  const refreshUrl = (): string | null => {
    const fresh = auth.refreshBootstrap();
    if (fresh === null) return null;
    return `http://localhost:${actualPort}/?t=${fresh}`;
  };
  return { app, server, actualPort, token, auth, registry, refreshUrl };
}

export { resolveRealpath, stillInside };
