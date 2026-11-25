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
 * Support for saving by merging into the file's last incremental update
 * section, instead of appending a new one each time (see the
 * `mergeIntoLastUpdate` option of `saveDocument`). Repeated saves then keep
 * the file's size stable, while the bytes before that section stay
 * byte-identical.
 */

import { isName, Ref } from "./primitives.js";
import { BaseStream } from "./base_stream.js";
import { info } from "../shared/util.js";
import { writeObject } from "./writer.js";

const WHITESPACE = "[\\0\\t\\n\\f\\r ]";

function latin1(bytes, begin, end) {
  let str = "";
  for (let i = begin; i < end; i += 8192) {
    str += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(end, i + 8192))
    );
  }
  return str;
}

/**
 * Find the file's last update section from the standard structure only: the
 * final startxref's xref table or stream (plus an /XRefStm inside the
 * section), its /Prev, and the previous revision's "startxref <Prev> %%EOF"
 * right before it.
 * @returns {object|null} `{start, prev, entries, xrefStm, signed}`, or null
 *   when there is no previous revision or the structure isn't provably
 *   standard (linearized, broken, ...): the save must then append.
 *   - `start`: offset of the section's first byte.
 *   - `prev`: the section's /Prev, to chain the replacing section to.
 *   - `entries`: the section's xref entries, by object number.
 *   - `xrefStm`: in a hybrid file, an /XRefStm in the bytes BEFORE the
 *     section, which the new trailer must keep pointing at; else undefined.
 *   - `signed`: the section holds a signature (/ByteRange); it must never be
 *     rewritten.
 */
function findLastUpdateSection(bytes, xref, startXRef) {
  if (
    !Number.isInteger(startXRef) ||
    startXRef <= 0 ||
    startXRef >= bytes.length
  ) {
    return null;
  }
  let top;
  try {
    top = xref.readXRefSection(bytes, startXRef);
  } catch (ex) {
    info(`findLastUpdateSection: "${ex}".`);
    return null;
  }
  const prev = top.dict.get("Prev");
  if (!Number.isInteger(prev) || prev < 0 || prev >= startXRef) {
    return null;
  }

  // The previous revision ends with "startxref <prev> %%EOF".
  let eof = -1;
  for (let i = startXRef - 5; i >= 0; i--) {
    if (
      bytes[i] === /* % */ 0x25 &&
      bytes[i + 1] === /* % */ 0x25 &&
      bytes[i + 2] === /* E */ 0x45 &&
      bytes[i + 3] === /* O */ 0x4f &&
      bytes[i + 4] === /* F */ 0x46
    ) {
      eof = i;
      break;
    }
  }
  if (eof < 0) {
    return null;
  }
  const startXRefRegExp = new RegExp(
    `startxref${WHITESPACE}+(\\d+)${WHITESPACE}*$`
  );
  const match = startXRefRegExp.exec(latin1(bytes, Math.max(0, eof - 64), eof));
  if (!match || Number(match[1]) !== prev) {
    return null;
  }
  let start = eof + 5;
  if (bytes[start] === /* \r */ 0x0d) {
    start++;
  }
  if (bytes[start] === /* \n */ 0x0a) {
    start++;
  }

  // Hybrid file: an /XRefStm inside the section is part of it (its objects
  // are carried over); one in the bytes before it (Word writes an empty last
  // table whose /XRefStm points back) stays where it is, and the new trailer
  // keeps pointing at it.
  const entries = top.entries;
  let xrefStm = top.dict.get("XRefStm");
  if (Number.isInteger(xrefStm) && xrefStm >= 0 && xrefStm < bytes.length) {
    if (xrefStm >= start) {
      try {
        const stmEntries = xref.readXRefSection(bytes, xrefStm).entries;
        // As when loading: the table's entries win over the stream's.
        stmEntries.forEach((entry, num) => {
          entries[num] ??= entry;
        });
      } catch (ex) {
        info(`findLastUpdateSection: "${ex}".`);
        return null;
      }
      xrefStm = undefined;
    }
  } else {
    xrefStm = undefined;
  }

  const signed = new RegExp(`/ByteRange${WHITESPACE}*\\[`).test(
    latin1(bytes, start, bytes.length)
  );
  return { start, prev, entries, xrefStm, signed };
}

/**
 * Every object the last section defines, as `changes` entries, except the
 * ones already in `changes` (the save's own, newer, version wins) and the
 * object numbers in `skipNums`. Object streams and xref streams are
 * containers, not content: their objects are written out one by one.
 * Strings and streams come decrypted from `fetch`, and the writer encrypts
 * them again for their own numbers; the /Encrypt dictionary itself is never
 * encrypted. A free entry stays free.
 * @returns {Promise<Array<[Ref, object]>>}
 */
async function getLastUpdateSectionChanges(
  section,
  changes,
  xref,
  encryptRef,
  skipNums = null
) {
  const changedNums = new Set();
  for (const ref of changes.keys()) {
    changedNums.add(ref.num);
  }
  const result = [];
  const { entries } = section;
  for (let num = 1, ii = entries.length; num < ii; num++) {
    const entry = entries[num];
    if (!entry || changedNums.has(num) || skipNums?.has(num)) {
      continue;
    }
    if (entry.free) {
      result.push([Ref.get(num, Math.max(0, entry.gen - 1)), { data: null }]);
      continue;
    }
    const ref = Ref.get(num, entry.uncompressed ? entry.gen : 0);
    const isEncryptDict = ref === encryptRef;
    const obj = await xref.fetchAsync(ref, isEncryptDict);
    if (obj === null || obj === undefined) {
      continue;
    }
    if (
      obj instanceof BaseStream &&
      (isName(obj.dict.get("Type"), "ObjStm") ||
        isName(obj.dict.get("Type"), "XRef"))
    ) {
      continue;
    }
    if (isEncryptDict) {
      const buffer = [];
      await writeObject(ref, obj, buffer, {});
      result.push([ref, { data: buffer.join("") }]);
      continue;
    }
    result.push([ref, { data: obj }]);
  }
  return result;
}

export { findLastUpdateSection, getLastUpdateSectionChanges };
