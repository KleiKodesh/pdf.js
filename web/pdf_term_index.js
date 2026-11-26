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
 * Inverted index of a PDF's pages for the find bar: a sorted term dictionary
 * with, per term, the list of pages it is on. It stores no running text, so
 * it only rules pages out: `search` returns candidate pages (a superset of
 * the pages where PDFFindController finds a match, for every option set) and
 * PDFFindController matches and counts on those pages only.
 *
 * Terms come from each page's text exactly as PDFFindController searches it
 * (getTextContent items + "\n", its `normalize()`), folded like the FM index
 * (pdf_text_index.js: marks after letters dropped, marks after other chars
 * are a barrier, space runs are one space). A term is a maximal run of chars
 * between spaces, barriers and punctuation; each punctuation char (what the
 * query regexp treats as punctuation: \p{P} and + ^ $ |) is a term of its
 * own. Chars keep their case: the query side matches every case variant.
 *
 * A query is tokenized like #convertToRegExpString and cut into atoms the
 * same way. Between two atoms the page always has a term boundary (a space,
 * or a punctuation char next to the atom), so each atom must be, on a page
 * with a match: a whole term (boundaries both sides), a term prefix (only
 * after), a suffix (only before) or a substring (a one-atom query). Each
 * atom's pages are the union of the postings of the dictionary terms it fits
 * (a regexp over the dictionary); the candidates are the intersection.
 */

import { canon, foldPage, queryTokens } from "./pdf_text_index.js";
import { normalize } from "./pdf_find_controller.js";

const TERM_INDEX_VERSION = 2;
const IS_PUNCT = /^[\p{P}+^$|]$/u;

const punctCache = new Map();
function isPunct(ch) {
  let p = punctCache.get(ch);
  if (p === undefined) {
    punctCache.set(ch, (p = IS_PUNCT.test(ch)));
  }
  return p;
}

/** The terms of a folded page (see foldPage), without duplicates. */
function pageTerms(folded) {
  const terms = new Set();
  let cur = "";
  for (const ch of folded) {
    if (ch === null || ch === false || isPunct(ch)) {
      if (cur) {
        terms.add(cur);
        cur = "";
      }
      if (ch) {
        terms.add(ch);
      }
    } else {
      cur += ch;
    }
  }
  if (cur) {
    terms.add(cur);
  }
  return terms;
}

/**
 * The query's atoms: {chars, before, after}, `before`/`after` = the page has
 * a term boundary there. Punctuation atoms are whole terms.
 */
function queryAtoms(tokens) {
  const atoms = [];
  let cur = null,
    hard = false;
  for (const t of tokens) {
    if (t.space !== undefined || isPunct(t.ch)) {
      if (cur) {
        cur.after = true;
        cur = null;
      }
      if (t.ch) {
        atoms.push({ chars: [t.ch], before: true, after: true });
      }
      hard = true;
      continue;
    }
    if (!cur) {
      cur = { chars: [], before: hard, after: false };
      atoms.push(cur);
    }
    cur.chars.push(t.ch);
  }
  return atoms;
}

function writeUint(out, v) {
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

/**
 * The searchable form: the dictionary as one string ("\n" + terms joined by
 * "\n" + "\n"), the start of each term in it, and the postings as varint page
 * deltas with the start of each term's postings.
 */
class TermView {
  constructor(terms, postings) {
    const n = terms.length;
    this.dict = "\n" + terms.join("\n") + "\n";
    const starts = (this.starts = new Int32Array(n + 1));
    let p = 1;
    for (let i = 0; i < n; i++) {
      starts[i] = p;
      p += terms[i].length + 1;
    }
    starts[n] = p;
    const bytes = [];
    const postStart = (this.postStart = new Int32Array(n + 1));
    for (let i = 0; i < n; i++) {
      postStart[i] = bytes.length;
      let prev = -1;
      for (const page of postings[i]) {
        writeUint(bytes, page - prev);
        prev = page;
      }
    }
    postStart[n] = bytes.length;
    this.post = Uint8Array.from(bytes);
    this.alphabet = new Set();
    for (const term of terms) {
      for (const ch of term) {
        this.alphabet.add(ch);
      }
    }
  }

  /** The term containing dictionary offset `pos`. */
  termAt(pos) {
    const starts = this.starts;
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
    return lo;
  }

  /** Sets mark[page] = 1 for the pages of term `i`. */
  markPages(i, mark) {
    const post = this.post,
      end = this.postStart[i + 1];
    let p = this.postStart[i],
      page = -1;
    while (p < end) {
      let v = 0,
        shift = 0,
        b;
      do {
        b = post[p++];
        v += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } while (b & 0x80);
      page += v;
      mark[page] = 1;
    }
  }

  /** The pages of term `i`. */
  *pages(i) {
    const post = this.post,
      end = this.postStart[i + 1];
    let p = this.postStart[i],
      page = -1;
    while (p < end) {
      let v = 0,
        shift = 0,
        b;
      do {
        b = post[p++];
        v += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } while (b & 0x80);
      page += v;
      yield page;
    }
  }

  /** The dictionary chars a query char matches in either case folding. */
  charClass(q) {
    const cu = canon(q, true),
      ci = canon(q, false);
    let cls = "";
    for (const p of this.alphabet) {
      if (p === q || canon(p, true) === cu || canon(p, false) === ci) {
        cls += `\\u{${p.codePointAt(0).toString(16)}}`;
      }
    }
    return cls ? `[${cls}]` : null;
  }

  /** Marks the pages of the terms an atom fits; false if none can. */
  atomPages(atom, mark) {
    let body = "";
    for (const ch of atom.chars) {
      const cls = this.charClass(ch);
      if (!cls) {
        return false;
      }
      body += cls;
    }
    const re = new RegExp(
      (atom.before ? "\\n" : "") + body + (atom.after ? "\\n" : ""),
      "gu"
    );
    const { dict, starts } = this;
    let any = false,
      m;
    while ((m = re.exec(dict)) !== null) {
      const term = this.termAt(m.index + (atom.before ? 1 : 0));
      this.markPages(term, mark);
      any = true;
      // Next term (its leading "\n" included, for the prefix anchor).
      re.lastIndex = starts[term + 1] - 1;
    }
    return any;
  }
}

class PdfTermIndex {
  constructor(numPages) {
    this.numPages = numPages;
    this.indexed = new Uint8Array(numPages);
    this._terms = new Map(); // term -> pages (while building)
    this._view = null;
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

  _thaw() {
    if (!this._terms) {
      const { terms, postings } = this._decoded || this._viewTerms();
      this._terms = new Map(terms.map((t, i) => [t, postings[i]]));
      this._decoded = null;
    }
  }

  /** Indexes consecutive pages from `firstPage`, given their raw strings. */
  addPages(firstPage, rawTexts) {
    this._thaw();
    this._view = null;
    rawTexts.forEach((raw, k) => {
      const page = firstPage + k;
      const [text] = normalize(raw);
      for (const term of pageTerms(foldPage(text))) {
        let pages = this._terms.get(term);
        if (!pages) {
          this._terms.set(term, (pages = []));
        }
        pages.push(page);
      }
      this.indexed[page] = 1;
    });
  }

  /** Sorted terms and their sorted, distinct pages. */
  _sorted() {
    if (this._decoded) {
      return this._decoded;
    }
    const terms = [...this._terms.keys()].sort();
    const postings = terms.map(t => {
      const pages = this._terms.get(t);
      for (let i = 1; i < pages.length; i++) {
        if (pages[i] <= pages[i - 1]) {
          pages.sort((a, b) => a - b);
          return pages.filter((p, j) => j === 0 || p !== pages[j - 1]);
        }
      }
      return pages;
    });
    return { terms, postings };
  }

  _getView() {
    if (!this._view) {
      const { terms, postings } = this._sorted();
      this._view = new TermView(terms, postings);
      this._decoded = null; // the view holds it; _thaw rebuilds from it
    }
    return this._view;
  }

  /**
   * @returns {{pages: Array<{pageIndex: number, count: number}>,
   *   exact: boolean, missing: number[]}} Candidate pages (count -1);
   *   `exact` only when nothing can match. `missing`: pages not indexed yet.
   */
  search({ query }) {
    const missing = [];
    for (let i = 0; i < this.numPages; i++) {
      if (!this.indexed[i]) {
        missing.push(i);
      }
    }
    const all = () => {
      const pages = [];
      for (let i = 0; i < this.numPages; i++) {
        if (this.indexed[i]) {
          pages.push({ pageIndex: i, count: -1 });
        }
      }
      return { pages, exact: false, missing };
    };
    const [normalized] = normalize(query);
    const q = queryTokens(normalized);
    if (q === null) {
      return all();
    }
    if (q.tokens === undefined) {
      return { pages: [], exact: true, missing };
    }
    const atoms = queryAtoms(q.tokens);
    if (!atoms.length) {
      return all();
    }
    const view = this._getView();
    let cand = null;
    // Selective atoms first: whole terms, then prefixes/suffixes, longer ones.
    atoms.sort(
      (a, b) =>
        b.before + b.after - (a.before + a.after) ||
        b.chars.length - a.chars.length
    );
    for (const atom of atoms) {
      const mark = new Uint8Array(this.numPages);
      if (!view.atomPages(atom, mark)) {
        cand = null;
        return { pages: [], exact: true, missing };
      }
      if (cand) {
        for (let i = 0; i < mark.length; i++) {
          cand[i] &= mark[i];
        }
      } else {
        cand = mark;
      }
    }
    const pages = [];
    for (let i = 0; i < this.numPages; i++) {
      if (cand[i]) {
        pages.push({ pageIndex: i, count: -1 });
      }
    }
    return { pages, exact: pages.length === 0, missing };
  }

  /**
   * Compact binary form (deflate-raw it to store): version, pages, indexed
   * runs, alphabet (by frequency), then per sorted term: shared prefix and
   * suffix lengths, suffix chars, page count and page deltas (all varints).
   */
  encode() {
    let terms, postings;
    if (this._terms) {
      ({ terms, postings } = this._sorted());
    } else {
      ({ terms, postings } = this._viewTerms());
    }
    const out = [];
    writeUint(out, TERM_INDEX_VERSION);
    writeUint(out, this.numPages);
    const runs = [];
    let state = 0,
      len = 0;
    for (const v of this.indexed) {
      if (v !== state) {
        runs.push(len);
        state = v;
        len = 0;
      }
      len++;
    }
    runs.push(len);
    writeUint(out, runs.length);
    for (const r of runs) {
      writeUint(out, r);
    }
    const freq = new Map();
    const cps = terms.map(t => Array.from(t, c => c.codePointAt(0)));
    for (const a of cps) {
      for (const c of a) {
        freq.set(c, (freq.get(c) || 0) + 1);
      }
    }
    const alphabet = [...freq.keys()].sort(
      (a, b) => freq.get(b) - freq.get(a) || a - b
    );
    const idx = new Map(alphabet.map((c, i) => [c, i]));
    writeUint(out, alphabet.length);
    for (const c of alphabet) {
      writeUint(out, c);
    }
    writeUint(out, terms.length);
    let prev = [];
    cps.forEach((a, i) => {
      let shared = 0;
      while (
        shared < a.length &&
        shared < prev.length &&
        a[shared] === prev[shared]
      ) {
        shared++;
      }
      writeUint(out, shared);
      writeUint(out, a.length - shared);
      for (let k = shared; k < a.length; k++) {
        writeUint(out, idx.get(a[k]));
      }
      const pages = postings[i];
      writeUint(out, pages.length);
      let last = -1;
      for (const p of pages) {
        writeUint(out, p - last);
        last = p;
      }
      prev = a;
    });
    return Uint8Array.from(out);
  }

  /** Terms and postings back from the view (after a load). */
  _viewTerms() {
    const v = this._getView();
    const n = v.starts.length - 1;
    const terms = [],
      postings = [];
    for (let i = 0; i < n; i++) {
      terms.push(v.dict.slice(v.starts[i], v.starts[i + 1] - 1));
      postings.push([...v.pages(i)]);
    }
    return { terms, postings };
  }

  /** @returns {PdfTermIndex|null} */
  static decode(buf) {
    let pos = 0;
    const uint = () => {
      let v = 0,
        shift = 0,
        b;
      do {
        b = buf[pos++];
        v += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } while (b & 0x80);
      return v;
    };
    if (uint() !== TERM_INDEX_VERSION) {
      return null;
    }
    const index = new PdfTermIndex(uint());
    let p = 0,
      state = 0;
    for (let r = uint(); r > 0; r--) {
      const len = uint();
      if (state) {
        index.indexed.fill(1, p, p + len);
      }
      p += len;
      state ^= 1;
    }
    const alphabet = [];
    for (let i = uint(); i > 0; i--) {
      alphabet.push(String.fromCodePoint(uint()));
    }
    const terms = [],
      postings = [];
    let prev = [];
    for (let n = uint(); n > 0; n--) {
      const shared = uint();
      const chars = prev.slice(0, shared);
      for (let k = uint(); k > 0; k--) {
        chars.push(alphabet[uint()]);
      }
      terms.push(chars.join(""));
      const pages = [];
      let last = -1;
      for (let k = uint(); k > 0; k--) {
        last += uint();
        pages.push(last);
      }
      postings.push(pages);
      prev = chars;
    }
    index._terms = null;
    index._decoded = { terms, postings };
    index._getView();
    return index;
  }

  /** Bytes held in memory by the search structures (approximate). */
  get memoryBytes() {
    const v = this._getView();
    return (
      v.dict.length * 2 +
      v.starts.byteLength +
      v.post.byteLength +
      v.postStart.byteLength
    );
  }
}

export { pageTerms, PdfTermIndex, queryAtoms };
