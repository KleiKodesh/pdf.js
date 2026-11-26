// The rig page: a PDFViewer like the app's, opening a test book either by a full read (url, the
// host answers without Content-Length) or by random access (a range transport, no auto-fetch)
// guided by the sidecar page byte map. See README in this folder's ab.mjs/drive.mjs.
import * as pdfjs from "/dist/build/pdf.mjs";
import { EventBus, PDFLinkService, PDFViewer } from "/dist/web/pdf_viewer.mjs";

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
window.ready = true;
