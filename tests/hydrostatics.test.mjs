/**
 * Hydrostatics tests. Every expectation here is a number computed independently
 * of the code under test -- closed-form integrals of the hull form, or a
 * hand-worked box -- never a value read back out of hydrostatics().
 */
import assert from "node:assert/strict";
import { Hull, TUMBLEHOME } from "../src/hull.js";
import { sampleSections, hydrostatics } from "../src/hydrostatics.js";
import { buildHeel, heelAt } from "../src/sections.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok   ${name}`);
}

/**
 * Displacement of a hull form, from an exact factorisation.
 *
 * halfBreadth(u, z) is a PRODUCT of a function of u and a function of z:
 *
 *     halfBreadth = (B/2) * longitudinalTaper(u) * verticalTaper(z)
 *
 * so the volume integral separates and no double quadrature is needed:
 *
 *     V = L * B * D * mean(longitudinalTaper) * mean(verticalTaper)
 *
 * Both means then have elementary closed forms -- the taper mean is
 * B(1/2, e/2 + 1)/2, and the vertical profile is piecewise polynomial with both
 * pieces integrable by hand. Computing them from the hull's OWN accessor methods
 * keeps this tied to the shape under test while sharing no code path with
 * src/sections.js, which integrates columns resolved by inverting the hull form.
 * Independent in method, exact in value: the combination a reference wants.
 *
 * This replaces a nested 4001x4001 Simpson. That version was slow enough to stall
 * the suite and, worse, not accurate enough to justify the tolerances used with
 * it -- its own Richardson error estimate was 1.0e-4, against a 2e-4 claim. A
 * reference has to be more accurate than the assertion made against it; when it
 * is not, the fix is a better reference rather than a looser tolerance.
 */
function referenceDisplacement(hull) {
  const logGamma = (x) => {
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    const g = [
      0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    const z = x - 1;
    let series = g[0];
    for (let i = 1; i < g.length; i += 1) series += g[i] / (z + i);
    const t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
  };
  const taperMean = (() => {
    const p = hull.taperExponent / 2;
    return Math.exp(Math.log(Math.PI) / 2 + logGamma(p + 1) - logGamma(p + 1.5)) / 2;
  })();
  const verticalMean = (() => {
    const fl = hull.flangeFraction;
    const lower = fl / (hull.bilgeExponent + 1);
    const upper = (1 - fl) * (1 - 0.15 / 3);
    return lower + upper;
  })();
  return hull.length * hull.beam * hull.depth * taperMean * verticalMean;
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
    const actual = referenceDisplacement(hull) / (12 * 4 * 2.4);
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
  const exact = referenceDisplacement(hull);
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

check("the block coefficient is the displacement across the whole range", () => {
  // Cb identifies a hull, so declared and actual must agree at BOTH ends of the
  // range and not merely where the calibration happens to be comfortable.
  // Measured with a 0.0496% bias at every Cb, and before that with an error that
  // grew with Cb because the taper mean was a fixed-resolution Simpson and
  // Simpson degrades exactly where the shape needs it most: as the exponent
  // falls the taper becomes a flat plateau with steep shoulders. Tolerance is
  // absolute on Cb, which is the quantity the user asked for.
  for (const Cb of [0.4, 0.5, 0.62, 0.7, 0.78]) {
    const hull = new Hull({
      length: 12,
      beam: 4,
      depth: 2.4,
      blockCoefficient: Cb,
      prismaticCoefficient: 0.9,
    });
    const actual = referenceDisplacement(hull) / (12 * 4 * 2.4);
    assert.ok(
      Math.abs(actual - Cb) < 1e-6,
      `declared Cb ${Cb} but the form displaces ${actual.toFixed(9)}`,
    );
  }
});

check("a full-depth float is the same as the hull's declared volume", () => {
  // Guards the boundary condition a solver likes to miss: floated at the deck,
  // the displaced volume has to equal the whole hull.
  for (const Cb of [0.4, 0.62, 0.78]) {
    const hull = new Hull({
      length: 12,
      beam: 4,
      depth: 2.4,
      blockCoefficient: Cb,
      prismaticCoefficient: 0.9,
    });
    const declared = 12 * 4 * 2.4 * Cb;
    const got = heelAt(buildHeel(hull, 0, { nu: 401, nx: 401 }), hull.depth).volume;
    // Band from measurement, not optimism: the transverse Simpson is the limit
    // here and it is 8.9e-4 relative at block coefficient 0.78 with nx = 401,
    // because a fuller hull has more of its area out near the deck edge where the
    // column height changes fastest. Tightening this means refining nx, not
    // hoping.
    assert.ok(
      Math.abs(got / declared - 1) < 1.5e-3,
      `full-depth displacement ${got.toFixed(4)} vs declared ${declared.toFixed(4)}`,
    );
  }
});

check("the vertical profile mean is exact, because Cb is solved against it", () => {
  // The taper exponent is calibrated so the hull displaces its declared block
  // coefficient. That calibration divides by meanVerticalProfile(), so any error
  // there is not a rounding detail -- it lands in Cb, the one number the user
  // set. A left-endpoint rectangle average here read 0.82431001 against a true
  // 0.82451342 and made every hull's Cb wrong by 0.0496% while everything still
  // looked right. So the mean is pinned against a closed form that shares no code
  // with it, and against brute-force brute integration of the profile itself.
  for (const Cb of [0.4, 0.62, 0.78]) {
    const hull = new Hull({
      length: 12,
      beam: 4,
      depth: 2.4,
      blockCoefficient: Cb,
      prismaticCoefficient: 0.9,
    });
    const fl = hull.flangeFraction;
    // Both pieces of the piecewise profile integrate elementarily.
    const closedForm =
      fl / (hull.bilgeExponent + 1) + (1 - fl) * (1 - TUMBLEHOME / 3);
    const got = hull.meanVerticalProfile();
    assert.ok(
      Math.abs(got - closedForm) < 1e-12,
      `meanVerticalProfile ${got.toFixed(12)} vs closed form ${closedForm.toFixed(12)}`,
    );

    // Independent of the closed form: midpoint integration of verticalTaper.
    // Held to a loose band on purpose -- this is the weaker of the two checks and
    // it exists to catch a wrong SHAPE (a mis-stated tumblehome or bilge
    // exponent), not to re-derive the constant above.
    const n = 200001;
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += hull.verticalTaper(((i + 0.5) / n) * hull.depth);
    }
    const brute = sum / n;
    assert.ok(
      Math.abs(brute - got) < 1e-6,
      `brute-force mean ${brute.toFixed(9)} vs meanVerticalProfile ${got.toFixed(9)}`,
    );
  }
});

check("the longitudinal rule contributes nothing measurable past nu = 32", () => {
  // Measured with the transverse direction pinned well past its own floor
  // (nx = 513, where the transverse term is ~4e-6), varying nu ALONE at
  // Cb = 0.62:
  //
  //   nu =   8 ->  5.8e-4     nu =  64 ->  2.3e-5
  //   nu =  16 ->  9.3e-5     nu = 128 ->  1.3e-5
  //   nu =  32 ->  3.4e-6     nu = 256 ->  4.2e-6
  //
  // So the term is at the floor by nu = 32 and refining further buys nothing:
  // Gauss-Legendre on a smooth body has no asymptotic power law left to measure
  // there. What is worth asserting is that the term STAYS at the floor, because
  // a rule that silently degraded with resolution -- or an index misalignment
  // dressed up as divergent numerics, which is what a -515% volume here once
  // turned out to be -- would show up as the tail growing.
  //
  // Asserting monotone descent instead would be asserting something the data
  // contradicts. nu = 64 through 256 wobble between 4e-6 and 2e-5 around the
  // floor, and that scatter is two terms of comparable size adding with
  // alternating signs, not a stall. A plateau at the floor is a solved term;
  // a plateau far above it is the failure mode worth failing on, and the
  // default-resolution check below is what catches that.
  const hull = new Hull({
    length: 12,
    beam: 4,
    depth: 2.4,
    blockCoefficient: 0.62,
    prismaticCoefficient: 0.9,
  });
  const exact = referenceDisplacement(hull);
  let floor = Infinity;
  const tail = [];
  for (const nu of [8, 16, 32, 64, 128, 256]) {
    const got = heelAt(buildHeel(hull, 0, { nu, nx: 513 }), hull.depth).volume;
    const error = Math.abs(got / exact - 1);
    floor = Math.min(floor, error);
    if (nu >= 32) tail.push(error);
  }
  assert.ok(
    floor < 1e-5,
    `longitudinal term never reached its floor: best was ${floor.toExponential(2)}`,
  );
  for (const error of tail) {
    assert.ok(
      error < 5e-5,
      `longitudinal term regressed above the floor: ${error.toExponential(2)} ` +
        `vs floor ${floor.toExponential(2)}`,
    );
  }
});

check("the transverse rule improves monotonically, measured on its own", () => {
  // The mirror image, and the direction that actually limits accuracy. Pin nu at
  // 256 -- where the check above shows the longitudinal term is at the floor --
  // and refine only across the beam, composite Simpson doubling each step. This
  // is the one direction where descent is a real, measurable contract, so it is
  // the one place monotonicity is asserted: nx = 129 -> 513 -> 2049 gives
  // 1.9e-5 -> 4.2e-6 -> 1.1e-6, roughly second order. Which is why the default
  // resolution puts its budget here (nx = 481) rather than going square.
  const hull = new Hull({
    length: 12,
    beam: 4,
    depth: 2.4,
    blockCoefficient: 0.62,
    prismaticCoefficient: 0.9,
  });
  const exact = referenceDisplacement(hull);
  let previous = Infinity;
  for (const nx of [129, 513, 2049]) {
    const got = heelAt(buildHeel(hull, 0, { nu: 256, nx }), hull.depth).volume;
    const error = Math.abs(got / exact - 1);
    assert.ok(
      error < previous,
      `transverse term stopped improving at nx=${nx}: ` +
        `${error.toExponential(2)} vs ${previous.toExponential(2)}`,
    );
    previous = error;
  }
  assert.ok(
    previous < 1e-5,
    `nx=2049 transverse term ${previous.toExponential(2)} exceeds 1e-5`,
  );
});

check("the default resolution is inside the band the model is built on", () => {
  // The whole model's honesty rests on this band, so it is asserted at the
  // resolution the app actually uses, across the full block-coefficient range,
  // rather than at one convenient hull. Measured with a 200-step column-boundary
  // inversion, the defaults land at 7e-6 / 1.2e-5 / 2.1e-6 relative for
  // Cb = 0.40 / 0.62 / 0.78, and doubling the inversion depth changes the
  // answer by nothing at all: the boundary solver is not the limit, the
  // transverse quadrature is. The band is 2e-5 -- the worst measured case
  // (Cb=0.62) with room for a different machine's floating point, and roughly
  // 100x tighter than the 0.1% the model is quoted to.
  for (const Cb of [0.4, 0.62, 0.78]) {
    const hull = new Hull({
      length: 12,
      beam: 4,
      depth: 2.4,
      blockCoefficient: Cb,
      prismaticCoefficient: 0.9,
    });
    const exact = referenceDisplacement(hull);
    const got = heelAt(buildHeel(hull, 0), hull.depth).volume;
    const error = Math.abs(got / exact - 1);
    assert.ok(
      error < 2e-5,
      `default resolution at Cb=${Cb} is ${error.toExponential(2)} off, band is 2e-5`,
    );
  }
});

console.log(`\n${passed} hydrostatics checks passed`);
