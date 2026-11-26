// Makes a scan-like test book: one JPEG page image per page (different per page) plus a line of
// text in a standard font, like the scanned seforim the app opens.
// Usage: node make_pdf.mjs <out.pdf> <pages>
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";

const [out, pagesArg] = process.argv.slice(2);
const pages = +pagesArg;
const W = 1700,
  H = 2400;
const chunks = [];
let size = 0;
const offsets = [];
const put = s => {
  const b = typeof s === "string" ? Buffer.from(s, "latin1") : s;
  chunks.push(b);
  size += b.length;
};
const obj = (num, body) => {
  offsets[num] = size;
  put(`${num} 0 obj\n`);
  for (const part of [].concat(body)) {
    put(part);
  }
  put("\nendobj\n");
};
put("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
// 1 catalog, 2 pages, 3 font, then per page: page, content, image.
const first = 4;
const kids = [];
for (let i = 0; i < pages; i++) {
  kids.push(`${first + i * 3} 0 R`);
}
obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
obj(2, `<< /Type /Pages /Count ${pages} /Kids [${kids.join(" ")}] >>`);
obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
let seed = 7;
const rnd = () =>
  (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
// Page dicts first, together (as most producers write them), then each page's content and image.
for (let i = 0; i < pages; i++) {
  const p = first + i * 3;
  obj(
    p,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 864] /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`
  );
}
for (let i = 0; i < pages; i++) {
  const c = createCanvas(W, H);
  const g = c.getContext("2d");
  g.fillStyle = "#f4efe4";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#222";
  for (let l = 0; l < 60; l++) {
    for (let w = 0; w < 14; w++) {
      g.fillRect(100 + w * 105 + rnd() * 20, 120 + l * 37, 40 + rnd() * 50, 18 + rnd() * 6);
    }
  }
  for (let k = 0; k < 5000; k++) {
    g.fillStyle = `rgba(0,0,0,${rnd() * 0.2})`;
    g.fillRect(rnd() * W, rnd() * H, 2, 2);
  }
  const jpeg = c.toBuffer("image/jpeg", 40);
  const p = first + i * 3;
  const content = `q 612 0 0 864 0 0 cm /Im0 Do Q BT /F1 10 Tf 40 20 Td (page ${i + 1} amar rav) Tj ET`;
  obj(p + 1, [`<< /Length ${content.length} >>\nstream\n`, content, "\nendstream"]);
  obj(p + 2, [
    `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg,
    "\nendstream",
  ]);
}
const n = first + pages * 3;
const xref = size;
put(`xref\n0 ${n}\n0000000000 65535 f \n`);
for (let i = 1; i < n; i++) {
  put(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
}
put(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
writeFileSync(out, Buffer.concat(chunks));
console.log(`made ${out}: ${pages} pages, ${(size / 1048576).toFixed(1)} MB`);
