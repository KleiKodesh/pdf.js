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
 * Stores each PDF's sidecar index in IndexedDB, keyed by fingerprint, with the
 * same lifecycle as ViewHistory: a sidecar lives exactly as long as its file
 * is in the view history (ViewHistory calls `retainOnly` after its LRU drop).
 * Every call is best effort: without IndexedDB the viewer just rebuilds.
 */

/** @typedef {import("../src/display/api").PDFDocumentProxy} PDFDocumentProxy */

import { decodeSidecar, encodeSidecar } from "./pdf_sidecar_codec.js";
import { PdfTermIndex } from "./pdf_term_index.js";

// The find bar's page index: the inverted term index (pdf_term_index.js, the
// smallest) by default; PdfTextIndex (FM index, exact counts) also fits.
const TextIndex = PdfTermIndex;

const DB_NAME = "pdfjs-sidecars";
const STORE = "sidecars";

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

// The sidecar is stored in its compact binary form (pdf_sidecar_codec.js),
// deflate-raw compressed. Entries in any older form don't decode and are
// simply rebuilt.
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

// The full-text index (pdf_text_index.js) is stored next to the sidecar, in
// the same store, under the fingerprint + this suffix.
const TEXT_KEY = "#text";

function encode(data) {
  return new Response(
    new Blob([encodeSidecar(data)])
      .stream()
      .pipeThrough(new CompressionStream("deflate-raw"))
  ).arrayBuffer();
}

async function decode(buffer) {
  const bytes = await new Response(
    new Blob([buffer])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"))
  ).arrayBuffer();
  return decodeSidecar(new Uint8Array(bytes));
}

const PDFSidecarStore = {
  async get(fingerprint) {
    const buffer = await run("readonly", s => s.get(fingerprint));
    try {
      return buffer ? await decode(buffer) : null;
    } catch {
      return null;
    }
  },

  async set(fingerprint, data) {
    const buffer = await encode(data);
    return run("readwrite", s => s.put(buffer, fingerprint));
  },

  delete: fingerprint =>
    run("readwrite", s => {
      s.delete(fingerprint + TEXT_KEY);
      return s.delete(fingerprint);
    }),

  async getTextIndex(fingerprint) {
    const buffer = await run("readonly", s => s.get(fingerprint + TEXT_KEY));
    try {
      return buffer ? TextIndex.decode(await inflate(buffer)) : null;
    } catch {
      return null;
    }
  },

  async setTextIndex(fingerprint, index) {
    const buffer = await deflate(index.encode());
    return run("readwrite", s => s.put(buffer, fingerprint + TEXT_KEY));
  },

  /** Deletes every sidecar whose fingerprint is not in `fingerprints`. */
  retainOnly(fingerprints) {
    const keep = new Set(fingerprints);
    return run("readwrite", s => {
      const req = s.getAllKeys();
      req.onsuccess = () => {
        for (const key of req.result) {
          if (!keep.has(String(key).replace(TEXT_KEY, ""))) {
            s.delete(key);
          }
        }
      };
      return null;
    });
  },
};

async function save(pdfDocument, fingerprint) {
  try {
    await PDFSidecarStore.set(fingerprint, await pdfDocument.getSidecar());
  } catch {}
}

/**
 * Loads the document's stored sidecar into the worker, then completes it in
 * small steps while the viewer is idle (a stored one may be partial, see
 * `searchDirectAndStore`), and stores it when anything was added.
 * @param {PDFDocumentProxy} pdfDocument
 * @param {string} fingerprint
 * @param {{stepPages?: number, isCurrent?: () => boolean}} [options]
 */
async function ensureSidecar(pdfDocument, fingerprint, options = {}) {
  const { stepPages = 20, isCurrent = () => true } = options;
  const stored = await PDFSidecarStore.get(fingerprint);
  const loaded =
    !!stored && (await pdfDocument.setSidecar(stored).catch(() => false));
  if (
    loaded &&
    stored.pages.length === stored.numPages &&
    [...stored.pages].every(Boolean)
  ) {
    return;
  }
  const idle = () =>
    new Promise(resolve => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(resolve, { timeout: 1000 });
      } else {
        setTimeout(resolve, 0);
      }
    });
  let fromPage = 0;
  while (isCurrent()) {
    await idle();
    if (!isCurrent()) {
      return;
    }
    const step = await pdfDocument.buildSidecar({
      fromPage,
      maxPages: stepPages,
    });
    fromPage = step.nextPage;
    if (step.reachedEnd) {
      break;
    }
  }
  if (isCurrent()) {
    await save(pdfDocument, fingerprint);
  }
}

/**
 * `searchDirect`, storing the sidecar when the batch indexed new pages, so a
 * search on a fresh file completes the stored index too.
 */
async function searchDirectAndStore(pdfDocument, fingerprint, params) {
  const result = await pdfDocument.searchDirect(params);
  if (result.built.length) {
    save(pdfDocument, fingerprint);
  }
  return result;
}

const idle = () =>
  new Promise(resolve => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(resolve, { timeout: 1000 });
    } else {
      setTimeout(resolve, 0);
    }
  });

/**
 * Loads the document's stored full-text index, or builds it while the viewer
 * is idle: `stepPages` pages at a time, their text as PDFFindController gets
 * it, one index chunk per step (first-open model: the index grows; a search
 * uses the indexed pages and reads the others itself). Stores it as it grows.
 * @param {PDFDocumentProxy} pdfDocument
 * @param {string} fingerprint
 * @param {{stepPages?: number, isCurrent?: () => boolean,
 *   onIndex?: (index: PdfTermIndex) => void}} [options]
 * @returns {Promise<PdfTermIndex|null>}
 */
async function ensureTextIndex(pdfDocument, fingerprint, options = {}) {
  const { stepPages = 16, isCurrent = () => true, onIndex } = options;
  const { numPages } = pdfDocument;
  let index = await PDFSidecarStore.getTextIndex(fingerprint);
  if (index?.numPages !== numPages) {
    index = new TextIndex(numPages);
  }
  onIndex?.(index);
  let added = 0;
  while (isCurrent() && !index.complete) {
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
        text = TextIndex.pageString(
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
    if (++added % 8 === 0 || index.complete) {
      await PDFSidecarStore.setTextIndex(fingerprint, index).catch(() => {});
    }
  }
  return index;
}

export {
  ensureSidecar,
  ensureTextIndex,
  PDFSidecarStore,
  searchDirectAndStore,
};
