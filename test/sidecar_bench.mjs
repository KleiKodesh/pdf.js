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

// Sidecar build time/size and direct search vs. the getTextContent text that
// PDFFindController searches, straight on the core sources (no build needed).
// Usage: node test/sidecar_bench.mjs <file.pdf> <query> [<query> ...]

import {
  buildMatcher,
  countMatches,
  normalizeText,
} from "../src/core/sidecar_find.js";
import { LocalPdfManager } from "../src/core/pdf_manager.js";
import { PdfSidecar } from "../src/core/pdf_sidecar.js";
import { readFileSync } from "node:fs";
import { serialize } from "node:v8";
import { setVerbosityLevel } from "../src/shared/util.js";
import { WorkerTask } from "../src/core/worker.js";

setVerbosityLevel(0);
// The built lib polyfills this; running the sources on Node needs it too.
Math.sumPrecise ??= values => values.reduce((a, b) => a + b, 0);
const [file, ...queries] = process.argv.slice(2);
const handler = { send() {}, sendWithPromise: async () => null, on() {} };
const bytes = new Uint8Array(readFileSync(file));

async function open() {
  const pm = new LocalPdfManager({
    source: bytes,
    evaluatorOptions: { ignoreErrors: true, isOffscreenCanvasSupported: false },
    handler,
    docId: "bench",
  });
  await pm.ensureDoc("checkHeader");
  await pm.ensureDoc("parseStartXRef");
  await pm.ensureDoc("parse");
  return pm;
}

const task = new WorkerTask("bench");
const ms = t => Math.round(performance.now() - t);

// Sidecar build (fresh document, so fonts are parsed here once).
let pm = await open();
const numPages = pm.pdfDocument.numPages;
const sidecar = new PdfSidecar(pm);
let t = performance.now();
await sidecar.build({ fromPage: 0, maxPages: numPages }, handler, task);
const buildMs = ms(t);
const data = serialize(sidecar.data);
console.log(
  `FILE ${file.split(/[\/]/).pop()} pages=${numPages} ` +
    `bytes=${bytes.length} sidecarBuildMs=${buildMs} ` +
    `sidecarBytes=${data.length} fonts=${sidecar.data.fonts.length}`
);

// PDFFindController's first search: getTextContent of every page (fresh doc).
pm = await open();
t = performance.now();
const texts = [];
for (let i = 0; i < numPages; i++) {
  const page = await pm.getPage(i);
  const parts = [];
  const sink = {
    enqueue(c) {
      for (const x of c.items) {
        parts.push((x.str ?? "") + (x.hasEOL ? "\n" : ""));
      }
    },
    desiredSize: Infinity,
    ready: Promise.resolve(),
  };
  await page.extractTextContent({
    handler,
    task,
    sink,
    disableNormalization: true,
  });
  texts.push(parts.join(""));
}
const extractMs = ms(t);
console.log(`  getTextContentAllPagesMs=${extractMs}`);

// Direct search on a fresh document fed with the stored sidecar.
pm = await open();
const direct = new PdfSidecar(pm);
direct.load(structuredClone(sidecar.data));
for (const q of queries) {
  const re = buildMatcher(q, {});
  t = performance.now();
  const refCounts = texts.map(s => countMatches(normalizeText(s), re, false));
  const findMatchMs = ms(t);
  t = performance.now();
  const r1 = await direct.search(
    { query: q, fromPage: 0, maxPages: numPages },
    handler,
    task
  );
  const firstMs = ms(t);
  t = performance.now();
  await direct.search(
    { query: q, fromPage: 0, maxPages: numPages },
    handler,
    task
  );
  const repeatMs = ms(t);
  const counts = new Array(numPages).fill(0);
  for (const h of r1.hits) {
    counts[h.pageIndex] = h.count;
  }
  const same = counts.filter((c, i) => c === refCounts[i]).length;
  const label = [...q]
    .map(c => (c.charCodeAt(0) > 127 ? `U+${c.charCodeAt(0).toString(16)}` : c))
    .join("");
  console.log(
    `  QUERY "${label}" refHits=${refCounts.reduce((a, b) => a + b, 0)} ` +
      `refPages=${refCounts.filter(Boolean).length} ` +
      `directHits=${counts.reduce((a, b) => a + b, 0)} directPages=${r1.hits.length} ` +
      `pagesSame=${same}/${numPages} directFirstMs=${firstMs} ` +
      `directRepeatMs=${repeatMs} findFirstMs=${extractMs + findMatchMs} ` +
      `findRepeatMs=${findMatchMs}`
  );
}
