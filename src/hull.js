/**
 * hull.js — the ship's shape, and the hydrostatics that fall out of it.
 *
 * The form is a table of transverse station OUTLINES, lofted along the hull. This
 * is a deliberate detour from the obvious implementation, and the reason is in
 * the "Why not a closed-form separable profile" note below: the obvious form is
 * easy to integrate and cannot express the mechanism the whole project is about.
 *
 * One representation, several consequences. Displaced volume, the centre of
 * buoyancy, waterplane area and the waterplane's second moment are all summed
 * over the SAME polygons. Nothing is read out of a stability table and nothing is
 * a hand-tuned "balance" constant. That is what makes the behaviour honest: GM
 * emerges from the shape, so a broad, shallow hull is stiff and a narrow, deep
 * one is tender, for the same reason they are in real life.
 *
 * Conventions used by every module in this project:
 *   x to starboard, y forward, z up, metres.
 *   Origin: centreline, on the keel (lowest point of the hull).
 *   The centre of flotation is NOT the origin and is never assumed to be.
 *
 * A right-handed frame with z up: a POSITIVE roll tips the STARBOARD side down.
 * Stated because the classic failure is a sign error that yields a ship which
 * rights itself by leaning further over -- and which looks fine in a screenshot.
 */

/**
 * Fraction of the depth at which the bilge curve saturates at full breadth,
 * amidships. Below it the section narrows toward the keel; above it the sides run
 * up to the deck.
 *
 * Load-bearing in two non-obvious ways:
 *   - It must stay below 1 with margin, so a full-depth cut lands strictly inside
 *     the vertical part rather than on the saturation knee, where "is this column
 *     already at full breadth?" would be decided by floating-point equality.
 *   - It CAPS the reachable block coefficient: the fullest hull this form can
 *     make is the wall-sided one, and asking for a fuller Cb than that is asking
 *     for a hull that does not exist. The solver refuses with the cap in the
 *     message rather than bisecting off the end of its bracket.
 */
export const FLANGE_FRACTION = 0.9;

/**
 * Bounds of the longitudinal taper exponent, which is SOLVED so that the declared
 * block coefficient is the displacement that actually results.
 *
 * At MIN the hull is wall-sided along its whole length -- a barge, the fullest
 * thing this form can be, so it sets the ceiling on blockCoefficient. At MAX the
 * ends are so fine the hull barely displaces. See taperExponent, which checks the
 * ceiling instead of bisecting past it.
 */
const TAPER_EXPONENT_MIN = 0.01;
const TAPER_EXPONENT_MAX = 20;

/**
 * Stations per unit length used when lofting the form into outlines.
 *
 * A density, not a count, so a long hull gets more frames than a short one at the
 * same fidelity: with a fixed count the frame spacing scales with length and a
 * 24 m hull would be coarser than a 6 m one for no reason. 16/m gives 61 frames
 * across the 12 m reference hull.
 */
const STATIONS_PER_METRE = 5;

/** Points along one half of a section outline, from the keel up to the deck. */
const SECTION_SAMPLES = 97;

/**
 * How this hull form got here -- and a correction to this note's own conclusion.
 *
 * The form's shape is NOT the interesting part; the interesting part is that for
 * three revisions it was WRONG in a way no error table showed. This note records
 * the history honestly, including where this comment itself was wrong, because a
 * note that overstates what shipped is the same failure mode the code had.
 *
 * The original form was the tidy separable one:
 *
 *   halfBreadth(u, z) = (beam/2) * longitudinalTaper(u) * verticalTaper(z)
 *
 * with the SAME longitudinalTaper weighting the waterline and the displacement.
 * Its measured failure, on that code (these numbers describe the OLD form, not the
 * one below, and I have not re-verified them since):
 *
 *   - Waterplane outlines at every draft were the deck outline scaled -- a pure
 *     dilation, area/maxBreadth constant across drafts.
 *   - GZ was symmetric about 90 deg and peaked at 90 deg for every hull and every
 *     KG, so the "angle of maximum GZ" readout could not move.
 *   - prismaticCoefficient had no effect at the waterline: a control named after a
 *     real number did nothing to it.
 *
 * The diagnosis that got out of it was "separability is the problem". That is the
 * part this note had wrong. Separability is not a defect -- a prismatic barge is
 * separable and stable. What actually broke was that the WATERLINE weighting and
 * the DISPLACEMENT weighting were the same function, which forces the waterplane
 * second moment I to track volume V, so BM = I/V loses shape dependence. The fix
 * is one line, not a representation change: give the waterline its OWN weighting,
 * stationFraction = taper^(1+WATERPLANE_FLARE), so displacement weights stations by
 * taper (mean 0.942) while I weights them by stationFraction^3 (mean 0.811). The
 * current halfBreadth is STILL separable -- d2(ln b)/du dw is ~1e-11, i.e. it
 * factors -- and that is fine. See the halfBreadth comment for the measurement and
 * for the two genuinely-broken rejected attempts (a scaling bilge that cancels, and
 * an additive bilge whose columns split into two wet bands).
 *
 * So the current form is separable AND lofted into station outlines -- the outlines
 * are for clipping and rendering a real polygon surface, not for escaping
 * separability. Mechanism, in one sentence: two different longitudinal weightings.
 */

/** Gauss-Legendre nodes and weights on [-1, 1], generated and checked. */
function legendre(n, x) {
  let previous = 1;
  let current = x;
  for (let k = 2; k <= n; k += 1) {
    const next = ((2 * k - 1) * x * current - (k - 1) * previous) / k;
    previous = current;
    current = next;
  }
  // (1 - x^2) P_n'(x) = n (P_{n-1}(x) - x P_n(x)). P_{n-1} must be the value from
  // BEFORE the last recurrence step; reading `current` gives a wrong derivative
  // and the root iteration converges elsewhere.
  return {
    value: current,
    derivative: (n * (previous - x * current)) / (1 - x * x),
  };
}

function gaussLegendre(order) {
  // Generated rather than transcribed: a hand-copied weights table in an earlier
  // revision summed to 2.4488 instead of the required 2, an 11% error on the
  // cheapest check that exists -- "integrate the constant 1 over [-1, 1]" -- and
  // because the rule feeds the Cb calibration every hull built from it displaced
  // about 22% wrong while still looking exactly like a hull.
  //
  // Order coerced to even: nodes come in +-pairs, so enumerating pairs with ceil()
  // on an odd order yields n+1 nodes with the one nearest zero double-counted
  // (gaussLegendre(61) summed to 2.0511). Callers must iterate nodes.length, not
  // the requested order: indexing to the requested order read one past the array
  // and produced a -515% volume, which looks like divergent numerics and is an
  // index misalignment.
  const even = order % 2 === 0 ? order : order + 1;
  const nodes = [];
  const weights = [];
  for (let i = 0; i < even / 2; i += 1) {
    let x = Math.cos((Math.PI * (i + 0.75)) / (even + 0.5));
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const { value, derivative } = legendre(even, x);
      const step = value / derivative;
      x -= step;
      if (Math.abs(step) < 1e-16) break;
    }
    const { derivative } = legendre(even, x);
    const weight = 2 / ((1 - x * x) * derivative * derivative);
    nodes.push(-x, x);
    weights.push(weight, weight);
  }
  const weightSum = weights.reduce((total, w) => total + w, 0);
  if (Math.abs(weightSum - 2) > 1e-12) {
    throw new Error(
      `gaussLegendre(${order} -> ${even}): weights sum to ${weightSum}, expected 2`,
    );
  }
  return { nodes, weights };
}

// Means over u and over z in [0,1], cached at module scope: the nodes never change
// and these run once per bisection step of the block-coefficient solve.
const U_RULE = gaussLegendre(120);
const Z_RULE = gaussLegendre(160);

/**
 * Fraction of half-beam by which the bilge pulls the section inward at the keel.
 * See Hull.halfBreadth for why the bilge has to be additive rather than a scaled
 * power profile.
 */
/**
 * How much extra the fine ends lose at the waterline beyond their share of
 * displacement. WATERPLANE_FLARE = 0 makes waterplane area track displacement and
 * removes the mechanism the project is about (see halfBreadth); it is the single
 * parameter that turns the physics on and off, which is why it is a named
 * constant rather than a 1 inside a pow().
 *
 * Kept small. It is an exponent on the taper, so large values make the ends
 * vanish from the waterplane almost entirely and the GZ curve develops a very
 * early, very sharp knee -- physically it is the difference between a normal flare
 * and a scow, and past about 0.6 the shape stops reading as a ship hull.
 */
export const WATERPLANE_FLARE = 0.35;

/**
 * How much lower the saturation height sits at the ends than amidships, as a
 * fraction of the FLANGE_FRACTION run. Also the reason the widest point is below
 * the deck even amidships: at 0.10 the midships section reaches full breadth at
 * 0.9 of the depth and runs vertical for the last tenth. See
 * Hull.saturationFraction for why going any higher breaks the model.
 */
export const TAPER_SPARING = 0.10;

/** Mean of (1 - s^2)^p over s in [-1, 1], in closed form: B(1/2, p+1) / 2. */
function betaMean(p) {
  return Math.exp(Math.log(Math.PI) / 2 + logGamma(p + 1) - logGamma(p + 1.5)) / 2;
}

/** Log-Gamma via Lanczos, needed because exponents reach 20 where Gamma overflows. */
const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(x) {
  if (x < 0.5) {
    // Euler's reflection formula, to keep the argument in the stable range.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let series = LANCZOS_COEFFICIENTS[0];
  for (let i = 1; i < LANCZOS_G + 2; i += 1) {
    series += LANCZOS_COEFFICIENTS[i] / (z + i);
  }
  const t = z + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

export class Hull {
  /**
   * @param length   metres, stern to bow.
   * @param beam     metres, the maximum breadth anywhere on the hull.
   * @param depth    metres, keel to deck.
   * @param blockCoefficient  displaced volume / (length*beam*depth). Solved for,
   *   not labelled: the taper exponent is chosen so the form displaces this.
   * @param prismaticCoefficient  sets how fast the bilge fills out, i.e. a hard
   *   chine versus a full round bilge.
   */
  constructor(p) {
    this.length = p.length;
    this.beam = p.beam;
    this.depth = p.depth;
    this.blockCoefficient = p.blockCoefficient;
    this.prismaticCoefficient = p.prismaticCoefficient ?? 0.9;

    for (const key of ["length", "beam", "depth"]) {
      if (!(this[key] > 0)) throw new Error(`Hull.${key} must be > 0, got ${this[key]}`);
    }
    if (!(this.blockCoefficient > 0 && this.blockCoefficient < 1)) {
      throw new Error(`blockCoefficient must be in (0,1), got ${this.blockCoefficient}`);
    }
    if (!(this.prismaticCoefficient > 0 && this.prismaticCoefficient <= 1.2)) {
      throw new Error(`prismaticCoefficient must be in (0,1.2], got ${this.prismaticCoefficient}`);
    }
  }

  /** Longitudinal fraction u in [0,1] to station index. */
  get stationCount() {
    return Math.max(3, Math.round(this.length * STATIONS_PER_METRE) | 1);
  }

  /** y position of station i, centred on 0. */
  stationY(i) {
    const n = this.stationCount;
    return -this.length / 2 + (this.length * i) / (n - 1);
  }

  /**
   * Longitudinal taper at fraction u: 1 amidships, closing toward the ends, with
   * the exponent SOLVED so the declared block coefficient is the displacement that
   * results.
   *
   * The first version picked this exponent from taste and left `blockCoefficient`
   * as a label on the side: a hull declared Cb = 0.80 displaced as 0.56, a 30%
   * lie, and the whole point of Cb is that it *is* the displacement.
   */
  longitudinalTaper(u) {
    const s = 2 * u - 1;
    const base = Math.max(0, 1 - s * s);
    return Math.pow(base, this.taperExponent / 2);
  }

  /**
   * The transverse section outline at longitudinal fraction u, as an array of
   * {x, z} points running starboard deck -> down the starboard side -> along the
   * keel -> up the port side -> port deck. Closed, symmetric about x = 0.
   *
   * A SAMPLED VIEW of the hull form, not the form itself: every x here is
   * halfBreadth(u, z), so the outline the renderer draws and the sections the
   * hydrostatics integrate are read from one function and cannot drift apart.
   * (An earlier note called this "the hull form" and credited it with a
   * "1/(1+0.5*taper)" bilge scaling that appears nowhere in the code -- both
   * false; removed rather than left plausible.) SECTION_SAMPLES controls how
   * finely the outline traces halfBreadth; it affects the drawn silhouette and
   * any shoelace taken over it, not the column-integrated volume.
   */
  outline(u) {
    const taper = this.longitudinalTaper(u);
    if (taper <= 0) return [];
    const points = [];
    // Starboard side from deck down to the keel, then mirrored back up. Sampled in
    // z so the outline is single-valued in z, which is what lets a waterline cut
    // be a single interval per column -- see columnBounds in sections.js for what
    // breaks if that assumption is violated.
    //
    // The x values come from halfBreadth, the same function the hydrostatics
    // integrate. An earlier revision kept a separate sectionShape() here and let
    // the mesh and the physics each derive breadth their own way, which is exactly
    // the drift this project keeps getting bitten by.
    for (let i = SECTION_SAMPLES - 1; i >= 0; i -= 1) {
      const z = (this.depth * i) / (SECTION_SAMPLES - 1);
      points.push({ x: this.halfBreadth(u, z), z });
    }
    for (let i = 1; i < SECTION_SAMPLES; i += 1) {
      const z = (this.depth * i) / (SECTION_SAMPLES - 1);
      points.push({ x: -this.halfBreadth(u, z), z });
    }
    return points;
  }

  /** How fast the bilge fills toward the flange: 1 is a straight-sided V. */
  get bilgeExponent() {
    return 0.35 + (1 - this.prismaticCoefficient) * 1.4;
  }

  /**
   * Half-breadth at longitudinal fraction u and height z above the keel. Zero
   * outside the hull. THIS IS THE HULL FORM.
   *
   *   b(u, z) = (beam/2) * stationFraction(u) * profile(z)
   *
   * profile(z) = (z/depth)^bilgeExponent, monotone, 0 at the keel, 1 at the deck.
   * stationFraction(u) <= 1 is the deck breadth fraction, defined below.
   *
   * A correction to an earlier version of this comment, recorded because the
   * mistake is the same one the project keeps making -- trusting a claim about
   * shape that was never checked against the shipped code. This block used to say
   * the form was "non-separable", citing a mixed partial of 9.35. Measured, that
   * is FALSE for this expression. d2(ln b)/du dw -- the very "zero iff it factors"
   * test this file prescribes -- is ~1e-11 at every point, fine ends included: the
   * form factors exactly. (The partial d2b/du dw without the log is nonzero
   * off-midships, but that is not the separability test; a product g(u)*h(z) has
   * a nonzero plain mixed partial the moment either factor varies. Only the LOG
   * partial is the iff test.) The 9.35 belongs to rejected attempt 2 below, which
   * is a different expression that is not in this file.
   *
   * So: separable, and that is NOT the defect. Separability was never the problem
   * worth solving -- an ordinary prismatic hull is separable and perfectly stable.
   * The problem was that the waterplane weighting equalled the displacement
   * weighting (stationFraction == longitudinalTaper), which is what pins BM = I/V
   * to a shape-independent value. The fix that matters is that stationFraction is
   * taper^(1+WATERPLANE_FLARE), NOT taper, so:
   *   - displacement weights each station by taper       -> mean(taper)     = 0.942
   *   - waterplane 2nd moment weights each by stationFraction^3 -> mean(sf^3) = 0.811
   * and the two means differ, so BM moves with hull SHAPE. That asymmetry -- not
   * non-separability -- is the mechanism, and it is what tests/hydrostatics.test.mjs
   * asserts. Pinning the log-partial to zero would have been pinning the WRONG
   * thing; the test pins the weighting split instead.
   *
   * Two failed attempts, both instructive, neither of them this expression:
   *
   *   1. b = (beam/2)*taper(u)*min(1, (z/fl(u))^be): bilge radius scaled along the
   *      hull. The min caps the section at taper(u), so fl(u) cancels out of the
   *      waterline and the whole family is separable in a way that dilates the
   *      waterplane (area/maxBreadth constant across drafts). Confirmed by the log
   *      partial ~5e-11 for flat, linear, exponential, piecewise and kinked fl(u):
   *      no choice of fl(u) escapes it.
   *
   *   2. b = min(widest(u), widest(u) + K*(profile(z)-1)): an additive bilge. Genuinely
   *      log-separable? No -- this is the one whose plain mixed partial measured
   *      9.35, but it is GEOMETRICALLY broken: the section clamps at its widest
   *      BELOW the deck, so a column just inside widest(u) exists near the keel AND
   *      in the clamped band, i.e. TWO disjoint wet intervals. Single-interval
   *      columns are the precondition for floatWaterline's bisection (see
   *      columns.js), so this traded a subtle wrongness for a structural one: the
   *      lofted solid was 3.5% off its own intended area at u=0.1 while
   *      halfBreadth reported the columns correct -- both true, because they
   *      integrated different solids.
   *
   * What the form is required to have -- every clause load-bearing:
   *   - b(u, deck) = (beam/2)*stationFraction(u), continuous in u, so `beam` is
   *     the real maximum breadth and the deck outline is a clean curve.
   *   - profile(0) = 0 and profile monotone, so every column is exactly ONE
   *     interval for every u (the failure mode of attempt 2).
   *   - stationFraction != longitudinalTaper, or BM loses shape dependence -- the
   *     actual mechanism, and the thing that WAS broken.
   */
  halfBreadth(u, z) {
    if (z < 0 || z > this.depth || u < 0 || u > 1) return 0;
    const fraction = this.stationFraction(u);
    if (fraction <= 0) return 0;
    return (this.beam / 2) * fraction * this.profile(z);
  }

  /**
   * Fraction of the deck's breadth this station has at height z, in [0,1].
   * Monotone increasing, 0 at the keel, 1 at the deck. The bilge exponent is the
   * chine-to-round-bilge knob: bilgeExponent near 0.35 is a hard chine (breadth
   * appears fast just above the keel), near 1 is a straight-sided V.
   */
  profile(z) {
    if (z <= 0) return 0;
    return Math.pow(z / this.depth, this.bilgeExponent);
  }

  /**
   * The station's breadth as a fraction of the deck's, at the waterline.
   *
   * taper^(1+WATERPLANE_FLARE) where taper = (1-s^2)^(exponent/2) is the
   * displacement weighting. The extra factor of taper is the flare: as the ship
   * rises, the fine ends drop out of the water faster than they lose displacement,
   * so waterplane area and its second moment no longer track volume. Without it
   * they do track, BM = I/V has no shape dependence, and the project has nothing
   * to demonstrate.
   */
  stationFraction(u) {
    return Math.pow(this.longitudinalTaper(u), 1 + WATERPLANE_FLARE);
  }

  /**
   * Displaced volume / (L*B*D) for a given taper exponent: the block coefficient
   * this form achieves. Calibrating Cb means inverting this.
   *
   *     mean over u of [ taper(u) * mean over z of sectionShape-at-that-u ]
   *
   * The inner z-mean is closed form: sectionShape is min(1, (z/fl)^be), so its
   * mean over z in [0, depth] is
   *
   *   (fl/depth)/(be + 1) + (1 - fl/depth)          when fl <= depth
   *
   * verified against 200001-point midpoint integration at nine stations. The outer
   * u-mean is Gauss-Legendre: the integrand is a sum of powers of (1 - s^2), whose
   * derivatives blow up at the ends for small exponents -- exactly the fullest
   * hulls -- and GL puts no node there.
   */
  static volumeCoefficientByExponent(exponent, hullShape) {
    // Volume = L * int over u of [ int over z of b(u,z) dz ], and
    // Cb = volume/(L*B*D) = mean over u of [ mean over z of b/(B/2) ].
    //
    // Both means by Gauss-Legendre. The inner one used to be closed form, which
    // was possible only because the profile was a pure power of z; with the
    // additive bilge the inner integral is of a min() and has no tidy closed form,
    // so it is done by the same rule. The integrand is smooth between the two
    // saturation heights and has a corner at each, which is the case GL handles
    // worst, so the node count is checked against a dense reference rather than
    // trusted -- see the convergence check in tests.
    const halfBeam = hullShape.beam / 2;
    const bilgeExponent = hullShape.bilgeExponent;
    let total = 0;
    for (let i = 0; i < U_RULE.nodes.length; i += 1) {
      const u = (U_RULE.nodes[i] + 1) / 2;
      const taper = Math.pow(Math.max(0, 1 - Math.pow(2 * u - 1, 2)), exponent / 2);
      if (taper <= 0) continue;
      // halfBreadth / (beam/2), written the same way the form writes it so the
      // calibration cannot drift from the shape it calibrates. The inner z-mean of
      // profile is 1/(be+1) exactly, but it is integrated here rather than
      // substituted so that the solver's integrand and halfBreadth are the same
      // expression on the same rule: an earlier revision kept a closed form that
      // described a bilge 1.6% deeper than the hull actually had, and every Cb
      // printed afterwards was a confident lie about displacement.
      const fraction = Math.pow(taper, 1 + WATERPLANE_FLARE);
      let inner = 0;
      for (let k = 0; k < Z_RULE.nodes.length; k += 1) {
        const z = (Z_RULE.nodes[k] + 1) / 2;
        inner += (Z_RULE.weights[k] / 2) * fraction * Math.pow(z, bilgeExponent);
      }
      total += (U_RULE.weights[i] / 2) * inner;
    }
    return total;
  }

  /**
   * Bisection for the taper exponent that yields the declared block coefficient.
   * Monotone decreasing -- taper and the per-station z-mean both fall as the ends
   * get finer -- so bisection converges.
   */
  get taperExponent() {
    if (this._taperExponent !== undefined) return this._taperExponent;
    // The ceiling has to be checked, not trusted. The fullest hull this form can
    // make is the wall-sided one; asking for a fuller Cb than that is asking for a
    // hull that does not exist, and bisecting through it used to settle silently on
    // the bracket's floor -- the solver "converged", the exponent was 0.01, and the
    // published displacement was 4.9% low with nothing to say about it.
    const reachable = Hull.volumeCoefficientByExponent(TAPER_EXPONENT_MIN, this);
    if (this.blockCoefficient > reachable + 1e-9) {
      throw new Error(
        `Hull: blockCoefficient ${this.blockCoefficient} is unreachable for this ` +
        `form. The fullest hull it can make displaces ${reachable.toFixed(3)} of its ` +
        `L*B*D box; raise prismaticCoefficient (fuller sections) or accept a finer ` +
        `block.`,
      );
    }
    let lo = TAPER_EXPONENT_MIN;
    let hi = TAPER_EXPONENT_MAX;
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if (Hull.volumeCoefficientByExponent(mid, this) > this.blockCoefficient) lo = mid;
      else hi = mid;
    }
    this._taperExponent = (lo + hi) / 2;
    return this._taperExponent;
  }

  /**
   * The surface, as frames of points and quads between adjacent frames, ready for
   * the software renderer.
   *
   * Each ring is one station outline, so the mesh and the hydrostatics read the
   * same outline() function and cannot disagree the way two independent
   * representations can.
   */
  build() {
    const n = this.stationCount;
    const ring = this.outline(0.5).length;
    const points = [];
    for (let i = 0; i < n; i += 1) {
      const u = i / (n - 1);
      const y = this.stationY(i);
      for (const p of this.outline(u)) points.push({ x: p.x, y, z: p.z });
    }
    const quads = [];
    for (let i = 0; i < n - 1; i += 1) {
      const a = i * ring;
      const b = (i + 1) * ring;
      for (let s = 0; s < ring; s += 1) {
        const s2 = (s + 1) % ring;
        quads.push([a + s, a + s2, b + s2, b + s]);
      }
    }
    return { points, quads, ring };
  }
}


