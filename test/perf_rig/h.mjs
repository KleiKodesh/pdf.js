// The rig page: a PDFViewer like the app's, opening a test book either by a full read (url, the
// host answers without Content-Length) or by random access (a range transport, no auto-fetch)
// guided by the sidecar page byte map. See README in this folder's ab.mjs/drive.mjs.
import * as pdfjs from "/dist/build/pdf.mjs";
import { ensureTextIndex, EventBus, PDFFindController, PDFLinkService, PDFViewer } from "/dist/web/pdf_viewer.mjs";

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
  let near = () => {};
  if (o.mode === "sparse" && o.map) {
    // The stored sidecar (here only its page byte map) handed to the worker.
    const pageBytes = await (await fetch(`/books/${o.book}.pages.json`)).json();
    await doc.setSidecar({
      v: 2,
      numPages: doc.numPages,
      pages: [],
      forms: [],
      fonts: [],
      pageBytes,
    });
    const ahead = o.ahead ?? 2;
    let lastTop = 0;
    near = (n, dir) => {
      const list = [n - 1];
      for (let i = 1; i <= ahead; i++) {
        list.push(n - 1 + dir * i);
      }
      list.push(n - 1 - dir);
      doc.prefetchPages(list.filter(i => i >= 0 && i < doc.numPages));
    };
    T.nearFn = true;
    const c0 = document.getElementById("c");
    c0.onscroll = () => {
      const dir = c0.scrollTop >= lastTop ? 1 : -1;
      lastTop = c0.scrollTop;
      near(
        Math.min(
          doc.numPages,
          1 + Math.floor(c0.scrollTop / (c0.scrollHeight / doc.numPages))
        ),
        dir
      );
    };
  }
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
// Sidecar build costs on a random-access open (no page shown): bytes read and ms for the page
// byte map only, the full sidecar (font tables, content streams) and the text index; then a
// first search through PDFFindController with the index (pages it reads, bytes).
window.buildCosts = async o => {
  worker ||= new PDFWorker();
  await worker.promise;
  const open = async () => {
    if (task) {
      await task.destroy();
    }
    await fetch("/bytes?reset=1");
    const url = `/pdf/wv2/${o.book}.pdf`;
    task = getDocument({ worker, range: await rangeSource(url), rangeChunkSize: o.chunk || 65536, disableAutoFetch: true, disableStream: true, cMapUrl: R + "cmaps/", cMapPacked: true, standardFontDataUrl: R + "standard_fonts/", wasmUrl: R + "wasm/" });
    return task.promise;
  };
  const out = {};
  const build = async pageBytesOnly => {
    const doc = await open();
    const base = await bytes();
    const t0 = now();
    for (let from = 0; ; ) {
      const step = await doc.buildSidecar({ fromPage: from, maxPages: 50, pageBytesOnly });
      from = step.nextPage;
      if (step.reachedEnd) {
        break;
      }
    }
    return { ms: Math.round(now() - t0), bytes: (await bytes()) - base };
  };
  const attempt = async f => {
    try {
      return await f();
    } catch (ex) {
      return { error: String(ex?.message || ex).slice(0, 200) };
    }
  };
  out.pageMap = await attempt(() => build(true));
  out.fullSidecar = await attempt(() => build(false));
  let doc = await open();
  let base = await bytes();
  let t0 = now();
  const index = await ensureTextIndex(doc, "rig-" + o.book + "-" + Math.random(), { stepPages: 32 });
  out.textIndex = { ms: Math.round(now() - t0), bytes: (await bytes()) - base };
  // Searches on a fresh open through PDFFindController: pages it reads and bytes.
  const search = async (doc, idx, query) => {
    const base0 = await bytes();
    const t1 = now();
    const eb = new EventBus();
    const fc = new PDFFindController({ eventBus: eb, linkService: { pagesCount: doc.numPages, page: 1 } });
    fc.setDocument(doc);
    fc.textIndex = idx;
    let extracted = 0;
    if (!doc.__counted) {
      doc.__counted = true;
      const orig = doc.getPage.bind(doc);
      doc.getPage = async n => {
        const p = await orig(n);
        if (!p.__counted) {
          p.__counted = true;
          const g = p.getTextContent.bind(p);
          p.getTextContent = a => (window.__extracted++, g(a));
        }
        return p;
      };
    }
    window.__extracted = 0;
    eb.dispatch("find", { source: null, type: "", query, caseSensitive: false, entireWord: false, findPrevious: false, matchDiacritics: false, highlightAll: false });
    for (;;) {
      await new Promise(r => setTimeout(r, 20));
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
    extracted = window.__extracted;
    return { ms: Math.round(now() - t1), bytes: (await bytes()) - base0, pagesRead: extracted, hits: fc.pageMatches.reduce((a, m) => a + m.length, 0) };
  };
  // Background-built index (old model) vs the index learning from searches (no background read).
  doc = await open();
  out.searchWithBuiltIndex = await search(doc, index, o.query || "amar");
  doc = await open();
  const grow = new index.constructor(doc.numPages);
  out.firstSearchNoIndex = await search(doc, grow, o.query || "amar");
  out.secondSearchLearned = await search(doc, grow, o.query2 || o.query || "amar");
  return out;
};
window.ready = true;
