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
 * An outline edited by the user, as passed to `saveDocument` and
 * `extractPages` (the `outline` option):
 *
 *   Array<{ title: string, page: number, src?: number, items?: Array }>
 *
 * - `page` is the 1-based page number a new entry points at (top of page).
 * - `src`, when present, is the index of the entry's original item in the
 *   document outline flattened breadth-first (see `flattenOutline`). Such an
 *   entry keeps everything the editor doesn't model from that item: its
 *   destination or action, bold/italic, colour and closed state; only its
 *   title and children change.
 * - An empty array removes the outline.
 */

import { Dict, Name, Ref } from "./primitives.js";
import { MathClamp } from "../shared/math_clamp.js";
import { stringToAsciiOrUTF16BE } from "./string_utils.js";

/**
 * Flatten an outline (as returned by `Catalog.documentOutline` and
 * `Catalog.documentOutlineForEditor`) breadth-first: the top-level items,
 * then all their children level by level. This is the order `src` refers to.
 */
function flattenOutline(outline) {
  const flat = [];
  const queue = outline ? [outline] : [];
  while (queue.length > 0) {
    for (const item of queue.shift()) {
      flat.push(item);
      if (item.items?.length) {
        queue.push(item.items);
      }
    }
  }
  return flat;
}

/**
 * Write an edited outline into an incremental update of the same document.
 * New outline item dictionaries are put into `changes`, along with a copy of
 * the catalog whose /Outlines points at them (or has no /Outlines when the
 * edited outline is empty). The catalog keeps its reference, so the trailer's
 * /Root stays valid.
 * @returns {Promise<Set<number>>} The object numbers of the replaced
 *   outline's root and items, which are no longer used.
 */
async function writeEditedOutline({
  pdfManager,
  xref,
  catalogRef,
  changes,
  numPages,
  outline,
}) {
  const originalItems = flattenOutline(
    await pdfManager.ensureCatalog("documentOutlineForEditor")
  );

  const pageRefs = new Map();
  const getPageRef = async pageNumber => {
    const pageIndex = MathClamp((pageNumber | 0) - 1, 0, numPages - 1);
    let pageRef = pageRefs.get(pageIndex);
    if (pageRef === undefined) {
      const page = await pdfManager.getPage(pageIndex);
      pageRef = page.ref ?? null;
      pageRefs.set(pageIndex, pageRef);
    }
    return pageRef;
  };

  // Returns the number of visible items, as in the /Count of the parent.
  const fillItems = async (entries, parentRef) => {
    let count = 0;
    const refs = entries.map(() => xref.getNewTemporaryRef());
    for (let i = 0, ii = entries.length; i < ii; i++) {
      const entry = entries[i];
      const original = Number.isInteger(entry.src)
        ? originalItems[entry.src]
        : undefined;
      const rawDict = original?.rawDict;

      const dict = new Dict(xref);
      dict.set("Title", stringToAsciiOrUTF16BE(String(entry.title || "")));
      dict.set("Parent", parentRef);
      if (i > 0) {
        dict.set("Prev", refs[i - 1]);
      }
      if (i < ii - 1) {
        dict.set("Next", refs[i + 1]);
      }

      // Same document, so the raw values (indirect references included) can
      // be copied as they are.
      let hasTarget = false;
      if (rawDict) {
        const dest = rawDict.getRaw("Dest");
        const action = rawDict.getRaw("A");
        if (dest !== undefined) {
          dict.set("Dest", dest);
          hasTarget = true;
        } else if (action !== undefined) {
          dict.set("A", action);
          hasTarget = true;
        }
        for (const key of ["F", "C"]) {
          const value = rawDict.getRaw(key);
          if (value !== undefined) {
            dict.set(key, value);
          }
        }
      }
      if (!hasTarget) {
        // Without a valid page reference the entry only has a title, rather
        // than a `Dest [null ...]` that other readers reject.
        const pageRef = await getPageRef(entry.page);
        if (pageRef) {
          dict.set("Dest", [pageRef, Name.get("XYZ"), null, null, null]);
        }
      }

      if (Array.isArray(entry.items) && entry.items.length > 0) {
        const children = await fillItems(entry.items, refs[i]);
        dict.set("First", children.first);
        dict.set("Last", children.last);
        // Keep the original closed state (negative /Count); new entries are
        // open. A closed item counts as one visible item for its parent.
        const closed = Number.isInteger(original?.count) && original.count < 0;
        dict.set("Count", closed ? -children.count : children.count);
        count += closed ? 1 : children.count + 1;
      } else {
        count += 1;
      }
      changes.put(refs[i], { data: dict });
    }
    return { first: refs[0], last: refs.at(-1), count };
  };

  // The catalog may already have a pending copy in `changes` (e.g. one with a
  // new /StructTreeRoot, when saving annotations created a structure tree);
  // start from it so that it isn't lost.
  const originalCatalog = await xref.fetchAsync(catalogRef);
  const pendingCatalog = changes.get(catalogRef)?.data;
  const catalog =
    pendingCatalog instanceof Dict ? pendingCatalog : originalCatalog;

  const replacedNums = new Set();
  const stack = [
    originalCatalog instanceof Dict ? originalCatalog.getRaw("Outlines") : null,
  ];
  while (stack.length > 0) {
    const ref = stack.pop();
    if (
      !(ref instanceof Ref) ||
      replacedNums.has(ref.num) ||
      ref === catalogRef
    ) {
      continue;
    }
    replacedNums.add(ref.num);
    const dict = await xref.fetchAsync(ref);
    if (dict instanceof Dict) {
      stack.push(dict.getRaw("First"), dict.getRaw("Next"));
    }
  }

  const newCatalog = new Dict(xref);
  for (const [key, value] of catalog.getRawEntries()) {
    if (key !== "Outlines") {
      newCatalog.set(key, value);
    }
  }
  if (outline.length > 0) {
    const rootRef = xref.getNewTemporaryRef();
    const root = new Dict(xref);
    root.set("Type", Name.get("Outlines"));
    const { first, last, count } = await fillItems(outline, rootRef);
    root.set("First", first);
    root.set("Last", last);
    root.set("Count", count);
    changes.put(rootRef, { data: root });
    newCatalog.set("Outlines", rootRef);
  }
  changes.put(catalogRef, { data: newCatalog });

  return replacedNums;
}

/**
 * Turn an edited outline into outline items of `document`, in the shape of
 * `Catalog.documentOutlineForEditor`, for `PDFEditor`.
 * @param {PDFDocument} document
 * @param {Array|null} documentOutline - The document's loaded outline.
 * @param {Array<object>} outline - The edited outline.
 */
async function editedOutlineToItems(document, documentOutline, outline) {
  const originalItems = flattenOutline(documentOutline);
  const convert = async entries => {
    const items = [];
    for (const entry of entries) {
      const children = Array.isArray(entry.items)
        ? await convert(entry.items)
        : [];
      const original = Number.isInteger(entry.src)
        ? originalItems[entry.src]
        : undefined;
      let count;
      if (children.length > 0) {
        count = original?.count < 0 ? -1 : 1;
      }
      const title = String(entry.title || "");
      if (original) {
        items.push({ ...original, title, count, items: children });
        continue;
      }
      let dest = null;
      try {
        const page = await document.getPage((entry.page | 0) - 1);
        if (page.ref) {
          dest = [page.ref, Name.get("XYZ"), null, null, null];
        }
      } catch {}
      items.push({
        action: null,
        dest,
        url: null,
        title,
        count,
        bold: false,
        italic: false,
        items: children,
        rawDict: null,
      });
    }
    return items;
  };
  const items = await convert(outline);
  return items.length > 0 ? items : null;
}

export { editedOutlineToItems, flattenOutline, writeEditedOutline };
