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

// Makes a test book: one JPEG page image per page (different per page) plus a
// line of text. Layouts:
//  - scan: one standard font, like a scanned book;
//  - talmud: like the Vagshal Talmud volumes - each page draws text in many
//    embedded fonts written next to its image (spread through the file), and
//    a tagged-PDF structure tree at the end of the file, read when a page is
//    shown.
// Usage: node make_pdf.mjs <out.pdf> <pages> [scan|talmud]
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";

const [out, pagesArg, layout = "scan"] = process.argv.slice(2);
const pages = +pagesArg;
const talmud = layout === "talmud";
const FONTS_PER_PAGE = 12;
const ELEMS_PER_PAGE = 300;
const W = 1700,
  H = 2400;
const chunks = [];
let size = 0;
const offsets = [];
let next = 1;
const alloc = () => next++;
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
const stream = (num, dict, data) =>
  obj(num, [
    `<< ${dict} /Length ${data.length} >>\nstream\n`,
    data,
    "\nendstream",
  ]);
let seed = 7;
const rnd = () =>
  (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

put("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
const catalog = alloc(),
  pagesRoot = alloc(),
  helvetica = alloc(),
  structRoot = talmud ? alloc() : 0,
  parentTree = talmud ? alloc() : 0;
const page = [],
  content = [],
  image = [],
  fonts = [],
  elems = [];
for (let i = 0; i < pages; i++) {
  page.push(alloc());
  content.push(alloc());
  image.push(alloc());
  const f = [];
  for (let k = 0; talmud && k < FONTS_PER_PAGE; k++) {
    f.push({ font: alloc(), desc: alloc(), file: alloc() });
  }
  fonts.push(f);
  const e = [];
  for (let k = 0; talmud && k < ELEMS_PER_PAGE; k++) {
    e.push(alloc());
  }
  elems.push(e);
}
obj(
  catalog,
  `<< /Type /Catalog /Pages ${pagesRoot} 0 R${talmud ? ` /MarkInfo << /Marked true >> /StructTreeRoot ${structRoot} 0 R` : ""} >>`
);
obj(
  pagesRoot,
  `<< /Type /Pages /Count ${pages} /Kids [${page.map(p => `${p} 0 R`).join(" ")}] >>`
);
obj(helvetica, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
// Page dicts first, together (as most producers write them).
for (let i = 0; i < pages; i++) {
  const fontRes = [`/F0 ${helvetica} 0 R`]
    .concat(fonts[i].map((f, k) => `/T${k} ${f.font} 0 R`))
    .join(" ");
  obj(
    page[i],
    `<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 612 864] /Resources << /Font << ${fontRes} >> /XObject << /Im0 ${image[i]} 0 R >> >> /Contents ${content[i]} 0 R${talmud ? ` /StructParents ${i}` : ""} >>`
  );
}
// Then each page's content, image and (talmud) fonts, next to each other.
for (let i = 0; i < pages; i++) {
  const c = createCanvas(W, H);
  const g = c.getContext("2d");
  g.fillStyle = "#f4efe4";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#222";
  for (let l = 0; l < 60; l++) {
    for (let w = 0; w < 14; w++) {
      g.fillRect(
        100 + w * 105 + rnd() * 20,
        120 + l * 37,
        40 + rnd() * 50,
        18 + rnd() * 6
      );
    }
  }
  for (let k = 0; k < 5000; k++) {
    g.fillStyle = `rgba(0,0,0,${rnd() * 0.2})`;
    g.fillRect(rnd() * W, rnd() * H, 2, 2);
  }
  const jpeg = c.toBuffer("image/jpeg", 40);
  let text = `BT /F0 10 Tf 40 20 Td (page ${i + 1} amar rav) Tj ET`;
  if (talmud) {
    text = elems[i]
      .map(
        (_, k) =>
          `/P << /MCID ${k} >> BDC BT /T${k % FONTS_PER_PAGE} 9 Tf ${40 + (k % 5) * 110} ${60 + Math.floor(k / 5) * 90} Td (amar ${i + 1}.${k}) Tj ET EMC`
      )
      .join(" ");
    text += ` BT /F0 10 Tf 40 20 Td (page ${i + 1} amar rav) Tj ET`;
  }
  stream(content[i], "", `q 612 0 0 864 0 0 cm /Im0 Do Q ${text}`);
  stream(
    image[i],
    `/Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
    jpeg
  );
  for (const [k, f] of fonts[i].entries()) {
    // An embedded font program PDF.js can't use (it falls back to a standard
    // font): what matters here is that it is read, like a real one.
    const junk = Buffer.alloc(3000 + Math.floor(rnd() * 3000));
    for (let b = 0; b < junk.length; b++) {
      junk[b] = Math.floor(rnd() * 256);
    }
    obj(
      f.font,
      `<< /Type /Font /Subtype /TrueType /BaseFont /Talmud${i}x${k} /FirstChar 32 /LastChar 126 /FontDescriptor ${f.desc} 0 R >>`
    );
    obj(
      f.desc,
      `<< /Type /FontDescriptor /FontName /Talmud${i}x${k} /Flags 32 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${f.file} 0 R >>`
    );
    stream(f.file, `/Length1 ${junk.length}`, junk);
  }
}
if (talmud) {
  // The structure tree at the end of the file, as the volumes have it.
  const all = elems.flat();
  obj(
    structRoot,
    `<< /Type /StructTreeRoot /K [${all.map(e => `${e} 0 R`).join(" ")}] /ParentTree ${parentTree} 0 R /ParentTreeNextKey ${pages} >>`
  );
  obj(
    parentTree,
    `<< /Nums [${elems.map((e, i) => `${i} [${e.map(x => `${x} 0 R`).join(" ")}]`).join(" ")}] >>`
  );
  // Each page's elements spread over the whole tree (written line by line
  // across pages), so reading one page's part walks the tree region in order.
  for (let k = 0; k < ELEMS_PER_PAGE; k++) {
    for (let i = 0; i < pages; i++) {
      const e = elems[i][k];
      obj(
        e,
        `<< /Type /StructElem /S /P /P ${structRoot} 0 R /Pg ${page[i]} 0 R /K ${k} /T (Line ${i + 1}.${k} of the page, as tagged text) /ActualText (amar ${i + 1}.${k}) >>`
      );
    }
  }
}
const n = next;
const xref = size;
put(`xref\n0 ${n}\n0000000000 65535 f \n`);
for (let i = 1; i < n; i++) {
  put(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
}
put(
  `trailer\n<< /Size ${n} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
);
writeFileSync(out, Buffer.concat(chunks));
console.log(
  `made ${out}: ${pages} pages, ${layout}, ${(size / 1048576).toFixed(1)} MB`
);
