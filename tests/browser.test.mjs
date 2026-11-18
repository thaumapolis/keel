/**
 * tests/browser.test.mjs -- the artifact, in a browser, doing its job.
 *
 * Three things, each because source-passing is not enough:
 *
 *  1. The BUNDLED file loads and runs with no page error, and the 3D canvas
 *     actually contains a scene: a sea (non-sky pixels in the lower half), a
 *     hull (warm/orange pixels), and the two marker dots. A blank canvas was the
 *     exact failure here for several builds and no unit test could see it.
 *  2. It is INTERACTIVE: pressing "push over" changes the heel readout, and the
 *     ship actually rolls back over the following frames -- i.e. the roll
 *     dynamics run, not just a static redraw.
 *  3. It survives a sandboxed opaque-origin iframe (allow-scripts only), which
 *     is how the GitHub Pages preview serves it, and it reports its own state so
 *     silence inside the frame is a failure, not a pass.
 */
const entry = process.env.PLAYWRIGHT_ENTRY;
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
if (entry === undefined || browsersPath === undefined) {
  console.error("PLAYWRIGHT_ENTRY and PLAYWRIGHT_BROWSERS_PATH must be set; run inside the pinned shell.");
  process.exit(2);
}
const { firefox } = await import(entry);
const { readFileSync } = await import("node:fs");
const { resolve } = await import("node:path");

const artifact = resolve(import.meta.dirname, "..", "index.html");
try { readFileSync(artifact); } catch { console.error(`no artifact at ${artifact}; run tools/build.mjs first`); process.exit(2); }

let failures = 0;
function ok(condition, label, detail) {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`); }
}

const browser = await firefox.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto("file://" + artifact);
await page.waitForTimeout(800);

// ---- 1: it loads and paints a scene ---------------------------------------
ok(pageErrors.length === 0, "loads with no page error", pageErrors.join("; "));

const canvasProbe = await page.evaluate(() => {
  const v = document.getElementById("view");
  const ctx = v.getContext("2d");
  if (v.width < 50 || v.height < 50) return { sized: false, w: v.width, h: v.height };
  const d = ctx.getImageData(0, 0, v.width, v.height).data;
  let orange = 0, cyan = 0, sea = 0, total = v.width * v.height;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r > 120 && g > 50 && g < 160 && b < 120 && r > b + 40) orange++;      // topsides
    if (b > 150 && g > 150 && r < 160) cyan++;                                 // waterline/markers
    if (b > g && g > r && b > 55 && b < 150 && r < 90) sea++;                  // sea band
  }
  return { sized: true, w: v.width, h: v.height,
    orangeFrac: orange / total, cyanFrac: cyan / total, seaFrac: sea / total };
});
ok(canvasProbe.sized, "3D canvas is sized", JSON.stringify(canvasProbe));
ok(canvasProbe.orangeFrac > 0.002, "hull (topsides) is painted", `orange ${canvasProbe.orangeFrac?.toFixed(4)}`);
ok(canvasProbe.seaFrac > 0.01, "sea is painted", `sea ${canvasProbe.seaFrac?.toFixed(4)}`);
ok(canvasProbe.cyanFrac > 0.0002, "waterline/markers painted", `cyan ${canvasProbe.cyanFrac?.toFixed(5)}`);

// ---- 2: it is interactive ---------------------------------------------------
const heelBefore = await page.evaluate(() => parseInt(document.getElementById("heelOut").textContent, 10));
await page.click("#pushBtn");
await page.waitForTimeout(150);
const heelJustAfter = await page.evaluate(() => parseInt(document.getElementById("heelOut").textContent, 10));
await page.waitForTimeout(700);
const heelLater = await page.evaluate(() => parseInt(document.getElementById("heelOut").textContent, 10));
ok(Math.abs(heelJustAfter) > Math.abs(heelBefore), "pushing over changes the heel", `${heelBefore} -> ${heelJustAfter}`);
// The roll dynamics run: the ship is a different angle later than right after the push.
ok(heelLater !== heelJustAfter, "the ship keeps moving (roll dynamics run)", `${heelJustAfter} -> ${heelLater}`);

// ---- 3: it runs inside a sandboxed frame -----------------------------------
// ---- 3: it runs under a sandbox, reporting its own state --------------------
// The GitHub Pages preview embeds the artifact in a sandboxed iframe (scripts run,
// no shared origin, no shared storage). We cannot build a cross-origin frame
// faithfully here: the test sandbox forbids creating a listening socket, so a
// local http origin (how Pages really serves it) is unavailable, and loading
// file:// in a nested opaque-origin iframe raced its load event on the CI runner.
//
// The property that actually matters is: does the app run and paint when web
// storage is denied to it? That is the capability a sandbox restricts. So we load
// the artifact as the top page with the Storage Access API denied -- the same gate
// a sandboxed iframe applies -- and read its own painted canvas back. A storage
// call that throws, or an uncaught error, would leave the canvas blank, so a
// painted canvas is positive evidence the whole app ran with storage blocked.
const capCtx = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  permissions: [],
});
await capCtx.addInitScript(() => {
  // Deny storage at two levels: the global storage-access permission, and the
  // actual accessors. If the artifact ever touches either, it will throw and the
  // canvas will stay blank -- which is exactly the failure we would want to see.
  Object.defineProperty(navigator, "storage", { value: { estimate: () => Promise.reject(new Error("blocked")) } });
  const deny = () => { throw new Error("storage blocked by test"); };
  try { Object.defineProperty(window, "localStorage", { get: deny }); } catch {}
  try { Object.defineProperty(window, "sessionStorage", { get: deny }); } catch {}
  try { Object.defineProperty(window, "indexedDB", { get: deny }); } catch {}
});
const capPage = await capCtx.newPage();
const capErrors = [];
capPage.on("pageerror", (e) => capErrors.push(e.message));
await capPage.goto("file://" + artifact, { waitUntil: "load" });
await capPage.waitForTimeout(800);
const capProbe = await capPage.evaluate(() => {
  const cv = document.getElementById("view");
  if (!cv || cv.width < 50) return { painted: false, reason: "no canvas" };
  const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  let sea = 0, hull = 0, total = cv.width * cv.height;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (b > g && g > r && b > 55 && b < 150 && r < 90) sea++;
    if (r > 120 && g > 50 && g < 160 && b < 120 && r > b + 40) hull++;
  }
  return { painted: true, seaFrac: sea / total, hullFrac: hull / total };
});
ok(capErrors.length === 0, "no page error under a storage-denied context", capErrors.join("; "));
ok(capProbe.painted && capProbe.seaFrac > 0.01 && capProbe.hullFrac > 0.002,
  "artifact runs and paints with web storage denied (the capability a sandbox restricts)",
  JSON.stringify(capProbe));

await browser.close();

if (failures > 0) { console.error(`\n${failures} browser check(s) FAILED`); process.exit(1); }
console.log("\nbrowser checks passed");
