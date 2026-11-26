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

// First search with the search index learning (on) vs without an index (off), alternated in one
// browser per run: time to the first result, to all results, bytes read, and the JS heap peak of
// the page and of the PDF.js worker sampled every 100 ms during the search (index on: until the
// index has taken every page). Usage: PORT= BOOKS= node search.mjs <book> <rounds> <query> <query2>
import puppeteer from "puppeteer";

const [book, rounds, query, query2] = process.argv.slice(2);
const res = { on: [], off: [] };

async function runOnce(index) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME || undefined,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", e => console.error("ERR", e.message));
    await page.goto(`http://127.0.0.1:${process.env.PORT || 5291}/`);
    await page.waitForFunction(() => window.ready);
    let peakMain = 0,
      peakWorker = 0,
      sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try {
          const m = await page.metrics();
          peakMain = Math.max(peakMain, m.JSHeapUsedSize);
          for (const w of page.workers()) {
            const h = await w.client.send("Runtime.getHeapUsage");
            peakWorker = Math.max(peakWorker, h.usedSize);
          }
        } catch {}
        await new Promise(r => setTimeout(r, 100));
      }
    })();
    const r = await page.evaluate(o => searchRun(o), {
      book,
      index,
      query,
      query2,
    });
    sampling = false;
    await sampler;
    return { ...r, peakMain, peakWorker };
  } finally {
    await browser.close();
  }
}

for (let i = 0; i < +rounds; i++) {
  for (const mode of i % 2 ? ["off", "on"] : ["on", "off"]) {
    try {
      res[mode].push(await runOnce(mode === "on"));
    } catch (e) {
      console.log("FAIL", mode, String(e).slice(0, 300));
    }
  }
}
const med = a => {
  const s = a.filter(x => typeof x === "number").sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const keys = [
  "first",
  "all",
  "hits",
  "bytes",
  "peakMain",
  "peakWorker",
  "indexReadyMs",
  "indexMemBytes",
  "indexStoredBytes",
  "secondCandidates",
  "secondIndexMs",
  "secondBytes",
];
for (const mode of ["on", "off"]) {
  console.log(
    `SEARCH ${book} index=${mode} n=${res[mode].length} ` +
      keys
        .map(k => `${k}=${med(res[mode].map(x => x[k]))}`)
        .filter(x => !x.endsWith("=null"))
        .join(" ")
  );
}
