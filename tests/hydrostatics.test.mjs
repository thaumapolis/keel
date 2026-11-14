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

check("LCF is the waterplane centroid, including when it is not at midships", () => {
  // The pre-fix integrand multiplied by a literal 0, so LCF reported 0 for
  // every hull. A symmetry test alone would not have caught that -- 0 is the
  // right answer for a symmetric ship -- so this pins the interesting case too:
  // a waterplane whose centroid is NOT at midships, against a centroid
  // recomputed in the test by adaptive Simpson over u, an independent method and
  // an independent parameterisation of the same shape.
  //
  // The offset is produced by skewing the station abscissa, which is a legal
  // thing to feed hydrostatics (it integrates over whatever ys it is given).
  // Direction: y = L*(u^1.6 - 0.5) bunches stations at u=0 and spaces them out
  // toward u=1. The taper is even about u=0.5, where halfBreadth is at its
  // maximum, so the broader half of the waterplane -- u < 0.5, negative y --
  // lands in the *denser* sampling, and the centroid must come out forward of
  // midships. Asserting the other sign here would have been a guess.
  const hull = new Hull({
    length: 12,
    beam: 4,
    depth: 2.4,
    blockCoefficient: 0.62,
    prismaticCoefficient: 0.9,
  });
  const stations = sampleSections(hull);

  // Claim 1: symmetric hull, symmetric sampling => centroid exactly y = 0, at
  // every waterline. This is what catches an LCF that is nonzero by accident.
  for (const fraction of [0.3, 0.55, 0.9]) {
    const h = hydrostatics(stations, fraction * hull.depth);
    assert.ok(
      Math.abs(h.LCF) < 1e-12,
      `symmetric waterplane at ${(fraction * 100).toFixed(0)}% depth gave LCF ${h.LCF}`,
    );
  }

  // Claim 2: an asymmetric waterplane has a nonzero centroid, and it agrees
  // with an independent quadrature to better than 0.5%.
  const skew = (u) => hull.length * (Math.pow(u, 1.6) - 0.5);
  const skewed = stations.map((station, i) => ({
    ...station,
    y: skew(i / (stations.length - 1)),
  }));
  const waterline = 0.55 * hull.depth;
  const actual = hydrostatics(skewed, waterline);

  // Reference: same shape, integrated over u with dy/du as the Jacobian, so the
  // test's abscissa is uniform rather than the code's skewed one.
  const simpson = (f, a, b, steps) => {
    const h = (b - a) / steps;
    let total = f(a) + f(b);
    for (let i = 1; i < steps; i += 1) total += f(a + i * h) * (i % 2 ? 4 : 2);
    return (h / 3) * total;
  };
  const dydu = (u) => hull.length * 1.6 * Math.pow(u, 0.6);
  const strip = (u) => 2 * hull.halfBreadth(u, waterline) * dydu(u);
  const referenceArea = simpson(strip, 0, 1, 8001);
  const referenceLCF =
    simpson((u) => strip(u) * skew(u), 0, 1, 8001) / referenceArea;

  assert.ok(
    actual.LCF < -0.1,
    `centroid should be forward of midships, got ${actual.LCF.toFixed(4)}`,
  );
  assert.ok(
    Math.abs(actual.LCF - referenceLCF) < 0.005 * Math.abs(referenceLCF),
    `LCF ${actual.LCF.toFixed(5)} vs independent ${referenceLCF.toFixed(5)}`,
  );
});

console.log(`\n${passed} hydrostatics checks passed`);
