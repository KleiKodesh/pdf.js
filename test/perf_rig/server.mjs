// Serves the rig page, a pdfjs-dist-like build (DIST) and the test books (BOOKS dir) like the
// app's host: /pdf/wv2/<book>.pdf answers Range with 206 + Content-Range, a plain GET chunked
// with no Content-Length / Accept-Ranges (WebView2's mapping). Usage: PORT= DIST= BOOKS= node server.mjs
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = import.meta.dirname;
const { DIST, BOOKS, PORT = "5291" } = process.env;
const types = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".wasm": "application/wasm",
  ".json": "application/json",
};
let served = 0; // PDF bytes sent since the last /bytes?reset
http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/bytes") {
      if (u.searchParams.has("reset")) {
        served = 0;
      }
      res.end(JSON.stringify({ bytes: served }));
      return;
    }
    const m = u.pathname.match(/^\/pdf\/(full|wv2)\/([\w-]+)\.pdf$/);
    if (m) {
      const f = path.join(BOOKS, m[2] + ".pdf");
      const size = fs.statSync(f).size;
      const range = req.headers.range;
      const h = {
        "Content-Type": "application/pdf",
        "Cache-Control": "no-store",
      };
      if (range) {
        const [, a, b] = range.match(/bytes=(\d+)-(\d*)/);
        const s = +a,
          e = b ? Math.min(+b, size - 1) : size - 1;
        res.writeHead(206, {
          ...h,
          "Content-Range": `bytes ${s}-${e}/${size}`,
          "Content-Length": e - s + 1,
        });
        served += e - s + 1;
        fs.createReadStream(f, { start: s, end: e }).pipe(res);
        return;
      }
      res.writeHead(200, h);
      served += size;
      fs.createReadStream(f).pipe(res);
      return;
    }
    const file = u.pathname.startsWith("/dist/")
      ? path.join(DIST, u.pathname.slice(6))
      : u.pathname.startsWith("/books/")
        ? path.join(BOOKS, u.pathname.slice(7))
        : path.join(HERE, u.pathname === "/" ? "h.html" : u.pathname);
    fs.readFile(file, (err, d) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
      });
      res.end(d);
    });
  })
  .listen(+PORT, "127.0.0.1", () => console.log("up", PORT));
