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
 * Compact binary form of the sidecar data (format v1 objects, see
 * src/core/pdf_sidecar.js), stored deflate-raw compressed.
 *
 * - varints everywhere; stream offsets as deltas from the previous stream's
 *   end, object numbers as deltas;
 * - one shared table for every string (Unicode values, resource names,
 *   filter lists);
 * - a font table is written as a diff against the most similar earlier
 *   table (subset fonts of one base font share nearly all their entries):
 *   the base codes it drops plus the entries it adds or changes.
 */

const MAGIC = 0x32435300; // "\0SC2"
const BASE_WINDOW = 32;
const SEP = "\uFFFF";

class Writer {
  constructor() {
    this.buf = new Uint8Array(1 << 16);
    this.pos = 0;
  }

  _ensure(n) {
    if (this.pos + n > this.buf.length) {
      const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
      b.set(this.buf.subarray(0, this.pos));
      this.buf = b;
    }
  }

  u(v) {
    this._ensure(10);
    // Values can exceed 2^31 (stream offsets, CID codes): no bit ops.
    while (v >= 0x80) {
      this.buf[this.pos++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.pos++] = v;
  }

  s(v) {
    this.u(v < 0 ? -2 * v - 1 : 2 * v);
  }

  f64(v) {
    this._ensure(8);
    new DataView(this.buf.buffer).setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  bytes(b) {
    this.u(b.length);
    this._ensure(b.length);
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

  u() {
    let v = 0,
      mul = 1,
      b;
    do {
      b = this.buf[this.pos++];
      v += (b & 0x7f) * mul;
      mul *= 0x80;
    } while (b & 0x80);
    return v;
  }

  s() {
    const v = this.u();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }

  f64() {
    const v = new DataView(
      this.buf.buffer,
      this.buf.byteOffset + this.pos,
      8
    ).getFloat64(0, true);
    this.pos += 8;
    return v;
  }

  bytes() {
    const n = this.u();
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
}

function fontEntries(t) {
  const u = t.u ? t.u.split(SEP) : [];
  const m = new Set(t.m || []);
  const out = new Map();
  for (let i = 0; i < t.k.length; i++) {
    out.set(
      t.k[i],
      `${u[i] ?? ""}${SEP}${t.a[i]}${SEP}${t.vm ? t.vm[i] : 0}${SEP}${m.has(t.k[i]) ? 1 : 0}`
    );
  }
  return out;
}

function refKey(w, key) {
  const m = /^(\d+)R(\d*)$/.exec(key);
  w.u(+m[1]);
  w.u(m[2] ? +m[2] : 0);
}

function readRef(r) {
  const num = r.u(),
    gen = r.u();
  return gen ? `${num}R${gen}` : `${num}R`;
}

function encodeSidecar(data) {
  const strings = new Map();
  const str = s => {
    let i = strings.get(s);
    if (i === undefined) {
      strings.set(s, (i = strings.size));
    }
    return i;
  };
  const body = new Writer();
  body.u(data.numPages);

  // Fonts.
  const entries = data.fonts.map(t => (t ? fontEntries(t) : null));
  body.u(data.fonts.length);
  data.fonts.forEach((t, fi) => {
    if (!t) {
      body.u(0);
      return;
    }
    const flags =
      1 |
      (t.t ? 2 : 0) |
      (t.i ? 4 : 0) |
      (t.v ? 8 : 0) |
      (t.vm ? 16 : 0) |
      (t.t3 ? 32 : 0) |
      (t.m ? 64 : 0);
    body.u(flags);
    body.s(t.d);
    body.s(t.sp);
    if (t.vm) {
      body.s(t.dv);
    }
    if (t.t) {
      body.u(t.r.length);
      for (const r of t.r) {
        body.u(r.length);
        for (const x of r) {
          body.u(x);
        }
      }
    }
    if (t.t3) {
      for (const x of t.t3.fm) {
        body.f64(x);
      }
      body.u(t.t3.bbox ? 1 : 0);
      for (const x of t.t3.bbox || []) {
        body.f64(x);
      }
      body.u(t.t3.cb ? 1 : 0);
    }
    // Most similar earlier table of the same kind.
    const mine = entries[fi];
    let base = -1,
      best = 0;
    for (let b = Math.max(0, fi - BASE_WINDOW); b < fi; b++) {
      const other = entries[b];
      if (!other || data.fonts[b].t !== t.t || !!data.fonts[b].vm !== !!t.vm) {
        continue;
      }
      let same = 0;
      for (const [code, e] of other) {
        same += mine.get(code) === e ? 1 : -1;
      }
      if (same > best) {
        best = same;
        base = b;
      }
    }
    body.u(fi - base); // 0 would be self: base < fi, so >= 1; fi + 1 = none
    const baseEntries = base >= 0 ? entries[base] : new Map();
    const dropped = [];
    for (const [code, e] of baseEntries) {
      if (mine.get(code) !== e) {
        dropped.push(code);
      }
    }
    body.u(dropped.length);
    let prev = 0;
    for (const code of dropped) {
      body.u(code - prev);
      prev = code;
    }
    const added = [];
    for (const [code, e] of mine) {
      if (baseEntries.get(code) !== e) {
        added.push(code);
      }
    }
    body.u(added.length);
    prev = 0;
    const idx = new Map();
    for (let i = 0; i < t.k.length; i++) {
      idx.set(t.k[i], i);
    }
    const u = t.u ? t.u.split(SEP) : [];
    const m = new Set(t.m || []);
    for (const code of added) {
      const i = idx.get(code);
      body.u(code - prev);
      prev = code;
      body.u(str(u[i] ?? ""));
      body.s(t.a[i]);
      if (t.vm) {
        body.s(t.vm[i]);
      }
      body.u(m.has(code) ? 1 : 0);
    }
  });

  // Containers.
  const filterKey = f => str(JSON.stringify(f));
  let lastNum = 0,
    lastEnd = 0;
  const container = e => {
    body.u(e.c.length);
    for (const [num, gen, start, length, filters] of e.c) {
      body.s(num - lastNum);
      lastNum = num;
      body.u(gen);
      body.s(start - lastEnd);
      body.u(length);
      lastEnd = start + length;
      body.u(filterKey(filters));
    }
    for (const map of [e.f, e.x]) {
      const keys = Object.keys(map);
      body.u(keys.length);
      let p = 0;
      for (const k of keys) {
        body.u(str(k));
        body.s(map[k] - p);
        p = map[k];
      }
    }
  };
  for (const list of [data.pages, data.forms]) {
    body.u(list.length);
    for (let i = 0; i < list.length; i++) {
      if (list[i]) {
        body.u(1);
        container(list[i]);
      } else {
        body.u(0);
      }
    }
  }
  const fontRefs = Object.entries(data.fontRefs || {});
  body.u(fontRefs.length);
  for (const [k, v] of fontRefs) {
    refKey(body, k);
    body.u(v);
  }
  const formRefs = data.formRefs || [];
  body.u(formRefs.length);
  for (const k of formRefs) {
    body.u(k ? 1 : 0);
    if (k) {
      refKey(body, k);
    }
  }

  const out = new Writer();
  out.u(MAGIC);
  out.u(data.v);
  out.u(strings.size);
  const enc = new TextEncoder();
  for (const s of strings.keys()) {
    out.bytes(enc.encode(s));
  }
  const b = body.result();
  out._ensure(b.length);
  out.buf.set(b, out.pos);
  out.pos += b.length;
  return out.result();
}

function decodeSidecar(buf) {
  const r = new Reader(buf);
  if (r.u() !== MAGIC) {
    return null;
  }
  const v = r.u();
  const dec = new TextDecoder();
  const strings = [];
  for (let n = r.u(); n > 0; n--) {
    strings.push(dec.decode(r.bytes()));
  }
  const data = { v, numPages: r.u(), pages: [], forms: [], fonts: [] };

  // Fonts, rebuilt as entry maps (code -> [u, a, vm, visual]).
  const maps = [];
  for (let fi = 0, n = r.u(); fi < n; fi++) {
    const flags = r.u();
    if (!flags) {
      data.fonts.push(null);
      maps.push(null);
      continue;
    }
    const composite = !!(flags & 2);
    const hasVm = !!(flags & 16);
    const d = r.s(),
      sp = r.s(),
      dv = hasVm ? r.s() : 0;
    let ranges = null,
      t3 = null;
    if (composite) {
      ranges = [];
      for (let k = r.u(); k > 0; k--) {
        const range = [];
        for (let j = r.u(); j > 0; j--) {
          range.push(r.u());
        }
        ranges.push(range);
      }
    }
    if (flags & 32) {
      const fm = [];
      for (let j = 0; j < 6; j++) {
        fm.push(r.f64());
      }
      let bbox = null;
      if (r.u()) {
        bbox = [];
        for (let j = 0; j < 4; j++) {
          bbox.push(r.f64());
        }
      }
      t3 = { fm, bbox, cb: !!r.u() };
    }
    const base = fi - r.u();
    const map = new Map(base >= 0 ? maps[base] : []);
    let code = 0;
    for (let k = r.u(); k > 0; k--) {
      code += r.u();
      map.delete(code);
    }
    code = 0;
    for (let k = r.u(); k > 0; k--) {
      code += r.u();
      const e = [strings[r.u()], r.s(), 0, 0];
      if (hasVm) {
        e[2] = r.s();
      }
      e[3] = r.u();
      map.set(code, e);
    }
    maps.push(map);
    const codes = [...map.keys()].sort((x, y) => x - y);
    const k = composite ? Uint32Array.from(codes) : Uint8Array.from(codes);
    const u = [],
      a = new Int16Array(codes.length),
      vm = hasVm ? new Int16Array(codes.length) : null,
      vis = [];
    codes.forEach((c, i) => {
      const e = map.get(c);
      u.push(e[0]);
      a[i] = e[1];
      if (vm) {
        vm[i] = e[2];
      }
      if (e[3]) {
        vis.push(c);
      }
    });
    let t;
    if (!composite) {
      t = { t: 0, k, u: u.join(SEP), a, d, sp };
    } else {
      t = {
        t: 1,
        r: ranges,
        i: !!(flags & 4),
        k,
        u: u.join(SEP),
        a,
        d,
        sp,
        v: flags & 8 ? 1 : 0,
      };
      if (vm) {
        t.vm = vm;
        t.dv = dv;
      }
    }
    if (flags & 64) {
      t.m = Uint32Array.from(vis);
    }
    if (t3) {
      t.t3 = t3;
    }
    data.fonts.push(t);
  }

  let lastNum = 0,
    lastEnd = 0;
  const container = () => {
    const c = [];
    for (let n = r.u(); n > 0; n--) {
      const num = (lastNum += r.s());
      const gen = r.u();
      const start = lastEnd + r.s();
      const length = r.u();
      lastEnd = start + length;
      c.push([num, gen, start, length, JSON.parse(strings[r.u()])]);
    }
    const maps2 = [];
    for (let j = 0; j < 2; j++) {
      const map = {};
      let p = 0;
      for (let n = r.u(); n > 0; n--) {
        const key = strings[r.u()];
        map[key] = p += r.s();
      }
      maps2.push(map);
    }
    return { c, f: maps2[0], x: maps2[1] };
  };
  for (const list of [data.pages, data.forms]) {
    const n = r.u();
    list.length = n;
    for (let i = 0; i < n; i++) {
      if (r.u()) {
        list[i] = container();
      }
    }
  }
  const nf = r.u();
  if (nf) {
    data.fontRefs = {};
    for (let n = nf; n > 0; n--) {
      const key = readRef(r);
      data.fontRefs[key] = r.u();
    }
  }
  const nx = r.u();
  if (nx) {
    data.formRefs = [];
    for (let i = 0; i < nx; i++) {
      if (r.u()) {
        data.formRefs[i] = readRef(r);
      }
    }
  }
  return data;
}

export { decodeSidecar, encodeSidecar };
