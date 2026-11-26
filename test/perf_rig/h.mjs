// The rig page: a PDFViewer like the app's, opening a test book either by a full read (url, the
// host answers without Content-Length) or by random access (a range transport, no auto-fetch)
// guided by the sidecar page byte map. See README in this folder's ab.mjs/drive.mjs.
import * as pdfjs from "/dist/build/pdf.mjs";
import { EventBus, PDFFindController, PDFLinkService, PdfTermIndex, PDFViewer } from "/dist/web/pdf_viewer.mjs";

const {
  GlobalWorkerOptions,
  PDFWorker,
  getDocument,
  PDFDataRangeTransport,
  AnnotationEditorType,
} = pdfjs;
GlobalWorkerOptions.workerSrc = "/dist/build/pdf.worker.mjs";
const R = "/dist/";
let worker = null,
  viewer = null,
  task = null;
const now = () => performance.now();
const raf = () => new Promise(r => requestAnimationFrame(r));
function canvasShown(n) {
  const c = document.querySelector(
    `.page[data-page-number="${n}"] .canvasWrapper canvas`
  );
  return !!(c && c.width > 0 && !c.hidden && c.isConnected);
}
async function waitShown(n, t0, limit = 30000) {
  while (now() - t0 < limit) {
    if (canvasShown(n)) {
      return Math.round(now() - t0);
    }
    await raf();
  }
  return null;
}
async function rangeSource(url) {
  const r = await fetch(url, { headers: { Range: "bytes=0-65535" } });
  const total = +r.headers.get("Content-Range").split("/")[1];
  const t = new PDFDataRangeTransport(
    total,
    new Uint8Array(await r.arrayBuffer())
  );
  t.requestDataRange = (b, e) =>
    fetch(url, { headers: { Range: `bytes=${b}-${e - 1}` } })
      .then(x => x.arrayBuffer())
      .then(buf => t.onDataRange(b, new Uint8Array(buf)));
  return t;
}
window.openView = async o => {
  const T = {};
  const t0 = now();
  await fetch("/bytes?reset=1");
  worker ||= new PDFWorker();
  await worker.promise;
  if (task) {
    await task.destroy();
    task = null;
  }
  const url = `/pdf/wv2/${o.book}.pdf`;
  const params = {
    worker,
    cMapUrl: R + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: R + "standard_fonts/",
    wasmUrl: R + "wasm/",
    iccUrl: R + "iccs/",
  };
  if (o.mode === "sparse") {
    Object.assign(params, {
      range: await rangeSource(url),
      rangeChunkSize: o.chunk || 65536,
      disableAutoFetch: true,
      disableStream: true,
    });
  } else {
    params.url = url;
  }
  task = getDocument(params);
  const doc = await task.promise;
  T.doc = Math.round(now() - t0);
  const eb = new EventBus();
  const ls = new PDFLinkService({ eventBus: eb });
  const c = document.getElementById("c");
  c.innerHTML = '<div id="v" class="pdfViewer"></div>';
  c.scrollTop = 0;
  viewer = new PDFViewer({
    container: c,
    eventBus: eb,
    linkService: ls,
    annotationEditorMode: AnnotationEditorType.NONE,
  });
  ls.setViewer(viewer);
  window.__rendered = new Set();
  eb.on("pagerendered", e => window.__rendered.add(e.pageNumber));
  eb.on("pagesinit", () => {
    viewer.currentScaleValue = "page-width";
  });
  viewer.setDocument(doc);
  ls.setDocument(doc);
  T.image1 = await waitShown(1, t0);
  T.bytes = (await (await fetch("/bytes")).json()).bytes;
  T.pages = doc.numPages;
  return T;
};
const bytes = async () => (await (await fetch("/bytes")).json()).bytes;
window.jump = async n => {
  const t0 = now();
  viewer.currentPageNumber = n;
  return await waitShown(n, t0);
};
window.fling = async (pages, msPerPage) => {
  const c = document.getElementById("c");
  const h = c.scrollHeight / viewer.pagesCount;
  const start = c.scrollTop,
    frames = Math.round((pages * msPerPage) / 16.7);
  for (let i = 1; i <= frames; i++) {
    c.scrollTop = start + (h * pages * i) / frames;
    await raf();
  }
  const t0 = now();
  await raf();
  const n = viewer.currentPageNumber;
  return { landing: n, img: await waitShown(n, t0) };
};
window.totalBytes = bytes;
// One search on a fresh random-access open through PDFFindController, with the
// search index learning (on) or without an index (off): time to the first
// result, time to all results, pages read, bytes read; after it, the index's
// size in memory once it has taken every page.
window.searchRun = async o => {
  worker ||= new PDFWorker();
  await worker.promise;
  if (task) {
    await task.destroy();
  }
  await fetch("/bytes?reset=1");
  const url = `/pdf/wv2/${o.book}.pdf`;
  task = getDocument({ worker, range: await rangeSource(url), rangeChunkSize: 65536, disableAutoFetch: true, disableStream: true, cMapUrl: R + "cmaps/", cMapPacked: true, standardFontDataUrl: R + "standard_fonts/", wasmUrl: R + "wasm/" });
  const doc = await task.promise;
  const base = await bytes();
  const eb = new EventBus();
  const fc = new PDFFindController({ eventBus: eb, linkService: { pagesCount: doc.numPages, page: 1 } });
  fc.setDocument(doc);
  const index = o.index ? new PdfTermIndex(doc.numPages) : null;
  fc.textIndex = index;
  let first = null;
  const t0 = now();
  eb.on("updatefindmatchescount", e => {
    if (first === null && e.matchesCount.total > 0) {
      first = Math.round(now() - t0);
    }
  });
  eb.dispatch("find", { source: null, type: "", query: o.query, caseSensitive: false, entireWord: false, findPrevious: false, matchDiacritics: false, highlightAll: false });
  for (;;) {
    await new Promise(r => setTimeout(r, 5));
    let done = true;
    for (let i = 0; i < doc.numPages; i++) {
      if (!fc.pageMatches[i]) {
        done = false;
        break;
      }
    }
    if (done) {
      break;
    }
  }
  const all = Math.round(now() - t0);
  const out = { first, all, hits: fc.pageMatches.reduce((a, m) => a + m.length, 0), bytes: (await bytes()) - base };
  if (index) {
    // Wait for the index to take the pages (idle time), then a second search.
    const t1 = now();
    while (!index.complete && now() - t1 < 30000) {
      await new Promise(r => setTimeout(r, 50));
    }
    out.indexReadyMs = Math.round(now() - t0);
    out.indexMemBytes = index.memoryBytes;
    out.indexStoredBytes = index.encode().length;
    const b2 = await bytes();
    const t2 = now();
    const res = index.search({ query: o.query2 });
    out.secondCandidates = res.pages.length;
    out.secondIndexMs = Math.round((now() - t2) * 10) / 10;
    out.secondBytes = (await bytes()) - b2;
  }
  return out;
};
window.ready = true;
