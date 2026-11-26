// The sidecar page byte map of a PDF (src/core/pdf_sidecar.js), as JSON for the rig's prefetch.
// Usage: node pagebytes.mjs <file.pdf> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { LocalPdfManager } from "../../src/core/pdf_manager.js";
import { PdfSidecar } from "../../src/core/pdf_sidecar.js";

Math.sumPrecise ??= v => v.reduce((a, b) => a + b, 0);
const handler = { send() {}, sendWithPromise: async () => null, on() {} };
const pm = new LocalPdfManager({
  source: new Uint8Array(readFileSync(process.argv[2])),
  evaluatorOptions: { ignoreErrors: true, isOffscreenCanvasSupported: false },
  handler,
  docId: "x",
});
await pm.ensureDoc("checkHeader");
await pm.ensureDoc("parseStartXRef");
await pm.ensureDoc("parse");
const sc = new PdfSidecar(pm);
const out = [];
for (let i = 0; i < pm.pdfDocument.numPages; i++) {
  out.push(sc._pageBytes((await pm.getPage(i)).ref));
}
writeFileSync(process.argv[3], JSON.stringify(out));
console.log(`page map ${process.argv[2]}: ${out.length} pages`);
