# Random access and the search index - findings

This fork opens hosted PDFs by random access: a `PDFDataRangeTransport`
(Range requests, size from the `Content-Range` of a probe) with
`disableAutoFetch` and `disableStream`. Only the parts PDF.js asks for are
read; the file is never read whole.

## No external page map is needed

We tried a stored per-page byte map (every object a page needs, from a
"sidecar" built per file) to prefetch a page's bytes. Measured, then removed:

- With ranges, PDF.js's own xref already reads exactly what a page needs.
  In CI (run 45822651876, same job per book, 7 alternating rounds, medians),
  random access without the map was as fast as with it and read less:

  | book        | full read: cold / jump / fling | ranges, no map | ranges + map  | bytes per session (full / no map / map) |
  | ----------- | ------------------------------ | -------------- | ------------- | --------------------------------------- |
  | small, 8 MB | 281 / 45 / 39 ms               | 260 / 48 / 23  | 272 / 45 / 24 | 8.3 / 2.6 / 3.8 MB                      |
  | mid, 23 MB  | 359 / 45 / 27 ms               | 327 / 53 / 29  | 317 / 50 / 29 | 23 / 2.6 / 3.8 MB                       |
  | big, 173 MB | 744 / 44 / 25 ms               | 380 / 55 / 29  | 389 / 51 / 29 | 173 / 2.8 / 3.9 MB                      |

- Building the map reads most of the file, because each object's dictionary
  must be read and they are spread between the images: on real books
  (random access, 64 KB parts) 8.1 of 8.5 MB (Moed Katan, about 95%) and
  16.4 of 22 MB (Berakhot, about 75%), even when only dictionaries are parsed.
- Opening real books by ranges read 0.4-1.6 MB (20-22 MB books) and 0.6 MB
  of a 172 MB scan; a session with jumps and a fling 1.8 MB of the scan.

## The search index learns from searches

`web/pdf_term_index.js` (inverted index: term dictionary + page postings, no
running text) is a page pre-filter for PDFFindController; results stay
exactly PDF.js's (bench parity on every page and option set). It is not
built by reading pages ahead (that reads the text of every page, so most of
the file: 8.2 of 8.5 MB, 18 of 22 MB). PDFFindController hands it every page
a search extracts anyway, in idle time off the search's path; it is stored
per file (`web/pdf_search_index_store.js`, IndexedDB, the ViewHistory's last
20 files). Later searches read only candidate pages: a word not in the book,
0 pages and 0 bytes.

## The rig

`node make_pdf.mjs` makes scan-like books; `server.mjs` serves them like the
app's WebView2 host (206 for Range, chunked GET without a length);
`ab.mjs`/`drive.mjs` alternate variants in headless Chrome (open, jump to the
middle, fling, jump to the end, reopen) and check the bytes read;
`search.mjs` compares the first search with the index learning on and off
(time to first/all results, bytes, JS heap peak of page and worker).
`.github/workflows/perf_rig.yml` runs it all in one job per book size.
