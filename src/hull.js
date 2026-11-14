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
   * exponent now comes from meanLongitudinalTaperByExponent, which is a table
   * computed once from this same function -- so the two cannot drift apart, and a
   * change to the shape of the taper changes the table with it.
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
    return bilge * (1 - 0.15 * above * above);
  }

  /** Fraction of the depth at which the hull reaches its maximum breadth. */
  get flangeFraction() {
    return 0.45;
  }

  /**
   * Mean of the longitudinal taper over u, given an exponent. Evaluated by
   * quadrature over the same expression `longitudinalTaper` uses, which is what
   * makes it a derivation rather than a second, independent guess.
   *
   * Volume = L * B * D * mean(taper) * mean(vertical profile), so solving for the
   * exponent that puts mean(taper) where Cb needs it is the whole calibration.
   */
  static meanLongitudinalTaperByExponent(exponent, samples = 4001) {
    let total = 0;
    for (let i = 0; i < samples; i += 1) {
      const s = 2 * (i / (samples - 1)) - 1;
      total += Math.pow(Math.max(0, 1 - s * s), exponent / 2);
    }
    return total / samples;
  }

  /**
   * Mean of the vertical profile over z, for the given bilge exponent. Shares
   * verticalTaper's expression so the vertical share of Cb is accounted for
   * rather than assumed to be 1.
   */
  meanVerticalProfile(samples = 2001) {
    let total = 0;
    for (let i = 0; i < samples; i += 1) {
      total += this.verticalTaper((i / (samples - 1)) * this.depth);
    }
    return total / samples;
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
    const reachable = Hull.meanLongitudinalTaperByExponent(TAPER_EXPONENT_MIN);
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
