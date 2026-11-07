#!/usr/bin/env node
// out/ を手元で配信するだけの小さなサーバー（ブラウザテスト用。127.0.0.1 だけで待ち受ける）。
// Cloudflare Pages と同じく、/routines/edit/ → out/routines/edit/index.html を返す。

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const ROOT = join(process.cwd(), "out");
const PORT = Number(process.env.PORT ?? 4173);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

function resolve(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^([/\\])+/, "");
  const p = join(ROOT, clean);
  if (!p.startsWith(ROOT + sep) && p !== ROOT) return null; // out/ の外は返さない
  if (existsSync(p) && statSync(p).isDirectory()) return join(p, "index.html");
  if (existsSync(p)) return p;
  if (existsSync(`${p}.html`)) return `${p}.html`;
  return null;
}

createServer((req, res) => {
  const file = resolve(req.url ?? "/");
  if (!file || !existsSync(file)) {
    res.writeHead(404, { "Content-Type": TYPES[".html"] });
    res.end(existsSync(join(ROOT, "404.html")) ? readFileSync(join(ROOT, "404.html")) : "not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(readFileSync(file));
}).listen(PORT, "127.0.0.1", () => console.log(`serve-out: http://127.0.0.1:${PORT}`));
