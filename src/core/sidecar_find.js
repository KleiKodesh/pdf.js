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
 * Match counting for the sidecar's direct search. Follows PDFFindController:
 * NFD text, the same punctuation replacements, "-\n" word joins, "\n" as a
 * space, diacritics ignored unless `matchDiacritics`, case-insensitive unless
 * `caseSensitive`, and the same whole-word rule (letters/digits/_ around).
 */

const CHARACTERS_TO_NORMALIZE = new Map([
  ["‐", "-"],
  ["‘", "'"],
  ["’", "'"],
  ["‚", "'"],
  ["‛", "'"],
  ["“", '"'],
  ["”", '"'],
  ["„", '"'],
  ["‟", '"'],
  ["¼", "1/4"],
  ["½", "1/2"],
  ["¾", "3/4"],
]);
const REPLACE_RE = new RegExp(
  `[${[...CHARACTERS_TO_NORMALIZE.keys()].join("")}]`,
  "g"
);
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function normalizeText(text, matchDiacritics) {
  let s = text
    .normalize("NFD")
    .replace(REPLACE_RE, c => CHARACTERS_TO_NORMALIZE.get(c));
  if (!matchDiacritics) {
    s = s.replace(/\p{M}+/gu, "");
  }
  return s
    .replace(/(\p{Ll})-\n(?=\p{Ll})|(\p{Lu})-\n(?=\p{L})/gu, "$1$2")
    .replace(/(\S-)\n/g, "$1")
    .replace(/\n/g, " ");
}

function buildMatcher(
  query,
  { caseSensitive = false, matchDiacritics = false }
) {
  const q = normalizeText(query, matchDiacritics).trim();
  if (!q) {
    return null;
  }
  const src = q
    .split(/\s+/)
    .map(w => RegExp.escape(w))
    .join("[ ]+");
  return new RegExp(src, caseSensitive ? "gu" : "giu");
}

function countMatches(text, re, entireWord) {
  re.lastIndex = 0;
  let count = 0,
    m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (entireWord) {
      const before = text[m.index - 1],
        after = text[m.index + m[0].length];
      if (
        (before && WORD_CHAR.test(before) && WORD_CHAR.test(m[0][0])) ||
        (after && WORD_CHAR.test(after) && WORD_CHAR.test(m[0].at(-1)))
      ) {
        continue;
      }
    }
    count++;
  }
  return count;
}

export { buildMatcher, countMatches, normalizeText };
