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
 * A small FM-index over a text of dense integer symbols (any alphabet size):
 *  - suffix array by prefix doubling (radix sorted ranks),
 *  - BWT held in a wavelet matrix (one rank bitvector per symbol bit),
 *  - suffix-array samples every `SAMPLE` text positions, to locate hits.
 * Symbol 0 must occur exactly once, as the last symbol of the text.
 *
 * Only the BWT is stored (it deflates best); the wavelet matrix, the counts
 * and the samples are rebuilt from it on load in linear time.
 */

const SAMPLE = 32;

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Bitvector with rank1: one cumulative count per 4 words (128 bits). */
class RankBits {
  constructor(n) {
    this.n = n;
    this.words = new Uint32Array((n >>> 5) + 1);
    this.cum = null;
  }

  set(i) {
    this.words[i >>> 5] |= 1 << (i & 31);
  }

  get(i) {
    return (this.words[i >>> 5] >>> (i & 31)) & 1;
  }

  finish() {
    const w = this.words;
    const cum = (this.cum = new Uint32Array((w.length >>> 2) + 1));
    let c = 0;
    for (let i = 0; i < w.length; i++) {
      if ((i & 3) === 0) {
        cum[i >>> 2] = c;
      }
      c += popcount(w[i]);
    }
    this.ones = c;
  }

  /** Number of 1 bits in [0, i). */
  rank1(i) {
    const wi = i >>> 5;
    const w = this.words;
    let r = this.cum[wi >>> 2];
    for (let j = wi & ~3; j < wi; j++) {
      r += popcount(w[j]);
    }
    const b = i & 31;
    return b ? r + popcount(w[wi] << (32 - b)) : r;
  }
}

/** Suffix array of `t` (symbols < sigma, t[n-1] = 0 unique smallest). */
function suffixArray(t, sigma) {
  const n = t.length;
  const sa = new Int32Array(n);
  let rank = new Int32Array(n);
  let tmp = new Int32Array(n);
  let sa2 = new Int32Array(n);
  let cnt = new Int32Array(Math.max(sigma, n) + 1);
  for (let i = 0; i < n; i++) {
    cnt[t[i]]++;
  }
  for (let c = 1; c < sigma; c++) {
    cnt[c] += cnt[c - 1];
  }
  for (let i = n - 1; i >= 0; i--) {
    sa[--cnt[t[i]]] = i;
  }
  rank[sa[0]] = 0;
  let classes = 1;
  for (let i = 1; i < n; i++) {
    if (t[sa[i]] !== t[sa[i - 1]]) {
      classes++;
    }
    rank[sa[i]] = classes - 1;
  }
  for (let k = 1; classes < n; k <<= 1) {
    // Order by the second key: suffixes without one first, then by sa.
    let p = 0;
    for (let i = n - k; i < n; i++) {
      sa2[p++] = i;
    }
    for (let i = 0; i < n; i++) {
      if (sa[i] >= k) {
        sa2[p++] = sa[i] - k;
      }
    }
    // Stable counting sort by the first key.
    cnt.fill(0, 0, classes + 1);
    for (let i = 0; i < n; i++) {
      cnt[rank[i]]++;
    }
    for (let c = 1; c < classes; c++) {
      cnt[c] += cnt[c - 1];
    }
    for (let i = n - 1; i >= 0; i--) {
      const s = sa2[i];
      sa[--cnt[rank[s]]] = s;
    }
    tmp[sa[0]] = 0;
    classes = 1;
    for (let i = 1; i < n; i++) {
      const a = sa[i - 1],
        b = sa[i];
      if (
        rank[a] !== rank[b] ||
        (a + k < n ? rank[a + k] : -1) !== (b + k < n ? rank[b + k] : -1)
      ) {
        classes++;
      }
      tmp[b] = classes - 1;
    }
    [rank, tmp] = [tmp, rank];
  }
  sa2 = tmp = rank = cnt = null;
  return sa;
}

class FmIndex {
  /**
   * @param {Uint32Array|Uint16Array|Uint8Array} bwt
   * @param {number} sigma
   */
  constructor(bwt, sigma) {
    const n = bwt.length;
    this.n = n;
    this.sigma = sigma;
    let levels = 1;
    while (1 << levels < sigma) {
      levels++;
    }
    this.levels = levels;

    // Counts and LF (temporary) for the samples.
    const C = (this.C = new Int32Array(sigma + 1));
    for (let i = 0; i < n; i++) {
      C[bwt[i] + 1]++;
    }
    for (let c = 0; c < sigma; c++) {
      C[c + 1] += C[c];
    }
    let row0 = -1;
    {
      const occ = C.slice(0, sigma);
      const lf = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const c = bwt[i];
        if (c === 0) {
          row0 = i;
        }
        lf[i] = occ[c]++;
      }
      // Walk the text backward from the row of position 0.
      const mark = (this.mark = new RankBits(n));
      const rows = [];
      let row = row0,
        pos = 0;
      for (let k = 0; k < n; k++) {
        if (pos % SAMPLE === 0) {
          mark.set(row);
          rows.push(row, pos);
        }
        row = lf[row];
        pos = pos === 0 ? n - 1 : pos - 1;
      }
      mark.finish();
      const samples = (this.samples = new Int32Array(rows.length >> 1));
      for (let i = 0; i < rows.length; i += 2) {
        samples[mark.rank1(rows[i])] = rows[i + 1];
      }
    }

    // Wavelet matrix.
    this.bits = [];
    this.zeros = new Int32Array(levels);
    let cur = bwt instanceof Uint32Array ? bwt.slice() : Uint32Array.from(bwt);
    let next = new Uint32Array(n);
    for (let l = 0; l < levels; l++) {
      const shift = levels - 1 - l;
      const bv = new RankBits(n);
      let z = 0;
      for (let i = 0; i < n; i++) {
        if (((cur[i] >>> shift) & 1) === 0) {
          z++;
        }
      }
      let zi = 0,
        oi = z;
      for (let i = 0; i < n; i++) {
        const c = cur[i];
        if ((c >>> shift) & 1) {
          bv.set(i);
          next[oi++] = c;
        } else {
          next[zi++] = c;
        }
      }
      bv.finish();
      this.bits.push(bv);
      this.zeros[l] = z;
      [cur, next] = [next, cur];
    }
    // Final-level start of each symbol (rank(c, i) = map_c(i) - start[c]).
    const start = (this.start = new Int32Array(sigma));
    for (let c = 0; c < sigma; c++) {
      start[c] = this._map(c, 0);
    }
  }

  static build(text, sigma) {
    const sa = suffixArray(text, sigma);
    const n = text.length;
    const bwt = sigma <= 256 ? new Uint8Array(n) : new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const p = sa[i];
      bwt[i] = text[p === 0 ? n - 1 : p - 1];
    }
    const fm = new FmIndex(bwt, sigma);
    fm.bwt = bwt;
    return fm;
  }

  _map(c, i) {
    const { levels, bits, zeros } = this;
    for (let l = 0; l < levels; l++) {
      const bv = bits[l];
      if ((c >>> (levels - 1 - l)) & 1) {
        i = zeros[l] + bv.rank1(i);
      } else {
        i -= bv.rank1(i);
      }
    }
    return i;
  }

  /** Number of `c` in BWT[0, i). */
  rank(c, i) {
    return this._map(c, i) - this.start[c];
  }

  /** Row range of `c` followed by the rows [sp, ep). */
  step(c, sp, ep) {
    if (c >= this.sigma) {
      return [0, 0];
    }
    const base = this.C[c];
    return [base + this.rank(c, sp), base + this.rank(c, ep)];
  }

  /** LF of row `i`: [row of the previous text position, symbol]. */
  _lf(i) {
    const { levels, bits, zeros } = this;
    let c = 0;
    for (let l = 0; l < levels; l++) {
      const bv = bits[l];
      if (bv.get(i)) {
        c = (c << 1) | 1;
        i = zeros[l] + bv.rank1(i);
      } else {
        c <<= 1;
        i -= bv.rank1(i);
      }
    }
    return this.C[c] + i - this.start[c];
  }

  /** The BWT again, read from the wavelet matrix (for storing). */
  extractBwt() {
    const { n, levels, bits, zeros } = this;
    const out = this.sigma <= 256 ? new Uint8Array(n) : new Uint32Array(n);
    for (let k = 0; k < n; k++) {
      let c = 0,
        i = k;
      for (let l = 0; l < levels; l++) {
        const bv = bits[l];
        if (bv.get(i)) {
          c = (c << 1) | 1;
          i = zeros[l] + bv.rank1(i);
        } else {
          c <<= 1;
          i -= bv.rank1(i);
        }
      }
      out[k] = c;
    }
    return out;
  }

  /** Text position of row `i`. */
  locate(i) {
    const { mark, samples, n } = this;
    let steps = 0;
    while (!mark.get(i)) {
      i = this._lf(i);
      steps++;
    }
    return (samples[mark.rank1(i)] + steps) % n;
  }
}

export { FmIndex, suffixArray };
