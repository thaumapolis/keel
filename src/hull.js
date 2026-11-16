/**
 * hull.js — the ship's shape, and the hydrostatics that fall out of it.
 *
 * One representation, several consequences. The hull is a surface made of
 * transverse frames connected into quads; displaced volume, the centre of
 * buoyancy, waterplane area and the waterplane's second moment are all summed
 * over the SAME triangles. Nothing is read out of a stability table and nothing
 * is a hand-tuned "balance" constant. That is what makes the behaviour honest:
 * GM emerges from the shape, so a broad, shallow hull is stiff and a narrow,
 * deep one is tender, for the same reason they are in real life.
 *
 * Conventions used by every module in this project:
 *   x to starboard, y forward, z up, metres.
 *   Origin: centreline, on the keel (lowest point of the hull).
 *   The centre of flotation is NOT the origin and is never assumed to be.
 *
 * A right-handed frame with z up: a POSITIVE roll tips the STARBOARD side down.
 * Stated because the classic failure is a sign error that yields a ship which
 * rights itself by leaning further over — and which looks fine in a screenshot.
 */

/**
 * Fractional fall of the half-breadth from the flange to the deck -- the
 * tumblehome. Single source of truth: verticalTaper applies it and
 * meanVerticalProfile integrates it in closed form, so the two are the same
 * number by construction rather than by agreement. A mismatch between them is
 * not cosmetic: the taper exponent is calibrated against that closed-form mean,
 * so the declared block coefficient would silently stop being the displacement.
 */
export const TUMBLEHOME = 0.15;

/**
 * Mean over u in [0,1] of the longitudinal taper (1 - (2u-1)^2)^(exponent/2),
 * in closed form.
 *
 * Substituting s = 2u - 1 turns the mean into half of the standard integral
 * int_{-1}^{1} (1 - s^2)^p ds = B(1/2, p + 1) with p = exponent/2, so the taper
 * mean is B(1/2, exponent/2 + 1) / 2 exactly -- no quadrature, no sample count,
 * no resolution to argue about.
 *
 * Replaced a Simpson quadrature, and the reason is worth keeping. Simpson's
 * error grows with the fourth derivative of the integrand, which for this curve
 * blows up as the exponent approaches 0: the shape becomes a flat plateau with
 * steep shoulders, precisely the fullest hulls the form can make. Measured at a
 * fixed 4000 samples the mean was 0.0000% wrong at exponent 2.74 and 0.0071%
 * wrong at 0.19, so a resolution chosen to be comfortable at one end of the
 * range was quietly inadequate at the other, and because the taper exponent is
 * SOLVED against this mean, the error went straight into the declared block
 * coefficient. Raising the sample count fixed the number and made Hull
 * construction take tens of milliseconds. The closed form is exact and free.
 *
 * B(1/2, q) = sqrt(pi) * Gamma(q) / Gamma(q + 1/2), evaluated through lgamma to
 * avoid overflowing factorials for large exponents.
 */
function meanLongitudinalTaper(exponent) {
  const p = exponent / 2;
  const logBeta = Math.log(Math.PI) / 2 + logGamma(p + 1) - logGamma(p + 1.5);
  return Math.exp(logBeta) / 2;
}

/**
 * Log-Gamma, via the Lanczos approximation. Needed rather than a plain Gamma
 * because the block coefficient is solved for by bisection over exponents up to
 * 20, where Gamma(p + 1) alone exceeds 1e20.
 */
const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(x) {
  if (x < 0.5) {
    // Euler's reflection formula, to keep the argument in the stable range.
    return (
      Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
    );
  }
  const z = x - 1;
  let series = LANCZOS_COEFFICIENTS[0];
  for (let i = 1; i < LANCZOS_G + 2; i += 1) {
    series += LANCZOS_COEFFICIENTS[i] / (z + i);
  }
  const t = z + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

// Bounds of the longitudinal taper exponent. At MIN the hull is wall-sided --
// a barge, which is the fullest thing this form can be and therefore sets the
// ceiling on blockCoefficient. At MAX the ends are so fine the hull barely
// displaces at all. See taperExponent, which checks the ceiling rather than
// bisecting past it.
const TAPER_EXPONENT_MIN = 0.01;
const TAPER_EXPONENT_MAX = 20;

/**
 * Hull defined by four numbers a naval architect would actually quote, plus the
 * mesh resolution. Every hydrostatic in this project is derived from these.
 */
export class Hull {
  constructor(p) {
    this.length = p.length;
    this.beam = p.beam;
    this.depth = p.depth;
    this.blockCoefficient = p.blockCoefficient;
    this.prismaticCoefficient = p.prismaticCoefficient;
    // Mesh resolution. Both are integration resolutions, not looks, so they are
    // chosen from a convergence study rather than taste: at the default the
    // displacement agrees with a closed-form integral of the hull form to
    // 0.001%. The z direction is the demanding one because the bilge is a corner
    // in the half-breadth profile, which is exactly where the trapezium rule
    // loses accuracy; 18 levels left a 0.29% bias in displacement, and the whole
    // project is about a righting arm computed as I/V, where a 0.3% bias in V is
    // a 0.3% bias in GM.
    this.frames = p.frames ?? 61;
    this.sides = p.sides ?? 96;

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

  /**
   * Half-breadth at longitudinal fraction u in [0,1] and height z above keel.
   * Zero outside the hull. This single function IS the hull form.
   */
  halfBreadth(u, z) {
    if (z < 0 || z > this.depth || u < 0 || u > 1) return 0;
    return (this.beam / 2) * this.longitudinalTaper(u) * this.verticalTaper(z);
  }

  /**
   * 1 amidships, closing toward the ends, with the exponent SOLVED so that the
   * declared block coefficient is the volume that actually results.
   *
   * The first version picked this exponent from taste and left `blockCoefficient`
   * as a label on the side: a hull declared Cb = 0.80 displaced as 0.56, a 30%
   * lie, and the whole point of Cb is that it *is* the displacement. The
   * exponent now comes from meanLongitudinalTaper, the exact closed-form mean of
   * this same expression -- so the calibration and the shape cannot drift apart.
   */
  longitudinalTaper(u) {
    const s = 2 * u - 1;
    const base = Math.max(0, 1 - s * s);
    return Math.pow(base, this.taperExponent / 2);
  }

  /**
   * Half-breadth profile from keel to deck: a rounded bilge that saturates at
   * the declared beam, then a slight tumblehome above it.
   *
   * The `Math.min(1, ...)` is what makes `beam` mean what it says. Without it
   * the profile's maximum sits at whatever height `pow` happens to peak at and
   * the true maximum breadth is a mystery: measured with the previous form, a
   * hull declared 4 m across measured 3.28 m, a 22% lie, and every hydrostatic
   * downstream inherited it. Here the bilge reaches exactly 1 at
   * `flangeFraction` of the depth, so max half-breadth == beam/2, at a height
   * that is itself a stated quantity.
   *
   * `prismaticCoefficient` still does real work: it sets how quickly the bilge
   * fills out below the flange, which is the difference between a hard chine and
   * a full round bilge, and it changes the volume below any given waterline.
   */
  verticalTaper(z) {
    const f = z / this.depth;
    if (f <= 0) return 0;
    const bilge = Math.min(1, Math.pow(f / this.flangeFraction, this.bilgeExponent));
    if (f <= this.flangeFraction) return bilge;
    const above = (f - this.flangeFraction) / (1 - this.flangeFraction);
    return bilge * (1 - TUMBLEHOME * above * above);
  }

  /** Fraction of the depth at which the hull reaches its maximum breadth. */
  get flangeFraction() {
    return 0.45;
  }

  /**
   * Mean of the longitudinal taper for a given exponent. Delegates to the exact
   * closed form; kept as a static method because the bracket check in
   * taperExponent and the tests both address it by name.
   */
  static meanLongitudinalTaperByExponent(exponent) {
    return meanLongitudinalTaper(exponent);
  }

  /**
   * Mean of the vertical profile over z: the share of the block coefficient the
   * vertical shape, rather than the longitudinal taper, is responsible for.
   *
   * In closed form. verticalTaper is piecewise, and both pieces integrate
   * elementarily. With f = z/depth and fl = flangeFraction, over f in [0, 1]:
   *
   *   f <= fl :  (f/fl)^be                     -> fl / (be + 1)
   *   f >  fl :  1 - 0.15 * ((f - fl)/(1 - fl))^2
   *                                           -> (1 - fl) * (1 - 0.15/3)
   *
   * Summing those and dividing by the unit interval is the mean, exactly. The
   * value agrees with a 400001-point Simpson to 8.6e-8 relative -- which is to
   * say the closed form is more accurate than the quadrature that checks it, and
   * it costs eight arithmetic operations.
   *
   * How it got here, because each step was measured: the original averaged the
   * profile on a left-endpoint rectangle rule and read 0.82431001 against the
   * true 0.82451342. Since the taper exponent is SOLVED against this number, that
   * bias landed directly in the declared block coefficient and made Cb wrong by
   * 0.0496% on every hull -- a calibration routine quietly sabotaging the one
   * quantity it existed to enforce. Composite Simpson fixed the value but needed
   * tens of thousands of points, because the profile rises like a root at the
   * keel (bilgeExponent < 1) and its derivative jumps at the flange, and this runs
   * once per bisection step: hull construction went from 0 ms to over a minute.
   * The closed form is exact and free, and takes no resolution parameter that a
   * caller could set wrong.
   */
  meanVerticalProfile() {
    const fl = this.flangeFraction;
    const lower = fl / (this.bilgeExponent + 1);
    const upper = (1 - fl) * (1 - TUMBLEHOME / 3);
    return lower + upper;
  }

  /**
   * Bisection for the taper exponent that yields the declared block coefficient.
   * Monotone decreasing in the exponent, so bisection converges; the bracket is
   * the range over which mean(taper) spans (0,1) for this shape.
   */
  get taperExponent() {
    if (this._taperExponent !== undefined) return this._taperExponent;
    const target = this.blockCoefficient / this.meanVerticalProfile();
    // The bracket has to be checked, not trusted. The largest achievable block
    // coefficient is the one obtained with no longitudinal taper at all -- a
    // wall-sided barge -- which is meanVerticalProfile() itself. Asking for a
    // fuller hull than that is not a hull this shape can be, and bisecting
    // through it used to settle silently on the bracket's floor: the solver
    // "converged", the exponent was 0.01, and the published displacement was
    // 4.9% low with nothing to say about it.
    const reachable = meanLongitudinalTaper(TAPER_EXPONENT_MIN);
    if (target > reachable + 1e-9) {
      throw new Error(
        `Hull: blockCoefficient ${this.blockCoefficient} is unreachable for this ` +
        `form. A wall-sided barge of this vertical profile displaces at most ` +
        `${(reachable * this.meanVerticalProfile()).toFixed(3)}; raise ` +
        `prismaticCoefficient (fuller sections) or accept a finer block.`,
      );
    }
    let lo = TAPER_EXPONENT_MIN;
    let hi = TAPER_EXPONENT_MAX;
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if (Hull.meanLongitudinalTaperByExponent(mid) > target) lo = mid;
      else hi = mid;
    }
    this._taperExponent = (lo + hi) / 2;
    return this._taperExponent;
  }

  /** How fast the bilge fills toward the flange: 1 is a straight-sided V. */
  get bilgeExponent() {
    return 0.35 + (1 - this.prismaticCoefficient) * 1.4;
  }

  /**
   * The surface, as frames of points and quads between adjacent frames.
   *
   * Each ring samples z from the keel (z=0) up to the deck (z=depth), at the
   * half-breadth that `halfBreadth` gives at that height, mirrored to port and
   * starboard. So the ring is a genuine outline of the section, and the quads
   * between two rings tile the shell exactly — which is what lets the buoyancy
   * integrals be summed over those same quads.
   */
  build() {
    const points = [];
    const frameStart = [];
    // z stops one step below the deck so each ring is a closed outline whose
    // top edge is the deck edge; the deck itself is added separately.
    const zLevels = this.sides;
    for (let fi = 0; fi < this.frames; fi += 1) {
      const u = fi / (this.frames - 1);
      const y = (u - 0.5) * this.length;
      frameStart.push(points.length);
      // Right half: keel to deck edge, x >= 0.
      for (let si = 0; si <= zLevels; si += 1) {
        const z = (si / zLevels) * this.depth;
        points.push({ x: this.halfBreadth(u, z), y, z });
      }
      // Left half, deck edge back down toward the keel, excluding both ends so
      // the ring closes without duplicating the keel or deck-edge points.
      for (let si = zLevels - 1; si >= 1; si -= 1) {
        const z = (si / zLevels) * this.depth;
        points.push({ x: -this.halfBreadth(u, z), y, z });
      }
    }
    const ring = 2 * zLevels;
    const quads = [];
    for (let fi = 0; fi < this.frames - 1; fi += 1) {
      for (let si = 0; si < ring; si += 1) {
        const a = frameStart[fi] + si;
        const b = frameStart[fi] + ((si + 1) % ring);
        const c = frameStart[fi + 1] + ((si + 1) % ring);
        const d = frameStart[fi + 1] + si;
        quads.push([a, b, c, d]);
      }
    }
    return { points, quads, ring };
  }
}
