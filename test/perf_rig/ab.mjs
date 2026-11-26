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
import { readFileSync, statSync } from "node:fs";
let bad = 0;
function checkBytes(name, rec) {
  const dir = process.env.BOOKS;
  const map = JSON.parse(readFileSync(`${dir}/${book}.pages.json`, "utf8"));
  const size = statSync(`${dir}/${book}.pdf`).size;
  const touched = new Set();
  for (const n of rec.rendered) {
    for (let k = n - 1; k <= n + 3; k++) {
      if (k >= 1 && k <= map.length) {
        touched.add(k);
      }
    }
  }
  let allowed = 1 << 20; // skeleton: header, xref, catalog, page tree, fonts
  for (const n of touched) {
    const spans = map[n - 1] || [];
    for (let i = 1; i < spans.length; i += 2) {
      allowed += spans[i] + 65536; // + one part of rounding per span
    }
  }
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
