/* Copyright 2026 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Text indexes (FM: web/pdf_text_index.js, inverted: web/pdf_term_index.js;
// INDEXES=fm,terms picks them): size, build/load time, search time
// and PARITY against the real PDFFindController on the same page texts, with
// and without the index (the adapter), straight on the sources. Usage:
//   node test/text_index_bench.mjs <file.pdf | synthetic> [<query> ...]
// Built-in queries are added; QUERIES_ONLY=1 uses only the given ones;
// CHUNK_PAGES sets the pages per index chunk (default 16).

import { register } from "node:module";

// The web modules use a few DOM globals at load time only.
globalThis.window ??= { requestAnimationFrame: f => setTimeout(f, 0) };
globalThis.document ??= {
  documentElement: { style: {} },
  createElement: () => ({ style: {}, classList: { add() {} }, append() {} }),
};
// "pdfjs-lib" is the built library in the viewer; the find code needs only
// helpers from src/shared/util.js.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(spec, ctx, next) {
        if (spec === "pdfjs-lib") {
          return next(new URL("../src/shared/util.js", ${JSON.stringify(import.meta.url)}).href, ctx);
        }
        return next(spec, ctx);
      }`)
);

const { deflateRawSync, inflateRawSync } = await import("node:zlib");
const { readFileSync, statSync } = await import("node:fs");
const { LocalPdfManager } = await import("../src/core/pdf_manager.js");
const { setVerbosityLevel } = await import("../src/shared/util.js");
const { WorkerTask } = await import("../src/core/worker.js");
const { EventBus } = await import("../web/event_utils.js");
const { PDFFindController } = await import("../web/pdf_find_controller.js");
const { PdfTextIndex } = await import("../web/pdf_text_index.js");
const { PdfTermIndex } = await import("../web/pdf_term_index.js");
globalThis.requestIdleCallback ??= f => setTimeout(() => f(null), 0);

setVerbosityLevel(0);
Math.sumPrecise ??= values => values.reduce((a, b) => a + b, 0);
const [file, ...userQueries] = process.argv.slice(2);
const u = s =>
  s.replaceAll(/\\u([0-9a-fA-F]{4})/g, (m, h) =>
    String.fromCharCode(parseInt(h, 16))
  );
const BUILTIN = [
  // Hebrew: rare/common words, phrases, partial words, nikud, punctuation.
  "\\u05d0\\u05de\\u05e8", // amar
  "\\u05e8\\u05d1\\u05d9", // rabbi
  "\\u05d0\\u05de\\u05e8 \\u05e8\\u05d1", // phrase
  "\\u05d1\\u05d9\\u05ea \\u05d3\\u05d9\\u05df", // phrase
  "\\u05d4\\u05dc\\u05db\\u05d4", // halacha
  "\\u05de\\u05d5\\u05e2\\u05d3", // moed
  "\\u05d9\\u05d1\\u05de\\u05d4", // yevama
  "\\u05e7\\u05e9\\u05d9\\u05d0", // kashya
  "\\u05dc\\u05d0", // 2 letters, very common
  "\\u05d5", // 1 letter
  "\\u05de\\u05e9\\u05e0\\u05d4", // mishna
  "\\u05d1\\u05bc\\u05b0\\u05e8\\u05b5\\u05d0\\u05e9\\u05c1\\u05b4\\u05d9\\u05ea", // nikud
  "\\u05e9\\u05c1\\u05b8\\u05dc\\u05d5\\u05b9\\u05dd", // nikud
  "\\u05e8\\u05d1\\u05d9 \\u05d9\\u05d5\\u05d7\\u05e0\\u05df", // phrase
  "\\u05d2\\u05de\\u05f3", // geresh
  "\\u05e2\\u05de\\u05d5\\u05d3", // amud
  "\\u05d3\\u05e3 \\u05d1", // daf b
  "\\u05d6\\u05e7\\u05d6\\u05d5\\u05e7", // rare
  // Latin, numbers, punctuation.
  "the",
  "The",
  "and",
  "a",
  "trace tree",
  "JavaScript",
  "1",
  "12",
  "2007",
  "page",
  "e.g.",
  "zebra",
  "-",
  ":",
  "\\u05d0.",
].map(u);

// "synthetic": hand-made pages with the tricky cases of PDFFindController's
// normalize() and regexps (case foldings, marks after non-letters, "-\n"
// joins, fractions, spacing around punctuation, Hangul, astral chars).
const SYNTHETIC = file === "synthetic";
const SYNTH_PAGES = [
  [
    "Stra\\u00dfe STRASSE stra\\u1e9ee \\u017fun SUN sun \\u212aelvin kelvin",
    "\\u03a3\\u03bf\\u03c6\\u03b9\\u03b1 \\u03c3\\u03bf\\u03c6\\u03b9\\u03b1\\u03c2 \\u03c2",
  ],
  [
    "1\\u0301 2\\u0302 a\\u0301b a b a  b a\\u00a0b",
    "-\\u0301x \\u05d0\\u05b8\\u05de\\u05b7\\u05e8 \\u05d0\\u05de\\u05e8",
  ],
  [
    "hyph-",
    "enated end-",
    "Of line x-",
    "\\u00bd \\u00bc 1/2 1 / 2 e.g. e . g . a,b a , b",
  ],
  [
    "\\ud55c\\uad6d\\uc5b4 \\u1112\\u1161\\u11ab",
    "\\ud835\\udc00\\ud835\\udc01 \\ud835\\udc00 aaaa aaa",
    "\\u201cquote\\u201d 'x' \\u2018y\\u2019",
  ],
  [
    "\\u0130stanbul istanbul ISTANBUL \\u0131",
    "\\u0915\\u094d\\u0937 \\u0915\\u0937",
    "\\u05d1\\u05bc\\u05b0\\u05e8\\u05b5\\u05d0\\u05e9\\u05c1\\u05b4\\u05d9\\u05ea \\u05d1\\u05e8\\u05d0\\u05e9\\u05d9\\u05ea",
  ],
  ["", "   ", "x"],
].map(lines =>
  lines.map((str, i) => ({ str: u(str), hasEOL: i < lines.length - 1 }))
);
// A "fake bold" page: each word drawn twice at (almost) the same place.
{
  const at = (str, x, y, hasEOL = false) => ({
    str,
    hasEOL,
    transform: [10, 0, 0, 10, x, y],
  });
  SYNTH_PAGES.push([
    at("bold", 10, 700),
    at("bold", 10.3, 700),
    at(" word", 40, 700),
    at(" word", 40.2, 700.1, true),
    at("abc", 10, 680),
    at("abc", 10, 680),
    at("def", 40, 680),
  ]);
}
const SYNTH_QUERIES = [
  "bold",
  "bold word",
  "boldbold",
  "abcdef",
  "abcabc",
  "word",
  "strasse",
  "Stra\\u00dfe",
  "stra\\u1e9ee",
  "sun",
  "\\u017f",
  "kelvin",
  "\\u212a",
  "\\u03c3\\u03bf\\u03c6\\u03b9\\u03b1",
  "\\u03c2",
  "\\u03a3",
  "2",
  "a b",
  "ab",
  "a  b",
  "x",
  "\\u05d0\\u05b8\\u05de\\u05b7\\u05e8",
  "hyphenated",
  "endOf",
  "end-Of",
  "x-",
  "1/2",
  "\\u00bd",
  "1 / 2",
  "e . g",
  "a,b",
  "a , b",
  ",",
  "\\ud55c\\uad6d",
  "\\u1112",
  "\\ud835\\udc00",
  "aa",
  "aaa",
  "quote",
  '"quote"',
  "'x'",
  "y",
  "istanbul",
  "\\u0130",
  "\\u0131",
  "I",
  "\\u0915\\u0937",
  "\\u0915\\u094d\\u0937",
  "\\u05d1\\u05e8\\u05d0\\u05e9\\u05d9\\u05ea",
  " x",
  "x ",
  "a  ",
].map(u);

let queries = [...BUILTIN, ...userQueries.map(u)];
if (SYNTHETIC) {
  queries = [...BUILTIN, ...SYNTH_QUERIES];
} else if (process.env.QUERIES_ONLY) {
  queries = userQueries.map(u);
}
const OPTIONS = [
  {},
  { caseSensitive: true },
  { entireWord: true },
  { matchDiacritics: true },
];
const handler = { send() {}, sendWithPromise: async () => null, on() {} };
const task = new WorkerTask("bench");
const ms = t => +(performance.now() - t).toFixed(1);
const label = q =>
  [...q]
    .map(c =>
      c.codePointAt(0) > 127 ? `U+${c.codePointAt(0).toString(16)}` : c
    )
    .join("");

async function open() {
  const pm = new LocalPdfManager({
    source: new Uint8Array(readFileSync(file)),
    evaluatorOptions: { ignoreErrors: true, isOffscreenCanvasSupported: false },
    handler,
    docId: "bench",
  });
  await pm.ensureDoc("checkHeader");
  await pm.ensureDoc("parseStartXRef");
  await pm.ensureDoc("parse");
  return pm;
}

// The text content of every page (what both PDFFindController and the index
// build start from).
const pm = SYNTHETIC ? null : await open();
const numPages = SYNTHETIC ? SYNTH_PAGES.length : pm.pdfDocument.numPages;
let t = performance.now();
const contents = SYNTHETIC ? SYNTH_PAGES.map(items => ({ items })) : [];
for (let i = 0; !SYNTHETIC && i < numPages; i++) {
  const page = await pm.getPage(i);
  const items = [];
  const sink = {
    enqueue(c) {
      for (const x of c.items) {
        if (x.str !== undefined) {
          items.push({ str: x.str, hasEOL: x.hasEOL, transform: x.transform });
        }
      }
    },
    desiredSize: Infinity,
    ready: Promise.resolve(),
  };
  try {
    await page.extractTextContent({
      handler,
      task,
      sink,
      disableNormalization: true,
    });
  } catch {}
  contents.push({ items });
}
const extractMs = ms(t);

// Build in chunks (the viewer's idle steps).
const CHUNK = +(process.env.CHUNK_PAGES || 16);
const raw = contents.map(c => PdfTextIndex.pageString(c));
const chars = raw.reduce((a, s) => a + s.length, 0);
const pdfBytes = SYNTHETIC ? 1 : statSync(file).size;
const name = file.split(/[/\\]/).pop();
const KINDS = { fm: PdfTextIndex, terms: PdfTermIndex };
const indexes = [];
for (const kind of (process.env.INDEXES || "fm,terms").split(",")) {
  const Cls = KINDS[kind];
  const index = new Cls(numPages);
  t = performance.now();
  let maxStepMs = 0;
  for (let p = 0; p < numPages; p += CHUNK) {
    const t1 = performance.now();
    index.addPages(p, raw.slice(p, p + CHUNK));
    maxStepMs = Math.max(maxStepMs, ms(t1));
  }
  const buildMs = ms(t);
  t = performance.now();
  const encoded = index.encode();
  const stored = deflateRawSync(encoded, { level: 9 });
  const encodeMs = ms(t);
  t = performance.now();
  const loaded = Cls.decode(inflateRawSync(stored));
  const loadMs = ms(t);
  console.log(
    `FILE ${name} index=${kind} pages=${numPages} pdfBytes=${pdfBytes} ` +
      `textChars=${chars} getTextContentAllMs=${Math.round(extractMs)} ` +
      `indexBuildMs=${Math.round(buildMs)} maxChunkMs=${Math.round(maxStepMs)} ` +
      `encodeMs=${Math.round(encodeMs)} ` +
      `storedBytes=${stored.length} (${((100 * stored.length) / pdfBytes).toFixed(2)}% of pdf) ` +
      `rawBytes=${encoded.length} memBytes=${loaded.memoryBytes} loadMs=${Math.round(loadMs)}` +
      (loaded.chunks ? ` chunks=${loaded.chunks.length}` : "")
  );
  indexes.push({ kind, loaded });
}
// An index that starts empty and learns pages only from the find controller's
// own extractions (the viewer's no-background mode); shared by every query.
if ((process.env.INDEXES || "fm,terms").includes("terms")) {
  indexes.push({ kind: "grow", loaded: new PdfTermIndex(numPages) });
}

// The reference: PDFFindController itself on the same text contents.
const eventBus = new EventBus();
const linkService = { pagesCount: numPages, page: 1 };
const ctrl = new PDFFindController({ linkService, eventBus, delay: 0 });
ctrl.setDocument({
  numPages,
  getPage: async n => ({ getTextContent: async () => contents[n - 1] }),
});

// The adapter: the same controller with the text index; it extracts only the
// pages the index doesn't rule out. A fresh one per query counts them.
let extracted = 0,
  adapterTotal = 0;
function adapterController(loaded) {
  const bus = new EventBus();
  const c = new PDFFindController({ linkService, eventBus: bus, delay: 0 });
  bus.on("updatefindmatchescount", e => {
    adapterTotal = e.matchesCount.total;
  });
  c.textIndex = loaded;
  c.setDocument({
    numPages,
    // As a random-access document: several pages extracted at once.
    loadingParams: { disableAutoFetch: true },
    getPage: async n => ({
      getTextContent: async () => {
        extracted++;
        return contents[n - 1];
      },
    }),
  });
  return [c, bus];
}

async function refSearch(query, opts, c = ctrl, bus = eventBus) {
  c._pageMatches = []; // so the wait below sees this search only
  bus.dispatch("find", {
    source: null,
    type: "",
    query,
    caseSensitive: false,
    entireWord: false,
    findPrevious: false,
    matchDiacritics: false,
    highlightAll: false,
    ...opts,
  });
  // Done when every page has its (possibly empty) matches array.
  const done = () => {
    const m = c.pageMatches;
    for (let i = 0; i < numPages; i++) {
      if (!m[i]) {
        return false;
      }
    }
    return true;
  };
  do {
    await new Promise(r => {
      setImmediate(r);
    });
  } while (!done());
  return Array.from(
    { length: numPages },
    (_, i) => c.pageMatches[i]?.length ?? 0
  );
}

let bad = 0,
  checked = 0;
const rows = [];
for (const query of queries) {
  for (const opts of OPTIONS) {
    t = performance.now();
    const ref = await refSearch(query, opts);
    const refMs = ms(t);
    const refTotal = ref.reduce((a, b) => a + b, 0);
    const refPos = JSON.stringify([ctrl.pageMatches, ctrl.pageMatchesLength]);

    for (const { kind, loaded } of indexes) {
      const [ac, abus] = adapterController(loaded);
      extracted = adapterTotal = 0;
      t = performance.now();
      await refSearch(query, opts, ac, abus);
      const adapterMs = ms(t);
      const adapterOk =
        JSON.stringify([ac.pageMatches, ac.pageMatchesLength]) === refPos &&
        adapterTotal === refTotal;
      const adapterPages = extracted;

      t = performance.now();
      const res = loaded.search({ query, ...opts });
      const idxMs = ms(t);
      const got = new Array(numPages).fill(0);
      let ok;
      if (res.exact) {
        for (const p of res.pages) {
          got[p.pageIndex] = p.count;
        }
        ok = got.every((c, i) => c === ref[i]);
      } else {
        const cand = new Set([
          ...res.pages.map(p => p.pageIndex),
          ...res.missing,
        ]);
        ok = ref.every((c, i) => !c || cand.has(i));
      }
      checked++;
      if (!adapterOk) {
        ok = false;
        console.log(
          `  ADAPTER MISMATCH ${kind} "${label(query)}" ${JSON.stringify(opts)} ` +
            `total=${adapterTotal}/${refTotal}`
        );
      }
      if (!ok) {
        bad++;
        const diff = [];
        for (let i = 0; i < numPages && diff.length < 5; i++) {
          if (res.exact ? got[i] !== ref[i] : ref[i] && !got[i]) {
            diff.push(`p${i + 1}:${got[i]}/${ref[i]}`);
          }
        }
        console.log(
          `  MISMATCH ${kind} "${label(query)}" ${JSON.stringify(opts)} ${diff.join(" ")}`
        );
      }
      rows.push(
        `  QUERY ${kind} "${label(query)}" ${Object.keys(opts).join(",") || "default"} ` +
          `refHits=${refTotal} refPages=${ref.filter(Boolean).length} ` +
          `index=${res.exact ? "exact" : "candidates"} idxPages=${res.pages.length} ` +
          `idxMs=${idxMs} findMs=${refMs} adapterMs=${adapterMs} ` +
          `adapterExtractedPages=${adapterPages}/${numPages} ` +
          `${ok ? "OK" : "MISMATCH"}`
      );
    }
  }
}
for (const r of rows) {
  console.log(r);
}
console.log(
  `PARITY ${name} ${checked - bad}/${checked} query x option sets OK; ` +
    `PDFFindController first search (getTextContent all pages) ~${Math.round(extractMs)} ms`
);
process.exitCode = bad ? 1 : 0;
