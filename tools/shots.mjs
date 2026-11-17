#!/usr/bin/env node
/**
 * Capture screenshots of the built artifact at desktop and phone sizes, for
 * human review. Not a test -- it makes pixels to LOOK at. The assertions live in
 * tests/browser.test.mjs.
 */
const entry = process.env.PLAYWRIGHT_ENTRY;
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
if (entry === undefined || browsersPath === undefined) {
  console.error("PLAYWRIGHT_ENTRY and PLAYWRIGHT_BROWSERS_PATH must be set; run inside the pinned shell.");
  process.exit(2);
}
const { firefox } = await import(entry);
const { resolve } = await import("node:path");
const artifact = resolve(import.meta.dirname, "..", "index.html");
const outDir = process.argv[2] || "/tmp/agent/lodex/keel-shots";
const { mkdirSync } = await import("node:fs");
mkdirSync(outDir, { recursive: true });

const browser = await firefox.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });

await page.goto("file://" + artifact);
await page.waitForTimeout(600);
await page.screenshot({ path: `${outDir}/desktop-initial.png`, fullPage: true });

// Push over and release, then shoot mid-roll so the mechanism is visible.
await page.click("#pushBtn");
await page.waitForTimeout(500);
await page.screenshot({ path: `${outDir}/desktop-heel.png`, fullPage: true });

// Tender configuration: raise the weight near the limit.
await page.evaluate(() => {
  const s = document.getElementById("kg");
  s.value = 95;
  s.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(200);
await page.screenshot({ path: `${outDir}/desktop-tender.png`, fullPage: true });

// Phone portrait.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/phone-portrait.png`, fullPage: true });

// Phone landscape.
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/phone-landscape.png`, fullPage: true });

await browser.close();
console.log("shots ->", outDir);
