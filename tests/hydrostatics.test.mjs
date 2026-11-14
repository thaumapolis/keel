/**
 * Hydrostatics tests. Every expectation here is a number computed independently
 * of the code under test -- closed-form integrals of the hull form, or a
 * hand-worked box -- never a value read back out of hydrostatics().
 */
import assert from "node:assert/strict";
import { Hull } from "../src/hull.js";
import { sampleSections, hydrostatics } from "../src/hydrostatics.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok   ${name}`);
}

/**
 * Closed-form displacement of a hull form, computed from halfBreadth by
 * adaptive Simpson in both directions -- deliberately a different numerical
 * method from the station integration being tested, so a shared bug cannot make
 * both sides agree.
 */
function referenceDisplacement(hull, waterline, n = 4001) {
  const simpson = (f, a, b, steps) => {
    const h = (b - a) / steps;
    let s = f(a) + f(b);
    for (let i = 1; i < steps; i += 1) s += f(a + i * h) * (i % 2 ? 4 : 2);
    return (h / 3) * s;
  };
  const half = (u, z) => hull.halfBreadth(u, z);
  // u is a fraction of the length, so the integral over u carries an explicit
  // factor of the length; leaving it out is a factor-of-12 error that looks like
  // the hull is wrong rather than the test.
  const perUnitLength = simpson(
    (u) => simpson((z) => 2 * half(u, z), 0, waterline, n),
    0,
    1,
    n,
  );
  return perUnitLength * hull.length;
}

check("blockCoefficient is the displacement, not a label", () => {
  for (const Cb of [0.5, 0.62, 0.7]) {
    const hull = new Hull({
      length: 12,
      beam: 4,
      depth: 2.4,
      blockCoefficient: Cb,
      prismaticCoefficient: 0.9,
    });
    const actual = referenceDisplacement(hull, hull.depth) / (12 * 4 * 2.4);
    assert.ok(
      Math.abs(actual - Cb) < 0.001,
      `declared Cb ${Cb} but the form displaces ${actual.toFixed(5)}`,
    );
  }
});

check("station integration matches the closed form to 0.1%", () => {
  const hull = new Hull({
    length: 12,
    beam: 4,
    depth: 2.4,
    blockCoefficient: 0.62,
    prismaticCoefficient: 0.9,
  });
  const exact = referenceDisplacement(hull, hull.depth);
  const got = hydrostatics(sampleSections(hull), hull.depth).volume;
  assert.ok(
    Math.abs(got / exact - 1) < 0.001,
    `station integration ${got.toFixed(5)} vs closed form ${exact.toFixed(5)}`,
  );
});

check("beam is the actual maximum breadth", () => {
  const hull = new Hull({
    length: 12,
    beam: 4,
    depth: 2.4,
    blockCoefficient: 0.62,
    prismaticCoefficient: 0.8,
  });
  let maxHalf = 0;
  const steps = 400;
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      maxHalf = Math.max(maxHalf, hull.halfBreadth(i / steps, (j / steps) * hull.depth));
    }
  }
  assert.ok(
    Math.abs(maxHalf - 2) < 1e-3,
    `declared beam 4 m but maximum half-breadth is ${maxHalf.toFixed(4)}`,
  );
});

check("an unreachable block coefficient is refused, not silently mis-scaled", () => {
  // prismaticCoefficient 0.5 gives narrow sections, whose fullest possible form
  // (a wall-sided barge) still cannot reach Cb 0.8.
  assert.throws(
    () =>
      new Hull({
        length: 12,
        beam: 4,
        depth: 2.4,
        blockCoefficient: 0.8,
        prismaticCoefficient: 0.5,
      }).taperExponent,
    /unreachable/,
  );
});

check("beam dominates metacentric height at equal displacement", () => {
  // The physical claim the whole project rests on: two hulls carrying the same
  // weight right themselves very differently depending on how wide they are.
  const wide = new Hull({
    length: 12,
    beam: 6,
    depth: 2,
    blockCoefficient: 0.7,
    prismaticCoefficient: 0.9,
  });
  const narrow = new Hull({
    length: 12,
    beam: 3,
    depth: 4,
    blockCoefficient: 0.7,
    prismaticCoefficient: 0.9,
  });
  const displacement = hydrostatics(sampleSections(wide), wide.depth).volume;
  const draftFor = (hull) => {
    let lo = 0;
    let hi = hull.depth;
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if (hydrostatics(sampleSections(hull), mid).volume < displacement / 2) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const wideT = draftFor(wide);
  const narrowT = draftFor(narrow);
  const wideH = hydrostatics(sampleSections(wide), wideT);
  const narrowH = hydrostatics(sampleSections(narrow), narrowT);
  assert.ok(
    Math.abs(wideH.volume / narrowH.volume - 1) < 0.01,
    "the two hulls should be floating the same displacement",
  );
  const bmWide = wideH.waterplaneI / wideH.volume;
  const bmNarrow = narrowH.waterplaneI / narrowH.volume;
  assert.ok(
    bmWide > 4 * bmNarrow,
    `wide beam BM ${bmWide.toFixed(3)} should dwarf narrow BM ${bmNarrow.toFixed(3)}`,
  );
});

console.log(`\n${passed} hydrostatics checks passed`);
