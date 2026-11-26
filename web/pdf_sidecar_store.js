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

// The sidecar is stored gzipped (CompressionStream): subset-heavy files have
// hundreds of similar font tables, which compress about 10x.
function encode(data) {
  const json = JSON.stringify(data, (k, v) =>
    ArrayBuffer.isView(v) ? { $t: v.constructor.name, d: Array.from(v) } : v
  );
  return new Response(
    new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))
  ).arrayBuffer();
}

const TYPED = { Uint8Array, Uint32Array, Int16Array };

async function decode(buffer) {
  const json = await new Response(
    new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"))
  ).text();
  return JSON.parse(json, (k, v) =>
    v?.$t && TYPED[v.$t] ? TYPED[v.$t].from(v.d) : v
  );
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

  delete(fingerprint) {
    return run("readwrite", s => s.delete(fingerprint));
  },

  /** Deletes every sidecar whose fingerprint is not in `fingerprints`. */
  retainOnly(fingerprints) {
    const keep = new Set(fingerprints);
    return run("readwrite", s => {
      const req = s.getAllKeys();
      req.onsuccess = () => {
        for (const key of req.result) {
          if (!keep.has(key)) {
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
    new Promise(resolve =>
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(resolve, { timeout: 1000 })
        : setTimeout(resolve, 0)
    );
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

export { ensureSidecar, PDFSidecarStore, searchDirectAndStore };
