// Interleaved A/B/..: one run of each variant in turn (rotating the order), so the machine's
// load hits every variant alike; prints the medians. Usage: node ab.mjs <book> <rounds> '<variants json>'
// variants: [{ name, port, opts }]
import { execFileSync } from "node:child_process";

const [book, rounds, json] = process.argv.slice(2);
const variants = JSON.parse(json);
const res = Object.fromEntries(variants.map(v => [v.name, []]));
const flat = r => {
  const f = {};
  for (const [k, v] of Object.entries(r)) {
    if (v && typeof v === "object") {
      for (const [k2, v2] of Object.entries(v)) {
        f[k + "." + k2] = v2;
      }
    } else {
      f[k] = v;
    }
  }
  return f;
};
// Bytes check (random access): a session may read only the pages it touched (rendered, plus
// the read-ahead around them) and the document's skeleton - never the whole file.
import { statSync } from "node:fs";
let bad = 0;
function checkBytes(name, rec) {
  const size = statSync(`${process.env.BOOKS}/${book}.pdf`).size;
  const touched = new Set();
  for (const n of rec.rendered) {
    for (let k = n - 1; k <= n + 1; k++) {
      if (k >= 1 && k <= rec.cold.pages) {
        touched.add(k);
      }
    }
  }
  // Skeleton (header, xref, catalog, page tree, fonts) + the touched pages at
  // the book's average page size, with room for part rounding.
  const allowed = Math.round((3 << 19) + touched.size * (size / rec.cold.pages) * 1.5);
  const ok = rec.bytesTotal <= allowed && rec.bytesTotal < size;
  if (!ok) {
    bad++;
  }
  console.log(
    `BYTES ${ok ? "OK" : "TOO MANY"} ${book} ${name} read=${rec.bytesTotal} allowed=${allowed} ` +
      `file=${size} rendered=${rec.rendered.length} pages`
  );
}
for (let i = 0; i < +rounds; i++) {
  for (let j = 0; j < variants.length; j++) {
    const v = variants[(i + j) % variants.length];
    try {
      const out = execFileSync(
        "node",
        [
          new URL("drive.mjs", import.meta.url).pathname.replace(
            /^\/(\w:)/,
            "$1"
          ),
          JSON.stringify({ ...v.opts, book }),
        ],
        {
          encoding: "utf8",
          timeout: 300000,
          env: { ...process.env, PORT: String(v.port) },
        }
      );
      const rec = JSON.parse(out.trim().split("\n").pop());
      if (v.bytesCheck) {
        checkBytes(v.name, rec);
      }
      res[v.name].push(flat(rec));
    } catch (e) {
      console.log("FAIL", v.name, String(e.stdout || e).slice(0, 300));
    }
  }
}
const med = a => {
  const s = a.filter(x => typeof x === "number").sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
for (const v of variants) {
  const r = res[v.name];
  console.log(
    `RESULT ${book} ${v.name.padEnd(14)} n=${r.length} ` +
      [
        "cold.image1",
        "cold.bytes",
        "jumpMid",
        "fling.img",
        "jumpEnd",
        "warm.image1",
        "bytesTotal",
      ]
        .map(k => `${k}=${med(r.map(x => x[k]))}`)
        .join(" ")
  );
}
process.exitCode = bad ? 1 : 0;
