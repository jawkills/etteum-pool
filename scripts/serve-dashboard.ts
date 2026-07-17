#!/usr/bin/env bun
/**
 * Lightweight static file server for dashboard/dist.
 * Also reverse-proxies /api, /v1, /ws to the backend so the browser
 * stays same-origin (avoids "Invalid API key" from failed cross-port fetch).
 *
 * Usage:
 *   bun run scripts/serve-dashboard.ts
 *
 * Env:
 *   DASHBOARD_PORT (default: 1931)
 *   PORT / BACKEND_PORT (default: 1930)
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.DASHBOARD_PORT) || 1931;
const backendPort = Number(process.env.PORT || process.env.BACKEND_PORT) || 1930;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const distDir = fileURLToPath(new URL("../dashboard/dist", import.meta.url));
const indexFile = join(distDir, "index.html");

if (!(await Bun.file(indexFile).exists())) {
  console.error("[dashboard] dashboard/dist not found. Run: cd dashboard && bun run build");
  process.exit(1);
}

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function getMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return mimeTypes[ext] || "application/octet-stream";
}

function shouldProxy(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/v1/") ||
    pathname === "/api" ||
    pathname === "/v1" ||
    pathname.startsWith("/ws")
  );
}

async function proxyToBackend(req: Request, url: URL): Promise<Response> {
  const target = `${backendOrigin}${url.pathname}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

  try {
    const init: RequestInit = {
      method: req.method,
      headers,
      redirect: "manual",
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = await req.arrayBuffer();
    }
    return await fetch(target, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `Backend unreachable: ${message}` }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (shouldProxy(pathname)) {
      return proxyToBackend(req, url);
    }

    let filePath = join(distDir, pathname);
    let file = Bun.file(filePath);

    if (pathname !== "/" && (await file.exists())) {
      return new Response(file, {
        headers: { "Content-Type": getMimeType(pathname) },
      });
    }

    if (!pathname.includes(".")) {
      const dirIndex = join(distDir, pathname, "index.html");
      file = Bun.file(dirIndex);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    return new Response(Bun.file(indexFile), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`[dashboard] Serving production build on http://localhost:${port}`);
console.log(`[dashboard] Proxying /api /v1 /ws → ${backendOrigin}`);
