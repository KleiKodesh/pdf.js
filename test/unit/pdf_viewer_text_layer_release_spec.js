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
    const viewer = new PDFViewer({
      container,
      eventBus,
      abortSignal: abortController.signal,
    });
    const loadingTask = getDocument(buildGetDocumentParams("tracemonkey.pdf"));
    try {
      const pdfDocument = await loadingTask.promise;
      const rendered = new Promise(resolve => {
        eventBus.on("textlayerrendered", resolve, { once: true });
      });
      viewer.setDocument(pdfDocument);
      const { source: pageView, error } = await rendered;
      expect(error).toBeFalsy();

      const textLayer = pageView.textLayer;
      expect(textLayer).toBeTruthy();
      expect(textLayer.div.childElementCount).toBeGreaterThan(0);

      viewer.setDocument(null);

      // Cancelled: nothing of the old page stays registered or drawn.
      expect(pageView.textLayer).toBeNull();
      expect(textLayer.div.childElementCount).toEqual(0);
    } finally {
      abortController.abort();
      container.remove();
      await loadingTask.destroy();
    }
  });
});
