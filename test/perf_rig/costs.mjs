// Sidecar build + first search costs (h.mjs buildCosts) for one book. Usage: PORT= node costs.mjs <book> [query]
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME || undefined, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", e => console.error("ERR", e.message));
  await page.goto(`http://127.0.0.1:${process.env.PORT || 5291}/`);
  await page.waitForFunction(() => window.ready);
  const r = await page.evaluate(o => buildCosts(o), { book: process.argv[2], query: process.argv[3], query2: process.argv[4], chunk: +(process.env.CHUNK || 65536) });
  console.log(`COSTS ${process.argv[2]} ${JSON.stringify(r)}`);
} finally {
  await browser.close();
}
