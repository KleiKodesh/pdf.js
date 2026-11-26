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
 * Full-text index of a PDF's pages for the find bar: an FM-index (see
 * pdf_fm_index.js) over each page's text exactly as PDFFindController
 * searches it (getTextContent items + "\n", then its `normalize()`), folded so
 * one index answers the default search (case and diacritics ignored) with the
 * same matches and counts as PDFFindController's regular expression:
 *  - case: each char is mapped to its class under both the "i" and the "iu"
 *    regexp folding (PDFFindController uses "u" only on pages with
 *    diacritics); a query char matches the classes equal in the page's mode,
 *  - diacritics: marks after a letter are dropped (the query's `L\p{M}*`),
 *    marks after anything else become a barrier no query char matches,
 *  - spaces: runs become one space (the query's `[ ]+` / `[ ]*`).
 * Other options (case, diacritics, whole words) and unusual queries return
 * candidate pages (a superset) that PDFFindController then searches itself.
 *
 * The index grows in chunks (pages indexed together); each chunk is one
 * FM-index. Only the chunks' BWTs are stored.
 */

import { FmIndex } from "./pdf_fm_index.js";
import { normalize } from "./pdf_find_controller.js";

const TEXT_INDEX_VERSION = 1;
const END = 0,
  SEP = 1,
  BARRIER = 2,
  SPACE = 3,
  FIRST_CHAR = 4;

// Above this many occurrences a search returns candidate pages instead of
// locating every hit (single letters, very common pairs).
const LOCATE_LIMIT = 20000;

const IS_LETTER = /^\p{L}$/u;
const IS_MARK = /^\p{M}$/u;
// Same as PDFFindController's SPECIAL_CHARS_REG_EXP.
const SPECIAL_CHARS_REG_EXP = /([+^$|])|(\p{P}+)|(\s+)|(\p{M})|(\p{L})/gu;
// Same as PDFFindController's DIACRITICS_EXCEPTION.
const DIACRITICS_EXCEPTION = new Set([
  0x3099, 0x309a, 0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d,
  0x0ccd, 0x0d3b, 0x0d3c, 0x0d4d, 0x0dca, 0x0e3a, 0x0eba, 0x0f84, 0x1039,
  0x103a, 0x1714, 0x1734, 0x17d2, 0x1a60, 0x1b44, 0x1baa, 0x1bab, 0x1bf2,
  0x1bf3, 0x2d7f, 0xa806, 0xa82c, 0xa8c4, 0xa953, 0xa9c0, 0xaaf6, 0xabed,
  0x0c56, 0x0f71, 0x0f72, 0x0f7a, 0x0f7b, 0x0f7c, 0x0f7d, 0x0f80, 0x0f74,
]);

const letterCache = new Map();
function charKind(ch) {
  let k = letterCache.get(ch);
  if (k === undefined) {
    k = 0;
    if (IS_LETTER.test(ch)) {
      k = 1;
    } else if (IS_MARK.test(ch)) {
      k = 2;
    }
    letterCache.set(ch, k);
  }
  return k;
}

// The class of a char under a regexp case folding: the smallest char among
// its upper/lower case relatives that the regexp says is equal to it.
const canonCache = [new Map(), new Map()];
function canon(ch, unicode) {
  const cache = canonCache[unicode ? 1 : 0];
  let r = cache.get(ch);
  if (r !== undefined) {
    return r;
  }
  r = ch;
  if (unicode || ch.length === 1) {
    const re = new RegExp(RegExp.escape(ch), unicode ? "iu" : "i");
    const seen = new Set([ch]);
    const todo = [ch];
    while (todo.length) {
      const c = todo.pop();
      for (const d of [c.toLowerCase(), c.toUpperCase()]) {
        if (seen.has(d) || [...d].length !== 1) {
          continue;
        }
        seen.add(d);
        if (
          re.test(d) &&
          new RegExp(`^${RegExp.escape(d)}$`, re.flags).test(ch)
        ) {
          todo.push(d);
          if (d < r) {
            r = d;
          }
        }
      }
    }
  }
  cache.set(ch, r);
  return r;
}

/** The class key of a char for the index: both foldings. */
function classKey(ch) {
  return canon(ch, true) + "\u0000" + canon(ch, false);
}

/**
 * Folds PDFFindController's normalized page text into class keys (see the
 * comment at the top). Returns an array of keys (null = space, false =
 * barrier).
 */
function foldPage(text) {
  const out = [];
  let prev = 0; // 0: other, 1: letter (marks absorbed), 2: barrier, 3: space
  for (const ch of text) {
    if (ch === " ") {
      if (prev !== 3) {
        out.push(null);
      }
      prev = 3;
      continue;
    }
    const kind = charKind(ch);
    if (kind === 2) {
      if (prev === 1 || prev === 2) {
        continue;
      }
      out.push(false);
      prev = 2;
      continue;
    }
    out.push(ch);
    prev = kind === 1 ? 1 : 0;
  }
  return out;
}

/**
 * The default-options query as tokens, following #convertToRegExpString:
 * chars, and spaces (`min` 1 = `[ ]+`, 0 = `[ ]*`). Returns null when the
 * query is outside what the index answers exactly.
 */
function queryTokens(query) {
  const tokens = [];
  let hasLetter = false;
  let unsupported = false;
  const addChars = s => {
    for (const ch of s) {
      tokens.push({ ch });
    }
  };
  const addExtraWhitespaces = original => {
    if (original === query) {
      addChars(original);
    } else if (query.startsWith(original)) {
      addChars(original);
      tokens.push({ space: 0 });
    } else if (query.endsWith(original)) {
      tokens.push({ space: 0 });
      addChars(original);
    } else {
      tokens.push({ space: 0 });
      addChars(original);
      tokens.push({ space: 0 });
    }
  };
  let last = 0;
  for (const m of query.matchAll(SPECIAL_CHARS_REG_EXP)) {
    addChars(query.slice(last, m.index));
    last = m.index + m[0].length;
    const [, p1, p2, p3, p4, p5] = m;
    if (p1 || p2) {
      addExtraWhitespaces(p1 || p2);
    } else if (p3) {
      tokens.push({ space: 1 });
    } else if (p4) {
      if (DIACRITICS_EXCEPTION.has(p4.charCodeAt(0))) {
        unsupported = true;
      }
    } else {
      hasLetter = true;
      tokens.push({ ch: p5 });
    }
  }
  addChars(query.slice(last));
  if (tokens.length && tokens.at(-1).space === 0) {
    tokens.pop();
  }
  // Merge space runs like the "[ ]{n,}" rewrite.
  const merged = [];
  for (const t of tokens) {
    const prev = merged.at(-1);
    if (t.space !== undefined && prev?.space !== undefined) {
      merged[merged.length - 1] = { space: prev.space + t.space };
    } else {
      merged.push(t);
    }
  }
  if (
    unsupported ||
    !merged.length ||
    merged[0].space !== undefined ||
    merged.some(t => t.space > 1)
  ) {
    return merged.length || unsupported ? null : [];
  }
  return { tokens: merged, hasLetter };
}

class TextIndexChunk {
  /**
   * @param {object} data - {firstPage, pageLengths, diacritics, alphabet,
   *   bwt}
   */
  constructor(data) {
    Object.assign(this, data);
    const starts = (this.starts = new Int32Array(this.pageLengths.length + 1));
    for (let i = 0; i < this.pageLengths.length; i++) {
      starts[i + 1] = starts[i] + this.pageLengths[i] + 1; // + SEP
    }
    this.fm = new FmIndex(this.bwt, this.alphabet.length + FIRST_CHAR);
    this.bwt = null; // held by the wavelet matrix; see toJSON
    // Per mode: canonical char -> symbols.
    this.bySymbol = [new Map(), new Map()];
    this.alphabet.forEach((ch, i) => {
      for (const mode of [0, 1]) {
        const k = canon(ch, mode === 1);
        const map = this.bySymbol[mode];
        let a = map.get(k);
        if (!a) {
          map.set(k, (a = []));
        }
        a.push(i + FIRST_CHAR);
      }
    });
  }

  static build(firstPage, folded, diacritics) {
    const keyToSymbol = new Map();
    const alphabet = [];
    for (const page of folded) {
      for (const ch of page) {
        if (ch && !keyToSymbol.has(classKey(ch))) {
          keyToSymbol.set(classKey(ch), -1);
          alphabet.push(ch);
        }
      }
    }
    alphabet.sort();
    alphabet.forEach((ch, i) => keyToSymbol.set(classKey(ch), i + FIRST_CHAR));
    let n = 1;
    for (const page of folded) {
      n += page.length + 1;
    }
    const text = new Uint32Array(n);
    let p = 0;
    for (const page of folded) {
      for (const ch of page) {
        if (ch === null) {
          text[p++] = SPACE;
        } else if (ch === false) {
          text[p++] = BARRIER;
        } else {
          text[p++] = keyToSymbol.get(classKey(ch));
        }
      }
      text[p++] = SEP;
    }
    text[p] = END;
    const sigma = alphabet.length + FIRST_CHAR;
    const fm = FmIndex.build(text, sigma);
    const chunk = new TextIndexChunk({
      firstPage,
      pageLengths: folded.map(f => f.length),
      diacritics: diacritics.map(Boolean),
      alphabet,
      bwt: fm.bwt,
    });
    return chunk;
  }

  /** Symbols a query char matches in a mode (0: "i", 1: "iu"). */
  _symbols(ch, mode) {
    return this.bySymbol[mode].get(canon(ch, mode === 1)) ?? [];
  }

  /** Backward search: the row ranges [sp, ep, length] of the tokens. */
  _ranges(tokens, mode) {
    const fm = this.fm;
    let states = [[0, fm.n, 0]];
    for (let t = tokens.length - 1; t >= 0 && states.length; t--) {
      const tok = tokens[t];
      const next = [];
      if (tok.space !== undefined) {
        for (const [sp, ep, len] of states) {
          const [a, b] = fm.step(SPACE, sp, ep);
          if (a < b) {
            next.push([a, b, len + 1]);
          }
          if (tok.space === 0) {
            next.push([sp, ep, len]);
          }
        }
      } else {
        const syms = this._symbols(tok.ch, mode);
        for (const [sp, ep, len] of states) {
          for (const s of syms) {
            const [a, b] = fm.step(s, sp, ep);
            if (a < b) {
              next.push([a, b, len + 1]);
            }
          }
        }
      }
      states = next;
    }
    return states;
  }

  /**
   * Occurrences in row ranges, for pages of one mode: [pageIndex, offset,
   * length] (offsets in the folded page).
   */
  _locate(states, pageFilter, out) {
    const { starts, firstPage } = this;
    for (const [sp, ep, len] of states) {
      for (let r = sp; r < ep; r++) {
        const pos = this.fm.locate(r);
        // Page: last start <= pos.
        let lo = 0,
          hi = starts.length - 1;
        while (lo < hi - 1) {
          const mid = (lo + hi) >> 1;
          if (starts[mid] <= pos) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
        if (pageFilter(lo)) {
          out.push([firstPage + lo, pos - starts[lo], len]);
        }
      }
    }
  }

  /**
   * Backward search only; returns {occurrences, pages(): candidate pages,
   * locate(): hits [pageIndex, offset, length]}.
   */
  search(q) {
    const { tokens, hasLetter } = q;
    const diacritics = this.diacritics;
    // The "u" folding is used on pages with diacritics when the query has
    // letters; search once per mode only when the two differ.
    let differ = false;
    if (hasLetter) {
      for (const t of tokens) {
        if (t.ch) {
          const a = this._symbols(t.ch, 0),
            b = this._symbols(t.ch, 1);
          if (a.length !== b.length || a.some((s, i) => s !== b[i])) {
            differ = true;
            break;
          }
        }
      }
    }
    const runs = differ
      ? [
          [this._ranges(tokens, 0), p => !diacritics[p]],
          [this._ranges(tokens, 1), p => diacritics[p]],
        ]
      : [[this._ranges(tokens, hasLetter ? 1 : 0), () => true]];
    let occurrences = 0;
    for (const [states] of runs) {
      for (const [sp, ep] of states) {
        occurrences += ep - sp;
      }
    }
    return {
      occurrences,
      pages: () => Array.from(this.pageLengths, (_, i) => this.firstPage + i),
      locate: () => {
        const hits = [];
        for (const [states, filter] of runs) {
          this._locate(states, filter, hits);
        }
        return hits;
      },
    };
  }
}

/** Non-overlapping leftmost matches, like a global regexp: [page, count]. */
function countPerPage(hits) {
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || b[2] - a[2]);
  const pages = [];
  let page = -1,
    end = -1,
    count = 0;
  for (const [p, off, len] of hits) {
    if (p !== page) {
      if (count) {
        pages.push({ pageIndex: page, count });
      }
      page = p;
      end = -1;
      count = 0;
    }
    if (off >= end) {
      count++;
      end = off + len;
    }
  }
  if (count) {
    pages.push({ pageIndex: page, count });
  }
  return pages;
}

class PdfTextIndex {
  constructor(numPages) {
    this.numPages = numPages;
    this.chunks = [];
    this.indexed = new Uint8Array(numPages);
  }

  get complete() {
    return this.indexed.every(Boolean);
  }

  /** The raw page string PDFFindController builds from getTextContent. */
  static pageString(textContent) {
    const strBuf = [];
    for (const textItem of textContent.items) {
      strBuf.push(textItem.str);
      if (textItem.hasEOL) {
        strBuf.push("\n");
      }
    }
    return strBuf.join("");
  }

  /**
   * Indexes consecutive pages from `firstPage`, given their raw page strings
   * (see `pageString`), as one chunk.
   */
  addPages(firstPage, rawTexts) {
    const folded = [],
      diacritics = [];
    for (const raw of rawTexts) {
      const [text, , hasDiacritics] = normalize(raw);
      folded.push(foldPage(text));
      diacritics.push(hasDiacritics);
    }
    this.chunks.push(TextIndexChunk.build(firstPage, folded, diacritics));
    this.indexed.fill(1, firstPage, firstPage + rawTexts.length);
  }

  /**
   * @returns {{pages: Array<{pageIndex: number, count: number}>,
   *   exact: boolean, missing: number[]}} With `exact`, `pages` are the
   *   matches PDFFindController finds on the indexed pages; otherwise they
   *   are candidate pages (counts unknown). `missing` lists the pages not
   *   indexed yet.
   */
  search({
    query,
    caseSensitive = false,
    entireWord = false,
    matchDiacritics = false,
  }) {
    const missing = [];
    for (let i = 0; i < this.numPages; i++) {
      if (!this.indexed[i]) {
        missing.push(i);
      }
    }
    const [normalized] = normalize(query);
    const q = queryTokens(normalized);
    if (q === null) {
      // Not answered by the index: every indexed page is a candidate.
      const pages = [];
      for (let i = 0; i < this.numPages; i++) {
        if (this.indexed[i]) {
          pages.push({ pageIndex: i, count: -1 });
        }
      }
      return { pages, exact: false, missing };
    }
    if (q.tokens === undefined) {
      return { pages: [], exact: true, missing };
    }
    const found = this.chunks.map(chunk => chunk.search(q));
    const occurrences = found.reduce((a, f) => a + f.occurrences, 0);
    if (occurrences > LOCATE_LIMIT) {
      // Locating that many hits costs more than PDFFindController reading
      // the pages: the chunks with hits are the candidates.
      const pages = [];
      for (const f of found) {
        if (f.occurrences) {
          for (const pageIndex of f.pages()) {
            pages.push({ pageIndex, count: -1 });
          }
        }
      }
      return { pages, exact: false, missing };
    }
    const hits = [];
    for (const f of found) {
      if (f.occurrences) {
        for (const h of f.locate()) {
          hits.push(h);
        }
      }
    }
    const pages = countPerPage(hits);
    const exact = !caseSensitive && !entireWord && !matchDiacritics;
    if (!exact) {
      for (const p of pages) {
        p.count = -1;
      }
    }
    return { pages, exact, missing };
  }

  /** Stored form: {v, numPages, chunks: [{firstPage, pageLengths, ...}]}. */
  toJSON() {
    return {
      v: TEXT_INDEX_VERSION,
      numPages: this.numPages,
      chunks: this.chunks.map(c => ({
        firstPage: c.firstPage,
        pageLengths: c.pageLengths,
        diacritics: c.diacritics,
        alphabet: c.alphabet,
        bwt: c.fm.extractBwt(),
      })),
    };
  }

  static fromJSON(data) {
    if (data?.v !== TEXT_INDEX_VERSION) {
      return null;
    }
    const index = new PdfTextIndex(data.numPages);
    for (const c of data.chunks) {
      const chunk = new TextIndexChunk(c);
      index.chunks.push(chunk);
      index.indexed.fill(
        1,
        chunk.firstPage,
        chunk.firstPage + chunk.pageLengths.length
      );
    }
    return index;
  }

  /** Compact binary form (deflate-raw it to store). */
  encode() {
    return encodeTextIndex(this.toJSON());
  }

  /** @returns {PdfTextIndex|null} */
  static decode(buf) {
    return PdfTextIndex.fromJSON(decodeTextIndex(buf));
  }

  /** Bytes held in memory by the index structures (approximate). */
  get memoryBytes() {
    let b = 0;
    for (const c of this.chunks) {
      const fm = c.fm;
      for (const bv of fm.bits) {
        b += bv.words.byteLength + bv.cum.byteLength;
      }
      b += fm.mark.words.byteLength + fm.mark.cum.byteLength;
      b += fm.samples.byteLength + c.starts.byteLength;
    }
    return b;
  }
}

// --- compact binary form (deflate-raw it to store) --------------------------

class Writer {
  constructor() {
    this.buf = new Uint8Array(1 << 16);
    this.pos = 0;
  }

  _room(n) {
    if (this.pos + n > this.buf.length) {
      const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
      b.set(this.buf);
      this.buf = b;
    }
  }

  uint(v) {
    this._room(5);
    while (v > 0x7f) {
      this.buf[this.pos++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buf[this.pos++] = v;
  }

  bytes(b) {
    this._room(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  result() {
    return this.buf.slice(0, this.pos);
  }
}

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  uint() {
    let v = 0,
      shift = 0,
      b;
    do {
      b = this.buf[this.pos++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return v;
  }

  bytes(n) {
    return this.buf.subarray(this.pos, (this.pos += n));
  }
}

function encodeTextIndex(data) {
  const w = new Writer();
  w.uint(data.v);
  w.uint(data.numPages);
  w.uint(data.chunks.length);
  for (const c of data.chunks) {
    w.uint(c.firstPage);
    w.uint(c.pageLengths.length);
    c.pageLengths.forEach((len, i) =>
      w.uint(len * 2 + (c.diacritics[i] ? 1 : 0))
    );
    w.uint(c.alphabet.length);
    for (const ch of c.alphabet) {
      w.uint(ch.codePointAt(0));
    }
    w.uint(c.bwt.length);
    if (c.bwt instanceof Uint8Array) {
      w.bytes(c.bwt);
    } else {
      for (const s of c.bwt) {
        w.uint(s);
      }
    }
  }
  return w.result();
}

function decodeTextIndex(buf) {
  const r = new Reader(buf);
  const data = { v: r.uint(), numPages: r.uint(), chunks: [] };
  for (let k = r.uint(); k > 0; k--) {
    const firstPage = r.uint();
    const pageLengths = [],
      diacritics = [];
    for (let i = r.uint(); i > 0; i--) {
      const v = r.uint();
      pageLengths.push(Math.floor(v / 2));
      diacritics.push(v % 2 === 1);
    }
    const alphabet = [];
    for (let i = r.uint(); i > 0; i--) {
      alphabet.push(String.fromCodePoint(r.uint()));
    }
    const n = r.uint();
    let bwt;
    if (alphabet.length + FIRST_CHAR <= 256) {
      bwt = r.bytes(n).slice();
    } else {
      bwt = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        bwt[i] = r.uint();
      }
    }
    data.chunks.push({ firstPage, pageLengths, diacritics, alphabet, bwt });
  }
  return data;
}

export {
  canon,
  decodeTextIndex,
  encodeTextIndex,
  foldPage,
  PdfTextIndex,
  queryTokens,
};
