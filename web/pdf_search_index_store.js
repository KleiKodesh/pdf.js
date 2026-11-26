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

/**
 * Stores each PDF's search index (pdf_term_index.js) in IndexedDB, keyed by
 * fingerprint, with the same lifecycle as ViewHistory: an index lives exactly
 * as long as its file is in the view history (ViewHistory calls `retainOnly`
 * after its LRU drop). Every call is best effort: without IndexedDB the index
 * is just learned again.
 */

/** @typedef {import("../src/display/api").PDFDocumentProxy} PDFDocumentProxy */

import { PdfTermIndex } from "./pdf_term_index.js";

// The find bar's page index: the inverted term index (pdf_term_index.js, the
// smallest) by default; PdfTextIndex (FM index, exact counts) also fits.
const SearchIndex = PdfTermIndex;

const DB_NAME = "pdfjs-search-index";
const STORE = "indexes";

let dbPromise = null;

function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  return dbPromise;
}

async function run(mode, fn) {
  try {
    const db = await openDb();
    if (!db) {
      return null;
    }
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result ?? null);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } catch {
    return null;
  }
}

// Stored in the index's compact binary form, deflate-raw compressed. Entries
// in any other form don't decode and are simply learned again.
function deflate(bytes) {
  return new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))
  ).arrayBuffer();
}

async function inflate(buffer) {
  return new Uint8Array(
    await new Response(
      new Blob([buffer])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"))
    ).arrayBuffer()
  );
}

const PDFSearchIndexStore = {
  async get(fingerprint) {
    const buffer = await run("readonly", s => s.get(fingerprint));
    try {
      return buffer ? SearchIndex.decode(await inflate(buffer)) : null;
    } catch {
      return null;
    }
  },

  async set(fingerprint, index) {
    const buffer = await deflate(index.encode());
    return run("readwrite", s => s.put(buffer, fingerprint));
  },

  delete: fingerprint => run("readwrite", s => s.delete(fingerprint)),

  /** Deletes every index whose fingerprint is not in `fingerprints`. */
  retainOnly(fingerprints) {
    const keep = new Set(fingerprints);
    return run("readwrite", s => {
      const req = s.getAllKeys();
      req.onsuccess = () => {
        for (const key of req.result) {
          if (!keep.has(String(key))) {
            s.delete(key);
          }
        }
      };
      return null;
    });
  },
};

const idle = () =>
  new Promise(resolve => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(resolve, { timeout: 1000 });
    } else {
      setTimeout(resolve, 0);
    }
  });

/**
 * Loads the document's stored search index, or starts an empty one. By
 * default it is never built by reading pages: PDFFindController hands it every
 * page a search extracts anyway (one text extraction per page for both; the
 * index takes them in idle time, off the search's path), and the index is
 * stored in idle time once it stops growing. With `background: true` the
 * missing pages are also read while the viewer is idle (`stepPages` at a
 * time) - that reads the text of every page, so most of the file.
 * @param {PDFDocumentProxy} pdfDocument
 * @param {string} fingerprint
 * @param {{stepPages?: number, isCurrent?: () => boolean,
 *   onIndex?: (index: PdfTermIndex) => void, background?: boolean}}
 *   [options]
 * @returns {Promise<PdfTermIndex|null>}
 */
async function ensureSearchIndex(pdfDocument, fingerprint, options = {}) {
  const {
    stepPages = 16,
    isCurrent = () => true,
    onIndex,
    background = false,
  } = options;
  const { numPages } = pdfDocument;
  let index = await PDFSearchIndexStore.get(fingerprint);
  if (index?.numPages !== numPages) {
    index = new SearchIndex(numPages);
  }
  let timer = null;
  index.onPagesAdded = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await idle();
      if (isCurrent()) {
        PDFSearchIndexStore.set(fingerprint, index).catch(() => {});
      }
    }, 2000);
  };
  onIndex?.(index);
  while (background && isCurrent() && !index.complete) {
    await idle();
    const first = index.indexed.indexOf(0);
    const texts = [];
    for (let i = first; i < numPages && texts.length < stepPages; i++) {
      if (index.indexed[i] || !isCurrent()) {
        break;
      }
      let text = "";
      try {
        const page = await pdfDocument.getPage(i + 1);
        text = SearchIndex.pageString(
          await page.getTextContent({ disableNormalization: true })
        );
      } catch {}
      texts.push(text);
    }
    if (!isCurrent()) {
      return null;
    }
    await idle();
    index.addPages(first, texts);
    index.onPagesAdded();
  }
  return index;
}

export { ensureSearchIndex, PDFSearchIndexStore };
