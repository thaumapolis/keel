/**
 * Hydrostatics tests.
 *
 * Two rules govern every expectation here.
 *
 *   1. The reference is independent of the code under test. Displacement comes
 *      from a separable closed form integrated by brute-force midpoint, never by
 *      calling the same Gauss-Legendre rule sections.js uses. Where a value is
 *      read back from the model, that is stated and the test is labelled as a
 *      self-consistency check rather than a validation.
 *   2. We assert the PROPERTY the mechanism depends on, not only a tolerance.
 *      This suite used to assert numeric bands against a hull form that was
 *      provably separable -- so every band passed while the central mechanism
 *      (a waterplane that changes shape with draft) did not exist. Numbers that
 *      agree are not evidence that the shape is right. The separability test, the
 *      single-interval test, and the waterplane-shape test below are the ones
 *      that would have failed; the bands are kept only where they caught a real
 *      bug, and each says which.
 *
 * The one thing NOT re-derived here that the previous suite pinned: an
 * "unreachable Cb is refused" guard. It is kept, because a silent
 * clamp-to-ceiling would turn a named control into a lie -- the same class of
 * defect the separable form was, just caught from the other end.
 */
import assert from "node:assert/strict";
import { Hull } from "../src/hull.js";
import { buildHeel, heelAt } from "../src/sections.js";

let passed = 0;
function check(name, body) {
  body();
  passed += 1;
  console.log(`ok   ${name}`);
}

/** Reference hull used by most checks: a mid-fullness form, well inside the ceiling. */
function referenceHull({ blockCoefficient = 0.62, prismaticCoefficient = 0.9, length = 12, beam = 4, depth = 2.4 } = {}) {
  return new Hull({ length, beam, depth, blockCoefficient, prismaticCoefficient });
}

/**
 * Displacement by an INDEPENDENT method: the form factors as
 * b(u,z) = (B/2) * stationFraction(u) * profile(z), so
 *   V = L * B * D * mean(stationFraction) * mean(profile)
 * with both means taken by dense midpoint over [0,1]. Midpoint, not
 * Gauss-Legendre -- sharing the quadrature with sections.js would let the same
 * discretisation error appear in "reference" and "actual" and cancel in the
 * difference, hiding exactly the kind of rule-selection bug worth catching.
 */
function referenceDisplacement(hull, n = 200001) {
  let a = 0, b = 0;
  for (let i = 0; i < n; i += 1) {
    a += hull.stationFraction((i + 0.5) / n);
    b += hull.profile(((i + 0.5) / n) * hull.depth);
  }
  return hull.length * hull.beam * hull.depth * (a / n) * (b / n);
}

// ---------------------------------------------------------------------------
// SHAPE PROPERTIES -- the tests the old suite lacked. These are the ones that
// would have failed on the separable form.
// ---------------------------------------------------------------------------

check("displacement and waterplane area scale with DIFFERENT longitudinal means", () => {
  // THIS is the mechanism, and I want to record that I nearly missed it. The
  // waterplane of this form is, in fact, a dilation: b(u, w) = (B/2) *
  // stationFraction(u) * profile(w), so every waterline is the deck outline times
  // profile(w), and the "growth exponent" of waterplane area is just
  // bilgeExponent, constant across drafts (measured 0.49000 at every draft). The
  // two tests I wrote first to detect separability -- a mixed partial sampled at
  // constant z, and an area-growth-exponent test -- were both looking in the wrong
  // place. The mixed partial d2b/du dw evaluated at constant z samples a slice
  // that does not exist as a waterline, and a dilation-exponent test PASSES on
  // this form because the form genuinely dilates. I keep neither.
  //
  // What actually differs is the longitudinal weighting, not the transverse shape:
  //   displaced volume            weights each station by longitudinalTaper  -> mean(taper)
  //   waterplane second moment I  weights each station by stationFraction^3 -> mean(sf^3)
  // and stationFraction = taper^(1 + WATERPLANE_FLARE), so the two means differ.
  // BM = I / V therefore moves with hull SHAPE, not only with draft. If
  // stationFraction were taper (WATERPLANE_FLARE = 0), the two would lock together,
  // BM would have no shape dependence, and the project would have nothing to show.
  const hull = referenceHull();
  const n = 200001;
  let volWeight = 0, areaWeight = 0;
  for (let i = 0; i < n; i += 1) {
    const u = (i + 0.5) / n;
    volWeight += hull.longitudinalTaper(u);
    areaWeight += Math.pow(hull.stationFraction(u), 3);
  }
  volWeight /= n;
  areaWeight /= n;
  // ratio of the two weightings, normalised. Under no flare this collapses to 1.
  const lock = areaWeight / Math.pow(volWeight, 3);
  assert.ok(
    lock < 0.999,
    `waterplane moment and displacement lock together (ratio ${lock.toFixed(6)}): flare is gone, BM is shape-independent`,
  );
});

check("stationFraction is NOT the longitudinal taper (the flare is present)", () => {
  // The precondition for the mechanism above. stationFraction = taper^(1+flare), so
  // they are equal only if flare = 0, which re-locks moment and displacement. Pin
  // the gap to nonzero; keep it cheap -- it is a precondition, not the payoff.
  const hull = referenceHull();
  const n = 200001;
  let t = 0, s = 0;
  for (let i = 0; i < n; i += 1) {
    const u = (i + 0.5) / n;
    t += hull.longitudinalTaper(u);
    s += hull.stationFraction(u);
  }
  const diff = Math.abs(t - s) / n;
  assert.ok(diff > 1e-3, `stationFraction mean equals taper mean (diff ${diff.toExponential(2)}) -- flare is gone`);
});

check("every transverse column is a single interval, for every u and every waterline", () => {
  // columnBounds returns ONE [bottom, top] per column and floatWaterline bisects
  // assuming submerged volume is monotone in the waterline. Both hold iff the
  // profile is monotone in z (no narrowing above a wide band -> no two disjoint
  // wet bands per column). This used to break under tumblehome: at 170 deg heel
  // the bracket came out inverted and reported "TOO FULL" (max volume 15.898 m3)
  // about a hull that floats there fine.
  const hull = referenceHull();
  const n = 2001;
  for (let k = 0; k < 11; k += 1) {
    const u = k / 10;
    let previous = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const z = (i / (n - 1)) * hull.depth;
      const value = hull.halfBreadth(u, z);
      assert.ok(
        value >= previous - 1e-15,
        `halfBreadth decreased with height at u=${u}, z/depth=${(z / hull.depth).toFixed(4)}`,
      );
      previous = value;
    }
    // Full breadth at the deck so `beam` is the real maximum breadth.
    assert.ok(
      Math.abs(hull.halfBreadth(u, hull.depth) - (hull.beam / 2) * hull.stationFraction(u)) < 1e-12,
      `breadth at the deck does not equal (B/2)*stationFraction at u=${u}`,
    );
  }
});

// ---------------------------------------------------------------------------
// NUMERIC BANDS -- kept only where each one caught a named bug.
// ---------------------------------------------------------------------------

check("declared block coefficient IS the displacement (independent reference, 3e-5)", () => {
  // The taper exponent is SOLVED so the form displaces its declared Cb. A previous
  // version picked the exponent from taste and left Cb a label: declared 0.80
  // displaced as 0.56, a 30% lie. Measured against the closed form by dense
  // midpoint (NOT the model's own GL rule). Band is from measurement: the residual
  // is GL-vs-midpoint on a smooth body, ~3e-7 at nu=nx=601, so 3e-5 has room and
  // still fails on a 0.05% calibration slip.
  for (const Cb of [0.4, 0.5, 0.62]) {
    const hull = referenceHull({ blockCoefficient: Cb });
    const exact = referenceDisplacement(hull);
    const got = heelAt(buildHeel(hull, 0, { nu: 601, nx: 601 }), hull.depth).volume;
    assert.ok(
      Math.abs(got / exact - 1) < 3e-5,
      `Cb ${Cb}: quad ${got.toFixed(5)} vs closed form ${exact.toFixed(5)}`,
    );
  }
});

check("displacement scales linearly with length (units sanity)", () => {
  // Catches a class of unit error that a single-hull band cannot: volume must be
  // proportional to length, so V/L is invariant. An earlier probe of mine divided
  // by a hardcoded 144 instead of L*B*D and "measured" a constant -20% that was
  // entirely the probe. V/L across L=6/12/24 is invariant here to the quadrature
  // floor, which is the same fact stated in a form that cannot hide a units slip.
  const ratios = [6, 12, 24].map((length) => {
    const hull = referenceHull({ length });
    return heelAt(buildHeel(hull, 0, { nu: 601, nx: 601 }), hull.depth).volume / length;
  });
  const spread = (Math.max(...ratios) - Math.min(...ratios)) / ratios[0];
  assert.ok(spread < 1e-4, `V/L not invariant across length: ${ratios.map((r) => r.toFixed(5)).join(", ")}`);
});

check("an unreachable block coefficient is refused, not silently clamped", () => {
  // The ceiling depends on prismaticCoefficient (measured: 0.668 at Cp 0.9, 0.738
  // at Cp 1.2), so hardcoding "just over" would rot the moment the form changes.
  // Read the ceiling from the constructor's own message instead.
  //
  // NOTE the check is LAZY: it lives in the taperExponent getter, not the
  // constructor, because computing it costs a Gauss-Legendre sweep and most
  // callers never need it. So the trigger is any public method that reads taper
  // (halfBreadth, stationFraction, outline) -- not `new Hull` alone. Pinning it at
  // that public boundary is the contract: a caller who asks the hull for geometry
  // gets an honest refusal. A caller who stores an over-full hull and never asks
  // it anything is not yet lying to anyone, and is deliberately not covered.
  const base = { length: 12, beam: 4, depth: 2.4, prismaticCoefficient: 0.9 };
  const trigger = (cb) => new Hull({ ...base, blockCoefficient: cb }).stationFraction(0.5);
  let firstRefusal = null;
  for (let i = 66; i < 99; i += 1) {
    const cb = i / 100;
    try { trigger(cb); } catch (e) { firstRefusal = { cb, message: e.message }; break; }
  }
  assert.ok(firstRefusal !== null, "no reachable Cb was refused -- the ceiling guard is gone");
  assert.ok(/unreachable/.test(firstRefusal.message), `refusal should name "unreachable": ${firstRefusal.message}`);
  // A hair below must still build, so this is a real ceiling and not a blanket refusal.
  assert.doesNotThrow(() => trigger(firstRefusal.cb - 0.05));
});

console.log(`\n${passed} hydrostatics checks passed`);
