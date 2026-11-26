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

import {
  buildMatcher,
  countMatches,
  normalizeText,
} from "../../src/core/sidecar_find.js";
import { buildGetDocumentParams } from "./test_utils.js";
import { getDocument } from "../../src/display/api.js";

// Reference: the page string PDFFindController builds from getTextContent.
async function referenceTexts(pdfDocument) {
  const texts = [];
  for (let i = 1; i <= pdfDocument.numPages; i++) {
    const page = await pdfDocument.getPage(i);
    const { items } = await page.getTextContent({ disableNormalization: true });
    texts.push(items.map(x => x.str + (x.hasEOL ? "\n" : "")).join(""));
  }
  return texts;
}

function referenceCounts(texts, query, opts = {}) {
  const re = buildMatcher(query, opts);
  return texts.map(t =>
    countMatches(normalizeText(t, opts.matchDiacritics), re, opts.entireWord)
  );
}

async function directCounts(pdfDocument, query, opts = {}, batch = 3) {
  const counts = new Array(pdfDocument.numPages).fill(0);
  let fromPage = 0,
    reachedEnd = false;
  while (!reachedEnd) {
    const r = await pdfDocument.searchDirect({
      query,
      fromPage,
      maxPages: batch,
      ...opts,
    });
    for (const { pageIndex, count } of r.hits) {
      counts[pageIndex] = count;
    }
    expect(r.nextPage).toBeGreaterThan(fromPage);
    ({ nextPage: fromPage, reachedEnd } = r);
  }
  return counts;
}

describe("pdf_sidecar", function () {
  const CASES = [
    ["tracemonkey.pdf", ["trace", "the", "JavaScript", "loop", "type"]],
    ["ArabicCIDTrueType.pdf", ["م", "ال"]],
    ["basicapi.pdf", ["Trace", "the"]],
    // Type3 fonts, vertical and mixed-length CMaps.
    ["Type3WordSpacing.pdf", ["a", "e"]],
    ["type3_advance.pdf", ["a", "e"]],
    ["vertical.pdf", ["一", "a"]],
    ["perf_text_cmap_mixed.pdf", ["a", "e"]],
  ];

  for (const [file, queries] of CASES) {
    it(`finds the same pages and counts as getTextContent: ${file}`, async function () {
      const loadingTask = getDocument(buildGetDocumentParams(file));
      const pdfDocument = await loadingTask.promise;
      const texts = await referenceTexts(pdfDocument);
      const options = [
        {},
        { caseSensitive: true },
        { entireWord: true },
        { matchDiacritics: true },
      ];
      for (const q of queries) {
        for (const opts of options) {
          expect(await directCounts(pdfDocument, q, opts))
            .withContext(`${file} "${q}" ${JSON.stringify(opts)}`)
            .toEqual(referenceCounts(texts, q, opts));
        }
      }
      await loadingTask.destroy();
    });
  }

  it("builds in steps and round-trips through storage", async function () {
    const params = buildGetDocumentParams("tracemonkey.pdf");
    let loadingTask = getDocument(params);
    let pdfDocument = await loadingTask.promise;

    let step = await pdfDocument.buildSidecar({ fromPage: 0, maxPages: 5 });
    expect(step).toEqual({ nextPage: 5, reachedEnd: false, complete: false });
    while (!step.reachedEnd) {
      step = await pdfDocument.buildSidecar({
        fromPage: step.nextPage,
        maxPages: 5,
      });
    }
    expect(step.complete).toEqual(true);

    const data = await pdfDocument.getSidecar();
    expect(data.v).toEqual(1);
    expect(data.pages.length).toEqual(14);
    for (const page of data.pages) {
      expect(page.c.length).toBeGreaterThan(0);
      for (const [num, gen, start, length, filters] of page.c) {
        expect(num).toBeGreaterThan(0);
        expect(gen).toBeGreaterThanOrEqual(0);
        expect(start).toBeGreaterThan(0);
        expect(length).toBeGreaterThan(0);
        expect(Array.isArray(filters)).toEqual(true);
      }
    }
    expect(data.fonts.length).toBeGreaterThan(0);
    const expected = await directCounts(pdfDocument, "trace");
    await loadingTask.destroy();

    // A new load fed with the stored sidecar: nothing is rebuilt.
    loadingTask = getDocument(params);
    pdfDocument = await loadingTask.promise;
    expect(await pdfDocument.setSidecar(structuredClone(data))).toEqual(true);
    const r = await pdfDocument.searchDirect({
      query: "trace",
      fromPage: 0,
      maxPages: 100,
    });
    expect(r.built).toEqual([]);
    expect(r.reachedEnd).toEqual(true);
    const counts = new Array(14).fill(0);
    for (const { pageIndex, count } of r.hits) {
      counts[pageIndex] = count;
    }
    expect(counts).toEqual(expected);
    expect(await pdfDocument.setSidecar({ v: 0 })).toEqual(false);
    await loadingTask.destroy();
  });
});
