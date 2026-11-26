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
import { PDFPageView } from "../../web/pdf_page_view.js";
import { RenderingStates } from "../../web/renderable_view.js";
import { TextLayerMode } from "../../web/ui_utils.js";

describe("PDFPageView layers after the canvas", function () {
  beforeEach(function () {
    if (isNodeJS) {
      pending("Document is not supported in Node.js.");
    }
  });

  it("settles draw() once the canvas is drawn, before the annotation layer", async function () {
    const container = document.createElement("div");
    document.body.append(container);
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
    const loadingTask = getDocument(buildGetDocumentParams("tracemonkey.pdf"));
    try {
      const pdfDocument = await loadingTask.promise;
      const pdfPage = await pdfDocument.getPage(1);
      const pageView = new PDFPageView({
        container,
        id: 1,
        scale: 1,
        defaultViewport: pdfPage.getViewport({ scale: 1 }),
        eventBus: new EventBus(),
        l10n,
        textLayerMode: TextLayerMode.DISABLE,
        enableAutoLinking: false,
        layerProperties: {},
      });
      pageView.setPdfPage(pdfPage);

      // An annotation layer that never finishes building.
      let annotationRenders = 0;
      pageView.annotationLayer = {
        div: null,
        render: () => {
          annotationRenders++;
          return new Promise(() => {});
        },
        cancel() {},
      };
      // The canvas "renders" at once (pages don't render in this server).
      pageView._drawCanvas = () => {
        pageView.renderingState = RenderingStates.FINISHED;
        return Promise.resolve();
      };

      const result = await Promise.race([
        pageView.draw().then(() => "drawn"),
        new Promise(resolve => {
          setTimeout(() => resolve("blocked"), 2000);
        }),
      ]);
      // The next page may start: the annotation layer did not hold it up...
      expect(result).toEqual("drawn");
      // ...and the annotation layer is still built, after the canvas.
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
      expect(annotationRenders).toEqual(1);

      pageView.reset();
    } finally {
      container.remove();
      await loadingTask.destroy();
    }
  });
});
