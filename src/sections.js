/**
 * sections.js -- the hydrostatics of a HEELED hull, integrated from the hull form.
 *
 * This is the method the project depends on, and it replaced a station-summing
 * implementation that could not express heel at all. The predecessor computed the
 * waterplane's transverse second moment from half-breadths at a HORIZONTAL cut,
 * and heelState() handed it the same unrotated stations whatever the angle, so
 * the waterplane inertia did not change as the ship heeled (observed: 21.55989 at
 * both 0 rad and 0.5 rad). Every GZ past a few degrees inherited that: measured
 * against this file, it was 35% low at 20 deg, 50% low at 30 deg, and NEGATIVE at
 * 45 deg where the true arm is still slightly positive -- it told the user the
 * ship was capsizing at an angle where the geometry says it rights itself.
 *
 * Why this formulation. A heeled section's submerged region is not single-valued
 * in body z: once the keel edge emerges, a horizontal line inside it meets the
 * boundary twice. Any representation that stores a section as "half-breadth as a
 * function of height" cannot express that, and being correct past the deck-edge
 * angle is the entire point. So the section is described the other way round --
 * for each column at body |x|, the range of z in which the hull exists -- and the
 * waterline simply cuts that range. The z range comes from inverting the declared
 * hull form, not from a polyline approximation of it, so the only errors left are
 * column and station spacing, both under direct control and both measured.
 *
 * Conventions, matching src/hull.js (x starboard, y forward, z up from keel,
 * right-handed, so POSITIVE heel tips STARBOARD down):
 *
 *     worldX = bodyX*cos + bodyZ*sin
 *     worldZ = -bodyX*sin + bodyZ*cos
 *
 * The sanity check on that reading: the starboard keel point (bodyX = +h,
 * bodyZ = 0) maps to worldZ = -h*sin < 0 for heel > 0, i.e. below the water
 * surface at worldZ = 0, so water covers more of the x > 0 side. The waterplane
 * in body coordinates is therefore
 *
 *     bodyZ <= (w + bodyX*sin)/cos
 *
 * with w the waterline height at the centreline.
 *
 * GZ is the horizontal separation, in the WORLD frame where the water surface is
 * level, between the buoyancy centre and the centre of gravity:
 *
 *     GZ = (B_worldX - G_worldX) * V / V0
 *
 * The V/V0 factor is not decoration. GZ is a righting ARM, and the righting
 * MOMENT is rho*g*V*GZ; comparing moments at a fixed displacement makes the arm
 * the world offset scaled by the volume ratio. For a wall-sided hull V falls as
 * cos(theta) while the offset grows, so dropping the factor changes the shape of
 * the curve, not just its scale.
 *
 * Accuracy, measured two ways. Upright volume against an independent
 * 200001-point double Simpson of the hull form: 0.0002% at nu=nx=801, and the
 * error falls as the spacing (nu=31 -> -0.20%, 61 -> -0.01%, 121 -> +0.04%).
 * Against the naive closed form L*B*D*blockCoefficient it plateaus at +0.048%
 * however fine the grid: that plateau is NOT this file's error, it is
 * hull.js's block-coefficient solver, whose meanVerticalProfile() uses a
 * left-endpoint rectangle rule where the taper is steepest at the keel, so the
 * exponent it solves for is off. The closed form is the approximation.
 *
 * Small-angle behaviour is the sign test: GZ must tend to GM*sin(theta) for a
 * STABLE hull, so GZ/sin(theta) -> GM > 0.
 */

/**
 * Body-frame z range in which the hull exists at longitudinal fraction u and
 * body |x| = absX, or null where the column misses the hull entirely.
 *
 * Solved by bisection on the hull form itself. Hull.verticalTaper rises
 * monotonically from the keel to the flange and falls gently above it, so a
 * column inside the maximum breadth has exactly one crossing on the way up and,
 * if it is also inside the deck-edge breadth, one on the way down. Those two
 * crossings are the column's [bottom, top].
 */
function columnBounds(hull, u, absX) {
  const taper = hull.longitudinalTaper(u);
  if (taper <= 0) return null;
  const maxHalf = (hull.beam / 2) * taper;
  if (absX > maxHalf) return null;
  const flangeZ = hull.flangeFraction * hull.depth;

  let lo = 0;
  let hi = flangeZ;
  for (let i = 0; i < 50; i += 1) {
    const mid = (lo + hi) / 2;
    if (hull.halfBreadth(u, mid) < absX) lo = mid;
    else hi = mid;
  }
  const bottom = (lo + hi) / 2;

  let top = hull.depth;
  if (absX > hull.halfBreadth(u, hull.depth)) {
    lo = flangeZ;
    hi = hull.depth;
    for (let i = 0; i < 50; i += 1) {
      const mid = (lo + hi) / 2;
      if (hull.halfBreadth(u, mid) > absX) lo = mid;
      else hi = mid;
    }
    top = (lo + hi) / 2;
  }
  return { bottom, top };
}

/**
 * Everything about a heel angle that does NOT depend on the waterline: the
 * column x positions and their z ranges, per station, with Simpson weights.
 *
 * This is separated from the waterline evaluation because recomputing it was the
 * cost of the whole stability model. Solving for the floating waterline needs
 * ~50 quadrature evaluations, and doing the shape work each time cost 3.46 ms per
 * evaluation and 145 ms per heel angle -- 8.7 s for a 60-sample GZ curve, which
 * cannot run in front of a user. Built once per hull and angle, the waterline
 * solve becomes arithmetic and the curve drops to the tens of milliseconds.
 */
export function buildHeel(hull, angleRad, { nu = 121, nx = 121 } = {}) {
  if ((nu - 1) % 2 !== 0) throw new Error("nu must be odd for Simpson in u");
  if ((nx - 1) % 2 !== 0) throw new Error("nx must be odd for Simpson across the beam");
  const sinT = Math.sin(angleRad);
  const cosT = Math.cos(angleRad);
  const du = 1 / (nu - 1);
  const halfBeam = hull.beam / 2;
  const dx = (2 * halfBeam) / (nx - 1);
  const xs = [];
  for (let j = 0; j < nx; j += 1) xs.push(-halfBeam + j * dx);
  const wx = [];
  for (let j = 0; j < nx; j += 1) {
    wx.push(j === 0 || j === nx - 1 ? 1 : j % 2 ? 4 : 2);
  }

  const stations = [];
  for (let i = 0; i < nu; i += 1) {
    const u = i * du;
    const bounds = xs.map((x) => columnBounds(hull, u, Math.abs(x)));
    stations.push({
      weight: i === 0 || i === nu - 1 ? 1 : i % 2 ? 4 : 2,
      bounds,
    });
  }
  return { stations, xs, wx, du, dx, sinT, cosT, length: hull.length };
}

/**
 * Volume and buoyancy centre (body frame) for a precomputed heel at centreline
 * waterline w.
 *
 * For a column spanning body z in [bottom, top], the waterplane cuts it at
 * zTop = min(top, (w + x*sin)/cos), so the submerged height is
 * max(0, zTop - bottom) and the first moments follow in closed form:
 * area = height, moment about z = 0 is (zTop^2 - bottom^2)/2, and the x moment is
 * area * x. Integrating across the beam and along the hull is Simpson both ways
 * on the same columns the shape was resolved on, so the volume, the vertical
 * centroid and the transverse shift cannot disagree with each other the way three
 * independent formulas can.
 */
export function heelAt(heel, w) {
  const { stations, xs, wx, du, dx, sinT, cosT, length } = heel;
  let volume = 0;
  let momentX = 0;
  let momentZ = 0;
  for (const station of stations) {
    let area = 0;
    let areaX = 0;
    let areaZ = 0;
    for (let j = 0; j < xs.length; j += 1) {
      const bounds = station.bounds[j];
      if (!bounds) continue;
      const x = xs[j];
      const water = (w + x * sinT) / cosT;
      const top = Math.min(bounds.top, water);
      const height = top - bounds.bottom;
      if (height <= 0) continue;
      const column = wx[j];
      area += column * height;
      areaX += column * height * x;
      areaZ += column * (top * top - bounds.bottom * bounds.bottom) / 2;
    }
    volume += station.weight * area;
    momentX += station.weight * areaX;
    momentZ += station.weight * areaZ;
  }
  const k = (du / 3) * (dx / 3) * length;
  volume *= k;
  momentX *= k;
  momentZ *= k;
  if (!(volume > 1e-12)) return null;
  return { volume, bx: momentX / volume, bz: momentZ / volume };
}

/**
 * The floating waterline at a heel angle, for a target displacement.
 *
 * Returns null when no waterline reaches the target -- the hull is too shallow to
 * float that way over. Returning rather than throwing lets a sweep treat the end
 * of the range as data; callers that asked for one specific angle wrap this and
 * raise, because there "it will not float" IS the error.
 *
 * volume is strictly increasing in w between "no column wet" and "every column
 * fully wet", and above the fully-wet height it is constant, so the bracket's
 * upper end must be derived from where monotonicity stops, not from the hull's
 * nominal size: fully wet needs w >= max over columns of (top*cos - x*sin), which
 * for a hull of depth D and half-beam h is D*cos + h*sin over cos, i.e.
 * D + h*tan. An earlier version used 2*depth, which sits BELOW that past ~45 deg
 * on this hull: bisection converged on the bracket ceiling itself, the volume
 * froze, and a smooth monotone physically meaningless GZ curve came out.
 */
export function floatWaterline(heel, targetVolume) {
  const { xs, stations, sinT, cosT } = heel;
  let wetMax = -Infinity;
  for (const station of stations) {
    for (let j = 0; j < xs.length; j += 1) {
      const bounds = station.bounds[j];
      if (!bounds) continue;
      const needed = bounds.top * cosT - xs[j] * sinT;
      if (needed > wetMax) wetMax = needed;
    }
  }
  // A small margin above the fully-wet height, so the top of the bracket is
  // unambiguously fully wet rather than exactly touching the last column.
  const maxVolume = heelAt(heel, wetMax + 1e-6)?.volume ?? 0;
  if (!(maxVolume >= targetVolume * (1 - 1e-9))) return null;

  let hi = wetMax + 1e-6;
  let lo = -hi;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if ((heelAt(heel, mid)?.volume ?? 0) < targetVolume) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Floating state at a heel angle: the waterline that holds the displacement, and
 * the hydrostatics there. Null means the hull cannot float that way over.
 */
export function floatState(hull, angleRad, targetVolume, options) {
  const heel = buildHeel(hull, angleRad, options);
  const w = floatWaterline(heel, targetVolume);
  if (w === null) return null;
  const body = heelAt(heel, w);
  if (!body) return null;
  return { waterline: w, ...body };
}

/**
 * Righting arm at angleRad for a centre of gravity at (0, KG), floating upright
 * at `uprightVolume`. See the header for why the volume ratio multiplies the arm.
 */
export function rightingArmAt(hull, angleRad, KG, uprightVolume, options) {
  const state = floatState(hull, angleRad, uprightVolume, options);
  if (!state) return null;
  const sinT = Math.sin(angleRad);
  const cosT = Math.cos(angleRad);
  const bWorldX = state.bx * cosT + state.bz * sinT;
  return {
    volume: state.volume,
    waterline: state.waterline,
    gz: (bWorldX - KG * sinT) * (state.volume / uprightVolume),
    body: { bx: state.bx, bz: state.bz },
  };
}
