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
 * The PDF sidecar: a small per-file index, built once, that lets text search
 * read a page's content streams straight from the file and decode their text
 * from stored font tables: no font program, encoding or ToUnicode is parsed.
 *
 * It holds (a) where every page's content streams (and the form XObjects it
 * draws) sit in the file, and (b) one table per distinct font: code -> Unicode
 * as the text extraction resolves it (incl. the legacy 8-bit Hebrew decode)
 * and code -> advance. No page text is stored.
 *
 * Format version 1 (plain structured-clone data, fit for IndexedDB):
 *   {
 *     v: 1, numPages,
 *     pages: [ Container | undefined ],   // index = page index
 *     forms: [ Container ],
 *     fonts: [ FontTable ],   // a font that failed to load is not mapped
 *     fontRefs: { "12R": fontIndex },     // font object -> table
 *     formRefs: [ "34R" ],                // form index -> object
 *   }
 *   Container = {
 *     c: [ [num, gen, start, length, filters] ],  // the content streams:
 *        object, byte offset and length of the raw stream data in the file
 *     f: { resourceName: fontIndex },
 *     x: { resourceName: formIndex },
 *   }
 *   filters = [ [filterName, decodeParms | null] ]   (empty = raw)
 *   FontTable = {
 *     t: 0 simple | 1 composite,
 *     k: codes (Uint8Array / Uint32Array) that differ from the fallback,
 *     u: their Unicode strings joined by U+FFFF,
 *     a: their advances (Int16Array, 1/1000 em),
 *     d: fallback advance (fallback text = the code as a char),
 *     sp: space width, m?: codes whose Unicode is visual (RTL mirroring),
 *     composite only: r: codespace ranges, i: identity ToUnicode, v: vertical
 *   }
 */

import { buildMatcher, countMatches, normalizeText } from "./sidecar_find.js";
import { Dict, isName, Name, Ref } from "./primitives.js";
import { Lexer, Parser } from "./parser.js";
import { BaseStream } from "./base_stream.js";
import { getCharUnicodeCategory } from "./unicode.js";
import { IdentityToUnicodeMap } from "./to_unicode_map.js";
import { Stream } from "./stream.js";
import { warn } from "../shared/util.js";

const SIDECAR_VERSION = 1;
const SEP = "\uFFFF";

function plainParams(parms) {
  if (!(parms instanceof Dict)) {
    return null;
  }
  const out = {};
  for (const key of [
    "Predictor",
    "Colors",
    "BitsPerComponent",
    "Columns",
    "EarlyChange",
    "K",
    "EncodedByteAlign",
    "Rows",
    "EndOfBlock",
    "BlackIs1",
  ]) {
    const v = parms.get(key);
    if (typeof v === "number" || typeof v === "boolean") {
      out[key] = v;
    }
  }
  return out;
}

function rawSpan(stream) {
  // Walk down the filter / decrypt chain to the sub-stream of the file.
  let s = stream;
  while (s && !(typeof s.start === "number" && s.bytes !== undefined)) {
    s = s.str ?? s.stream ?? null;
  }
  return !s || typeof s.end !== "number" ? null : [s.start, s.end - s.start];
}

function streamEntry(xref, ref) {
  if (!(ref instanceof Ref)) {
    return null;
  }
  const stream = xref.fetch(ref);
  if (!(stream instanceof BaseStream)) {
    return null;
  }
  const span = rawSpan(stream);
  if (!span) {
    return null;
  }
  const dict = stream.dict;
  let filter = dict.get("F", "Filter");
  let parms = dict.get("DP", "DecodeParms");
  if (filter instanceof Name) {
    filter = [filter];
    parms = [parms];
  }
  const filters = [];
  if (Array.isArray(filter)) {
    for (let i = 0; i < filter.length; i++) {
      const f = xref.fetchIfRef(filter[i]);
      if (!(f instanceof Name)) {
        return null;
      }
      const p = Array.isArray(parms) ? xref.fetchIfRef(parms[i]) : null;
      filters.push([f.name, plainParams(p)]);
    }
  }
  return [ref.num, ref.gen, span[0], span[1], filters];
}

function fontTable(font) {
  const table = fontCodeTable(font);
  if (table && font.isType3Font) {
    // getTextContent's Type3 rules: char-width space threshold and the
    // glyph-height scale use the real font matrix and bbox.
    table.t3 = {
      fm: Array.from(font.fontMatrix),
      bbox: font.bbox ? Array.from(font.bbox) : null,
      cb: !!font.isCharBBox,
    };
  }
  return table;
}

function fontCodeTable(font) {
  if (!font || typeof font._charToGlyph !== "function") {
    return null;
  }
  const fm = font.fontMatrix?.[0] ?? 0.001;
  const adv = g => Math.round((g.width || 0) * fm * 1000);
  // getTextContent's space threshold uses the font's space width.
  const sp = font.isType3Font ? 0 : Math.round(font.spaceWidth || 0);
  if (!font.cMap) {
    // Sparse: only the codes whose text is not the byte itself, or whose
    // advance is not the most common one (d). The rest decode as fallback.
    const glyphs = [];
    const counts = new Map();
    for (let c = 0; c < 256; c++) {
      const g = font._charToGlyph(c, c === 0x20);
      const w = adv(g);
      glyphs.push([g.unicode ?? "", w, !!g.isUnicodeVisual]);
      counts.set(w, (counts.get(w) || 0) + 1);
    }
    let d = 0,
      best = -1;
    for (const [w, n] of counts) {
      if (n > best) {
        best = n;
        d = w;
      }
    }
    const k = [],
      u = [],
      a = [],
      vis = [];
    glyphs.forEach(([text, w, visual], c) => {
      if (text !== String.fromCharCode(c) || w !== d || visual) {
        k.push(c);
        u.push(text);
        a.push(w);
        if (visual) {
          vis.push(c);
        }
      }
    });
    return {
      t: 0,
      k: Uint8Array.from(k),
      u: u.join(SEP),
      a: Int16Array.from(a),
      d,
      sp,
      ...(vis.length && { m: Uint32Array.from(vis) }),
    };
  }
  const identity = font.toUnicode instanceof IdentityToUnicodeMap;
  const d = Math.round((font.defaultWidth || 0) * fm * 1000);
  const codeSet = new Set();
  if (!identity) {
    font.toUnicode.forEach(code => {
      codeSet.add(+code);
    });
  }
  // Codes without a ToUnicode entry still need their advance when it isn't
  // the default one (getTextContent's spacing depends on it).
  const widths = font.widths || {};
  font.cMap.forEach((code, cid) => {
    const w = widths[typeof cid === "number" ? cid : code];
    if (typeof w === "number" && Math.round(w * fm * 1000) !== d) {
      codeSet.add(+code);
    }
  });
  // Keep only the codes that decode differently from the fallback (the code
  // as a char, default advances): e.g. pdf.js gives Identity fonts a full
  // 65536-entry ToUnicode, nearly all of it equal to the fallback.
  const dv = font.vertical
    ? Math.round((font.defaultVMetrics?.[0] ?? -1000) * fm * 1000)
    : 0;
  const codes = [],
    u = [],
    aa = [],
    vms = [],
    vis = [];
  for (const code of [...codeSet].sort((x, y) => x - y)) {
    const g = font._charToGlyph(code);
    const text = g.unicode ?? "";
    const w = adv(g);
    const v = font.vertical ? Math.round((g.vmetric?.[0] ?? 0) * fm * 1000) : 0;
    if (
      text !== String.fromCharCode(code) ||
      w !== d ||
      v !== dv ||
      g.isUnicodeVisual
    ) {
      codes.push(code);
      u.push(text);
      aa.push(w);
      vms.push(v);
      if (g.isUnicodeVisual) {
        vis.push(code);
      }
    }
  }
  const a = Int16Array.from(aa);
  const vm = font.vertical ? Int16Array.from(vms) : null;
  return {
    t: 1,
    r: font.cMap.codespaceRanges.map(x => x.slice()),
    i: identity,
    k: Uint32Array.from(codes),
    u: u.join(SEP),
    a,
    d,
    sp,
    v: font.vertical ? 1 : 0,
    ...(vm && {
      vm,
      dv,
    }),
    ...(vis.length && { m: Uint32Array.from(vis) }),
  };
}

/**
 * Worker-side sidecar: builds page entries step by step and searches.
 */
class PdfSidecar {
  constructor(pdfManager) {
    this.pdfManager = pdfManager;
    this.data = {
      v: SIDECAR_VERSION,
      numPages: 0,
      pages: [],
      forms: [],
      fonts: [],
    };
    this._fontIndex = new Map(); // ref string -> index
    this._formIndex = new Map();
    this._decodedFonts = [];
    this._tableIndex = new Map(); // table content -> index (build only)
  }

  /** Replace the state with a sidecar loaded from storage. */
  load(data) {
    if (data?.v !== SIDECAR_VERSION) {
      return false;
    }
    this.data = data;
    this._fontIndex.clear();
    this._formIndex.clear();
    this._decodedFonts = [];
    for (const [r, i] of Object.entries(data.fontRefs || {})) {
      this._fontIndex.set(r, i);
    }
    this._tableIndex.clear();
    (data.formRefs || []).forEach((r, i) => r && this._formIndex.set(r, i));
    return true;
  }

  get xref() {
    return this.pdfManager.pdfDocument.xref;
  }

  async _container(contentRefs, resources, evaluator, task) {
    const xref = this.xref;
    const c = [];
    for (const ref of contentRefs) {
      const e = streamEntry(xref, ref);
      if (e) {
        c.push(e);
      }
    }
    const f = {},
      x = {};
    const fontDict = resources?.get("Font");
    if (fontDict instanceof Dict) {
      for (const [name, raw] of fontDict.getRawEntries()) {
        const key = raw instanceof Ref ? raw.toString() : null;
        if (key && this._fontIndex.has(key)) {
          f[name] = this._fontIndex.get(key);
          continue;
        }
        let table = null;
        try {
          const translated = await evaluator.loadFont(
            name,
            raw instanceof Ref ? raw : null,
            resources,
            task
          );
          table = fontTable(translated.font);
        } catch (ex) {
          warn(`PdfSidecar: font "${name}": ${ex}`);
        }
        if (!table) {
          // Not mapped: a search loads this font the usual way.
          continue;
        }
        // Subset fonts often share one table: store each distinct table once.
        const tableKey = JSON.stringify(table, (k, v) =>
          ArrayBuffer.isView(v) ? Array.from(v) : v
        );
        let idx = this._tableIndex.get(tableKey);
        if (idx === undefined) {
          idx = this.data.fonts.length;
          this.data.fonts.push(table);
          this._tableIndex.set(tableKey, idx);
        }
        if (key) {
          (this.data.fontRefs ||= {})[key] = idx;
          this._fontIndex.set(key, idx);
        }
        f[name] = idx;
      }
    }
    const xobjs = resources?.get("XObject");
    if (xobjs instanceof Dict) {
      for (const [name, raw] of xobjs.getRawEntries()) {
        if (!(raw instanceof Ref)) {
          continue;
        }
        const key = raw.toString();
        if (this._formIndex.has(key)) {
          x[name] = this._formIndex.get(key);
          continue;
        }
        const xobj = xref.fetch(raw);
        if (
          !(xobj instanceof BaseStream) ||
          !isName(xobj.dict.get("Subtype"), "Form")
        ) {
          continue;
        }
        const idx = this.data.forms.length;
        this._formIndex.set(key, idx);
        (this.data.formRefs ||= [])[idx] = key;
        this.data.forms.push(null); // reserve (cycles)
        const formRes = xobj.dict.get("Resources");
        this.data.forms[idx] = await this._container(
          [raw],
          formRes instanceof Dict ? formRes : resources,
          evaluator,
          task
        );
        x[name] = idx;
      }
    }
    return { c, f, x };
  }

  async buildPage(pageIndex, handler, task) {
    if (this.data.pages[pageIndex]) {
      return this.data.pages[pageIndex];
    }
    const page = await this.pdfManager.getPage(pageIndex);
    await page.loadResources(["Font", "XObject"]);
    const evaluator = page._createPartialEvaluator(handler);
    const raw = page.pageDict.getRaw("Contents");
    let refs = [];
    if (raw instanceof Ref) {
      const obj = this.xref.fetch(raw);
      refs = Array.isArray(obj) ? obj : [raw];
    } else if (Array.isArray(raw)) {
      refs = raw;
    }
    const entry = await this._container(refs, page.resources, evaluator, task);
    this.data.pages[pageIndex] = entry;
    return entry;
  }

  /** Builds up to `maxPages` missing pages from `fromPage`. */
  async build({ fromPage = 0, maxPages = 50 }, handler, task) {
    const numPages = (this.data.numPages =
      this.pdfManager.pdfDocument.numPages);
    let i = fromPage;
    for (let n = 0; i < numPages && n < maxPages; i++, n++) {
      task.ensureNotTerminated();
      await this.buildPage(i, handler, task);
    }
    let complete = true;
    for (let p = 0; p < numPages; p++) {
      if (!this.data.pages[p]) {
        complete = false;
        break;
      }
    }
    return { nextPage: i, reachedEnd: i >= numPages, complete };
  }

  /**
   * Batched direct search: reads only the content streams of the pages in
   * [fromPage, fromPage + maxPages), decodes them with the stored font tables
   * and counts the matches. Pages not in the sidecar yet are added first.
   */
  async search(
    {
      query,
      fromPage = 0,
      maxPages = 50,
      caseSensitive,
      entireWord,
      matchDiacritics,
    },
    handler,
    task
  ) {
    const numPages = this.pdfManager.pdfDocument.numPages;
    this.data.numPages = numPages;
    const re = buildMatcher(query, { caseSensitive, matchDiacritics });
    const hits = [];
    const built = [];
    let i = fromPage;
    for (let n = 0; re && i < numPages && n < maxPages; i++, n++) {
      task.ensureNotTerminated();
      if (!this.data.pages[i]) {
        built.push(i);
      }
      let text = "";
      try {
        text = await this.pageText(i, handler, task);
      } catch (ex) {
        warn(`PdfSidecar: page ${i + 1}: ${ex}`);
      }
      const count = countMatches(
        normalizeText(text, matchDiacritics),
        re,
        entireWord
      );
      if (count) {
        hits.push({ pageIndex: i, count });
      }
    }
    return { hits, nextPage: i, reachedEnd: i >= numPages || !re, built };
  }

  // --- direct read ---------------------------------------------------------

  async _readStream([num, gen, start, length, filters]) {
    const pdfManager = this.pdfManager;
    if (pdfManager.streamManager) {
      await pdfManager.requestRange(start, start + length);
    }
    const base = pdfManager.pdfDocument.stream;
    const dict = new Dict(null);
    if (filters.length) {
      dict.set(
        "Filter",
        filters.map(([name]) => Name.get(name))
      );
      dict.set(
        "DecodeParms",
        filters.map(([, p]) => {
          if (!p) {
            return null;
          }
          const d = new Dict(null);
          for (const k in p) {
            d.set(k, p[k]);
          }
          return d;
        })
      );
    }
    let stream = base.makeSubStream(start, length, dict);
    const encrypt = this.xref.encrypt;
    if (encrypt) {
      stream = encrypt
        .createCipherTransform(num, gen)
        .createStream(stream, length);
    }
    if (filters.length) {
      const parser = new Parser({
        lexer: new Lexer(new Stream(new Uint8Array(0))),
        xref: null,
      });
      stream = parser.filter(stream, dict, length);
    }
    return stream.getBytes();
  }

  /** The page's text the way PDFFindController builds it (items + "\n"). */
  async pageText(pageIndex, handler, task) {
    const entry =
      this.data.pages[pageIndex] ??
      (await this.buildPage(pageIndex, handler, task));
    const page = await this.pdfManager.getPage(pageIndex);
    const parts = [];
    for (const s of entry.c) {
      try {
        parts.push(await this._readStream(s));
      } catch (ex) {
        warn(`PdfSidecar: content stream ${s[0]}R: ${ex}`);
      }
    }
    let total = 0;
    for (const p of parts) {
      total += p.length + 1;
    }
    const bytes = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
      bytes.set(p, pos);
      pos += p.length;
      bytes[pos++] = 0x0a;
    }

    // getTextContent's own layout pass (spaces, EOLs, bidi), but every font
    // comes from the stored tables: no font program or encoding is parsed.
    const evaluator = page._createPartialEvaluator(handler);
    const realLoadFont = evaluator.loadFont.bind(evaluator);
    evaluator.loadFont = (fontName, fontRef, resources, ...rest) => {
      const raw =
        fontRef ??
        (resources?.get("Font") instanceof Dict
          ? resources.get("Font").getRaw(fontName)
          : null);
      const idx =
        raw instanceof Ref ? this._fontIndex.get(raw.toString()) : undefined;
      if (idx === undefined) {
        // Inline font dict, or a font not in the map: load it the usual way.
        return realLoadFont(fontName, fontRef, resources, ...rest);
      }
      return Promise.resolve({
        loadedName: `sc_${idx}`,
        font: this._font(idx) ?? this._errorFont(),
      });
    };
    const strBuf = [];
    const sink = {
      enqueue(chunk) {
        for (const item of chunk.items) {
          if (item.str !== undefined) {
            strBuf.push(item.str);
            if (item.hasEOL) {
              strBuf.push("\n");
            }
          }
        }
      },
      desiredSize: Infinity,
      ready: Promise.resolve(),
    };
    await evaluator.getTextContent({
      stream: new Stream(bytes),
      task,
      resources: page.resources,
      sink,
      viewBox: page.view,
      disableNormalization: true,
    });
    return strBuf.join("");
  }

  _errorFont() {
    return (this._error ||= new TableFont(null, -1));
  }

  _font(idx) {
    let f = this._decodedFonts[idx];
    if (f === undefined) {
      const t = this.data.fonts[idx];
      f = this._decodedFonts[idx] = t ? new TableFont(t, idx) : null;
    }
    return f;
  }
}

/**
 * A font made from a stored table, with just what getTextContent reads:
 * charsToGlyphs (unicode, width, isSpace), metrics and flags.
 */
class TableFont {
  #cache = new Map();

  constructor(t, idx) {
    this.name = `sidecar_${idx}`;
    this.loadedName = this.name;
    this.fallbackName = "sans-serif";
    this.vertical = !!t?.v;
    this.isType3Font = !!t?.t3;
    this.fontMatrix = t?.t3?.fm ?? [0.001, 0, 0, 0.001, 0, 0];
    this.isCharBBox = !!t?.t3?.cb;
    // Stored advances are in 1/1000 em; Type3 widths are in glyph space.
    this.widthScale = t?.t3 ? 1 / (1000 * (t.t3.fm[0] || 0.001)) : 1;
    this.spaceWidth = t?.sp || 0;
    this.ascent = 0.8;
    this.descent = -0.2;
    this.bbox = t?.t3?.bbox ?? null;
    this.systemFontInfo = null;
    this.t = t;
    if (t) {
      this.map = new Map();
      for (let i = 0; i < t.k.length; i++) {
        this.map.set(t.k[i], i);
      }
      this.u = t.u ? t.u.split(SEP) : [];
      this.visual = new Set(t.m || []);
    }
  }

  _glyph(code, isSpace) {
    const t = this.t;
    let unicode = String.fromCharCode(code),
      width = t ? t.d : 0,
      vy = t?.dv ?? 0;
    if (t) {
      const j = this.map.get(code);
      if (j !== undefined) {
        unicode = this.u[j];
        width = t.a[j];
        if (t.vm) {
          vy = t.vm[j];
        }
      }
    }
    return {
      unicode,
      normalizedUnicode: unicode,
      width: width * this.widthScale,
      isSpace,
      vmetric: this.vertical ? [vy, 0, 0] : null,
      isUnicodeVisual: !!this.visual?.has(code),
      category: getCharUnicodeCategory(unicode),
    };
  }

  charsToGlyphs(chars) {
    let glyphs = this.#cache.get(chars);
    if (glyphs) {
      return glyphs;
    }
    glyphs = [];
    const ranges = this.t?.r;
    if (!ranges) {
      for (let i = 0; i < chars.length; i++) {
        const c = chars.charCodeAt(i);
        glyphs.push(this._glyph(c, c === 0x20));
      }
    } else {
      // CMap.readCharCode over the stored codespace ranges.
      for (let i = 0; i < chars.length;) {
        let c = 0,
          len = 0;
        for (let n = 0; n < ranges.length && !len; n++) {
          c = ((c << 8) | chars.charCodeAt(i + n)) >>> 0;
          const r = ranges[n];
          for (let k = 0; k < r.length; k += 2) {
            if (c >= r[k] && c <= r[k + 1]) {
              len = n + 1;
              break;
            }
          }
        }
        if (!len) {
          c = 0;
          len = 1;
        }
        i += len;
        glyphs.push(
          this._glyph(c, len === 1 && chars.charCodeAt(i - 1) === 0x20)
        );
      }
    }
    this.#cache.set(chars, glyphs);
    return glyphs;
  }
}

export { PdfSidecar, SIDECAR_VERSION };
