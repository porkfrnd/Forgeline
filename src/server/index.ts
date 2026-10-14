import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { serve } from "@hono/node-server";

export interface ServerHandle {
  app: Hono;
  server: ReturnType<typeof serve>;
  actualPort: number;
  token: string;
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

function isInside(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target === root || target.startsWith(prefix);
}

async function serveStaticFile(root: string, pathname: string): Promise<Response | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const safe = normalize(decoded).replace(/^([/\\])+/, "");
  const full = join(root, safe);
  if (!isInside(root, full)) return null;
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

export function createApp(token: string, getPort: () => number): Hono {
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
      if (!contentType.startsWith("application/json")) {
        return c.text("Content-Type must be application/json", 415);
      }
    }
    await next();
  });

  const requireAuth: MiddlewareHandler = async (c, next) => {
    const cookie = c.req.header("cookie") ?? "";
    if (!cookie.includes(`session=${token}`)) {
      return c.text("Unauthorized", 401);
    }
    await next();
  };

  app.use("/api/*", requireAuth);

  app.get("/api/health", (c) => c.json({ ok: true }));

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
    if (t !== null && t === token) {
      url.searchParams.delete("t");
      const target = url.pathname + (url.search ? url.search : "");
      return new Response(null, {
        status: 302,
        headers: {
          Location: target || "/",
          "Set-Cookie": `session=${token}; HttpOnly; SameSite=Strict; Path=/`,
        },
      });
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
}

export async function startServer(opts: StartOptions): Promise<ServerHandle> {
  const token = opts.token ?? randomBytes(32).toString("base64url");
  let actualPort = opts.port;
  const app = createApp(token, () => actualPort);
  const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.hostname });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.on("error", onError);
    server.on("listening", onListening);
  });
  const addr = server.address();
  if (addr && typeof addr === "object" && typeof (addr as AddressInfo).port === "number") {
    actualPort = (addr as AddressInfo).port;
  }
  return { app, server, actualPort, token };
}
