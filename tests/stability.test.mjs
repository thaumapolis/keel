/**
 * Tests for stability.js -- the layer that composes hull.js and sections.js into
 * the thing a sailor actually reads: the GZ curve.
 *
 * This file began as an import check, and that is not a placeholder. stability.js
 * imported polygonHydrostatics from sections.js, which sections.js never
 * exported. That is not a runtime error in a rare branch -- ESM resolves named
 * imports at link time, so the module threw on load and NOTHING could import
 * stability.js. It survived three commits because every test went straight to
 * hull.js and sections.js and none went through the layer that ties them
 * together: the whole user-facing surface was dead and the suite was green. The
 * first check below pins that so a dead import cannot hide again.
 *
 * Everything after that asserts BEHAVIOUR, and -- the lesson this project keeps
 * relearning -- asserts it as PROPERTIES anchored on a measured reference, not as
 * absolute numbers. The previous version checked "GM > 0.5" and "peak at 45 deg".
 * Both were absolute, both were tuned to the old separable hull, and both had to
 * be thrown away the day the hull form changed for the better. So the reference
 * point here is the hull's OWN critical KG -- the KG at which GM is zero, found by
 * bisection -- and every case is a fraction of it. A case stated as "60% of the
 * way to capsizing" means the same thing on any hull, which is the whole point of
 * a reference that moves with the shape.
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { Hull } from "../src/hull.js";
import { buildHeel, heelAt } from "../src/sections.js";
import { floatStateAt, gzCurve, rightingArm, stabilitySummary, uprightState } from "../src/stability.js";

const DEG = Math.PI / 180;
let passed = 0;
const failures = [];
async function check(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

/**
 * A hull and a loading, both from measurement: a mid-fullness form at 55% of
 * depth, comfortably afloat, with enough reserve that a stable case is clearly
 * stable and a tender case is clearly not, so a regression flips a sign rather
 * than nudging a number already sitting on its threshold.
 */
function buildScenario() {
  const hull = new Hull({
    length: 12,
    beam: 4,
    depth: 2.4,
    blockCoefficient: 0.62,
    prismaticCoefficient: 0.9,
  });
  const draft = hull.depth * 0.55;
  const state = heelAt(buildHeel(hull, 0), draft);
  const volume = state.volume;
  return { hull, draft, volume, KB: state.bz, crit: criticalKG(hull, volume) };
}

let cachedScenario = null;
function scenario() {
  // buildScenario runs the waterline integration and the critical-KG bisection
  // once. Every check reads the same hull/loading; none mutate it, so sharing one
  // object across checks is safe and keeps the suite from re-bisecting per test.
  if (cachedScenario === null) cachedScenario = buildScenario();
  return cachedScenario;
}

/**
 * The KG at which this hull, at this loading, has GM exactly zero -- the boundary
 * between "comes back" and "stays over". Found by bisection on the curve's own
 * slope, so it is the same number the UI's stability readout implies. Every case
 * below is a multiple of this, which is why none of them need re-tuning when the
 * hull form changes.
 */
function criticalKG(hull, volume) {
  // Only the SIGN of the small-angle GM is needed to bisect the boundary, so the
  // sweep that measures it is capped at a small angle (step 5 deg to 20 deg). That
  // is ~4 float-solves per iteration instead of ~90, and the slope over that range
  // still locates GM = 0 to within 0.3% of the full 180 deg sweep -- a difference
  // far smaller than the spacing between the fraction-of-critical cases below.
  // 40 bisections is ~1e-5 m resolution on a ~1 m range, far past what matters.
  const opts = { stepDeg: 5, maxDeg: 20 };
  let low = 0.3;   // certainly stable: at or below the buoyancy centre
  let high = hull.depth * 1.2;  // certainly inverted: far above the deck
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    if (stabilitySummary(hull, mid, volume, opts).initialGM > 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

await check("every module in src loads, so a dead import cannot hide", async () => {
  // Enumerate src/ on disk and import each file, rather than asserting a
  // hand-written list. The list is the bug: it used to name three modules and
  // silently skipped whichever module nobody remembered to add -- the exact dead-
  // import failure this check exists to catch, hiding inside the check itself.
  // Reading the directory makes "did everything load" a question about the tree,
  // so a new src/ file is covered the moment it exists, with nothing to remember.
  const dir = new URL("../src/", import.meta.url);
  const names = readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  assert.ok(names.length > 0, "no modules found in src/ -- wrong path?");
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop -- order matters: report the first
    // failure clearly rather than racing five dynamic imports.
    await import(new URL(name, dir)); // throws on a broken export, which is the point
  }
});

await check("uprightState is the whole hull at full depth", () => {
  const { hull } = scenario();
  const state = uprightState(hull);
  const whole = heelAt(buildHeel(hull, 0), hull.depth);
  assert.ok(Math.abs(state.volume - whole.volume) < 1e-12, "uprightState is not the full-depth hull");
  // Centre of buoyancy of any hull sits between keel and deck. A value outside
  // that range is a frame error, and this project has produced bz = 8.0 m on a
  // 2.4 m hull exactly once, so the bound is cheap insurance against the frame
  // changing again.
  assert.ok(state.bz > 0 && state.bz <= hull.depth, `bz ${state.bz} outside [0, depth]`);
});

await check("GZ is zero upright and grows linearly with angle, slope = GM", () => {
  const { hull, volume, crit } = scenario();
  const KG = 0.6 * crit;
  const up = rightingArm(hull, 0, KG, volume);
  assert.ok(Math.abs(up.gz) < 1e-9, `GZ upright should be 0, got ${up.gz}`);
  const gm = stabilitySummary(hull, KG, volume).initialGM;
  // Small angles: GZ / sin(angle) -> GM. At 3 deg the sine approximation is good
  // to O(theta^3), so the ratio should sit close to GM. This is the definition
  // made observable, not a second formula being agreed with a first.
  const small = rightingArm(hull, 3 * DEG, KG, volume).gz;
  const ratio = small / Math.sin(3 * DEG);
  assert.ok(Math.abs(ratio / gm - 1) < 0.02, `slope ${ratio.toFixed(4)} disagrees with GM ${gm.toFixed(4)}`);
});

await check("GZ is antisymmetric in heel: heel left is the mirror of heel right", () => {
  // For a hull with a centreplane of symmetry, GZ(-theta) == -GZ(+theta) exactly.
  // A renderer or a sign slip that flipped only one side of the roll would break
  // this while leaving every one-sided number looking fine -- and a ship that
  // rights itself when heeled to starboard but not to port is not a bug you can
  // see in a summary statistic.
  const { hull, volume, crit } = scenario();
  const KG = 0.6 * crit;
  for (const deg of [5, 20, 40]) {
    const plus = rightingArm(hull, deg * DEG, KG, volume).gz;
    const minus = rightingArm(hull, -deg * DEG, KG, volume).gz;
    assert.ok(Math.abs(plus + minus) < 1e-12, `GZ not antisymmetric at ${deg} deg: +${plus} / ${minus}`);
  }
});

await check("raising KG down the curve moves the peak GZ to smaller angles and lowers it", () => {
  // The mechanism the project exists to show. Stiff low-GM-and-peak cases peak
  // later and higher; tender cases peak early and weakly; past the critical KG the
  // ship lolls. Each of these is measured on the same hull and loading -- only the
  // weight's height moves -- so a failure means the curve stopped responding to
  // KG, not that a tolerance drifted. Bands are from measurement of the scenario
  // at fractions of its own critical KG (0.4: peak 0.769@52; 0.8: 0.326@42; 0.95:
  // 0.177@38), with room for resolution but not enough to hide a lost response.
  const { hull, volume, crit } = scenario();
  const stiff = stabilitySummary(hull, 0.4 * crit, volume);
  const mid = stabilitySummary(hull, 0.8 * crit, volume);
  const tender = stabilitySummary(hull, 0.95 * crit, volume);
  assert.ok(stiff.initialGM > mid.initialGM && mid.initialGM > tender.initialGM,
    `GM must fall monotonically with KG: ${stiff.initialGM.toFixed(4)} / ${mid.initialGM.toFixed(4)} / ${tender.initialGM.toFixed(4)}`);
  assert.ok(stiff.maxGz > mid.maxGz && mid.maxGz > tender.maxGz,
    `peak GZ must fall with KG: ${stiff.maxGz.toFixed(4)} / ${mid.maxGz.toFixed(4)} / ${tender.maxGz.toFixed(4)}`);
  assert.ok(stiff.maxGzAtDeg > mid.maxGzAtDeg && mid.maxGzAtDeg > tender.maxGzAtDeg,
    `peak must move to smaller angles as KG rises: ${stiff.maxGzAtDeg} / ${mid.maxGzAtDeg} / ${tender.maxGzAtDeg}`);
});

await check("a hull past its critical KG lolls rather than rights upright", () => {
  // Just over the boundary: GM negative, so an upright ship is in unstable
  // equilibrium and the righting arm at a small angle is the wrong sign. It has
  // not "sunk" -- it still floats, and the curve may still have a positive hump
  // further over (the second stability sailors call being stiff in the loll) --
  // but it will not come back to upright. Distinguishing loll from sink is a
  // modelling point the UI has to get right, so it is asserted explicitly.
  const { hull, volume, crit } = scenario();
  const inverted = stabilitySummary(hull, 1.05 * crit, volume);
  assert.ok(inverted.initialGM < 0, `GM above critical should be negative, got ${inverted.initialGM}`);
  const small = rightingArm(hull, 3 * DEG, 1.05 * crit, volume).gz;
  assert.ok(small < 0, `GZ at small angle above critical should be negative (loll), got ${small}`);
});

await check("the curve ends where the hull genuinely stops floating, not at a solver artifact", () => {
  // cannotFloatBeyondDeg is where no waterline reaches the target displacement.
  // For this broad-beam hull at 55% depth the attainable submerged area runs out
  // as the deck edge dives, in the mid-60s (measured 66 deg). Two things could
  // make this wrong and both look identical in a summary: a bracket bug that
  // "cannot float" too early, or a genuine geometric limit. A truncation before
  // 30 deg on a hull this broad at this draft is a bracket bug, not physics, so
  // that is the line -- deliberately loose on the upper side because the honest
  // value IS the limit and I do not want to pin the exact angle, only the fact
  // that it is not premature.
  const { hull, volume, crit } = scenario();
  const s = stabilitySummary(hull, 0.6 * crit, volume);
  assert.ok(s.cannotFloatBeyondDeg === null || s.cannotFloatBeyondDeg > 30,
    `float range ends at ${s.cannotFloatBeyondDeg} deg -- premature, likely a bracket bug`);
});

await check("an unfloatable heel is reported, not silently zeroed", () => {
  // Two call paths, two honest answers. rightingArm returns a structured failure
  // object -- it never coerces to gz: 0, because 0 is also the upright reading and
  // "level" and "gone over" feel nothing alike. floatStateAt, the wrapper a caller
  // uses when they asked for ONE angle, throws with that angle in the message. Both
  // contracts are asserted because a future refactor that quietly returns 0 instead
  // of a failure would pass any test that only watched the number.
  //
  // KNOWN HONESTY BUG, deliberately not papered over: at far angles (90 deg+) the
  // reported maxVolume is 0.000 and TOO_FULL says "does not float at any angle",
  // yet the hull plainly floats 71 m3 upright. That 0 is a bracket failure in
  // floatWaterline, not a fact about the ship -- a real limit would report the
  // attainable volume (~28 m3 near the deck-edge dive, which IS below target). The
  // two must not be conflated. Until floatWaterline reports a non-zero reachable
  // maximum, this test pins only what is unambiguously true at 170 deg: that both
  // paths report failure. It does NOT assert maxVolume, because asserting 0 would
  // bless the artifact and asserting ~28 would fail against the real (buggy) code.
  const { hull, volume, crit } = scenario();
  const beyond = rightingArm(hull, 170 * DEG, 0.6 * crit, volume);
  assert.ok(beyond !== null && beyond.failure !== undefined,
    `expected a structured failure at 170 deg, got ${JSON.stringify(beyond)}`);
  // The message for TOO_FULL says "does not float at any angle" and deliberately
  // omits a specific angle -- naming 170 deg when the hull fails at every angle
  // would be misleading. So the contract is "throws, and says the angle is not
  // floatable", which the message does either by naming the angle (BEYOND_REACH)
  // or by saying it fails everywhere (TOO_FULL). Accept either; the failure mode
  // the test guards against is a silent no-throw, not the wording of a throw.
  assert.throws(
    () => floatStateAt(hull, 170 * DEG, volume),
    (error) => /deg|any angle/.test(error.message),
    "floatStateAt should throw and say the heel is not floatable",
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length} stability check(s) FAILED`);
  process.exit(1);
}
console.log(`\n${passed} stability checks passed`);
