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

import { buildGetDocumentParams } from "./test_utils.js";
import { EventBus } from "../../web/event_utils.js";
import { getDocument } from "../../src/display/api.js";
import { isNodeJS } from "../../src/shared/util.js";
import { PDFViewer } from "../../web/pdf_viewer.js";

describe("PDFViewer text layer release", function () {
  beforeEach(function () {
    if (isNodeJS) {
      pending("Document is not supported in Node.js.");
    }
  });

  it("cancels the built text layers of the old document on setDocument", async function () {
    const container = document.createElement("div");
    container.style.cssText =
      "position:absolute;top:0;left:0;width:600px;height:600px;overflow:auto";
    const viewerDiv = document.createElement("div");
    viewerDiv.className = "pdfViewer";
    container.append(viewerDiv);
    document.body.append(container);

    const eventBus = new EventBus();
    const abortController = new AbortController();
    // No locale files in the unit-test server: a do-nothing l10n.
    const l10n = {
      getLanguage: () => "en-us",
      getDirection: () => "ltr",
      get: async () => "",
      translate: async () => {},
      translateOnce: async () => {},
      pause() {},
      resume() {},
      destroy: async () => {},
    };
    const viewer = new PDFViewer({
      container,
      eventBus,
      l10n,
      abortSignal: abortController.signal,
    });
    const loadingTask = getDocument(buildGetDocumentParams("tracemonkey.pdf"));
    try {
      const pdfDocument = await loadingTask.promise;
      const pagesInit = new Promise(resolve => {
        eventBus.on("pagesinit", resolve, { once: true });
      });
      viewer.setDocument(pdfDocument);
      await pagesInit;

      // A built text layer, as `_cancelRendering` keeps it (its div appended).
      const pageView = viewer.getPageView(0);
      let cancelled = 0;
      const textLayerDiv = document.createElement("div");
      pageView.div.append(textLayerDiv);
      pageView.textLayer = {
        div: textLayerDiv,
        cancel() {
          cancelled++;
        },
      };

      viewer.setDocument(null);

      // Cancelled and dropped: nothing of the old page stays registered.
      expect(cancelled).toEqual(1);
      expect(pageView.textLayer).toBeNull();
    } finally {
      abortController.abort();
      container.remove();
      await loadingTask.destroy();
    }
  });
});
