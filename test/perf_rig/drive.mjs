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

// One rig run in headless Chrome: open (cold), jump to the middle, fling, jump to the end, reopen
// (warm). Prints the timings as JSON. Usage: PORT= node drive.mjs '<opts json>'
import puppeteer from "puppeteer";

const opts = JSON.parse(process.argv[2]);
const wait = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.CHROME || undefined,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1.5 });
  page.on("pageerror", e => console.error("ERR", e.message));
  await page.goto(`http://127.0.0.1:${process.env.PORT || 5291}/`);
  await page.waitForFunction(() => window.ready);
  const rec = {};
  rec.cold = await page.evaluate(o => openView(o), opts);
  await wait(1500);
  const n = rec.cold.pages;
  rec.jumpMid = await page.evaluate(k => jump(k), Math.floor(n / 2));
  await wait(1200);
  rec.fling = await page.evaluate(() => fling(6, 150));
  await wait(1200);
  rec.jumpEnd = await page.evaluate(k => jump(k), n - 3);
  await wait(800);
  // PDF bytes read in this session (cold open, jumps and fling), before the warm reopen.
  rec.bytesTotal = await page.evaluate(() => totalBytes());
  rec.rendered = await page.evaluate(() => [...window.__rendered]);
  rec.warm = await page.evaluate(o => openView(o), opts);
  console.log(JSON.stringify(rec));
} finally {
  await browser.close();
}
