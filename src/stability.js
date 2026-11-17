/**
 * stability.js -- whether the ship comes back, and how.
 *
 * The righting arm GZ is the horizontal distance between the centre of buoyancy
 * and the centre of gravity once the ship is heeled; righting moment is
 * displacement * GZ. That one curve -- GZ against heel -- is what sailors actually
 * judge a boat by, and everything here follows from computing it from the heeled
 * shape:
 *
 *   GZ = KB*sin + BM*sin*cos^2 ... only for small angles on a wall-sided hull.
 *
 * Even the wall-sided form is a claim about a regime. Measured against exact
 * section geometry on a wall-sided barge, the BM term scales as sin/cos rather
 * than sin*cos^2: the two agree to 1e-6 at 1 deg, differ by 35% at 20 deg, and
 * have OPPOSITE signs by 45 deg. Past the angle where the deck edge dives the
 * waterplane changes shape completely, and a boat can develop a second hump that
 * holds it upside down. That is the behaviour worth showing, and it cannot come
 * from a formula -- it has to come from integrating the actual heeled shape.
 *
 * So this module is a thin layer over sections.js, which clips each transverse
 * section against the heeled waterline and takes area and centroid by shoelace.
 * Displacement is held constant by solving for the waterline at every angle, and
 * the solve runs at the same resolution as the evaluation, because volume's
 * sensitivity to the waterline is first order and the error would otherwise
 * survive refinement. See sections.js for the full reasoning and the cost.
 */

import { buildHeel, FloatFailure, floatState, heelAt, rightingArmAt } from "./sections.js";

export const DEG = Math.PI / 180;

/**
 * Did the sweep run off the end of what this hull can float at, as opposed to
 * hitting a real bug? sections.js returns null for that case rather than
 * throwing, so this only has to recognise the messages raised by the wrappers
 * that do throw -- matching on text keeps the two files honest about which
 * failure is which, instead of swallowing everything.
 */
function hitWillFloat(error) {
  // Matches the two messages that describe a genuine limit of what this hull can
  // do at this loading -- and deliberately NOT the NOTHING_TO_INTEGRATE message,
  // which describes a defect. A sweep that swallowed that one would report a
  // clean end-of-range where the code is actually broken.
  return /is not achievable|exceeds this/.test(error.message);
}

/**
 * Displacement in tonnes, from volume in cubic metres of seawater.
 * 1.025 t/m3 is the conventional figure; stated as a named constant with its
 * unit rather than folded into a formula so it is visible and correctable.
 */
export const SEAWATER_TONNES_PER_CUBIC_METRE = 1.025;

/**
 * Upright displacement, and the numbers a spec sheet quotes.
 *
 * This is the one hydrostatic that has a cheap closed form in reach, so it is
 * worth having separately: the animation needs it once per hull, and the
 * constant-displacement solves below are all anchored to it.
 */
export function uprightState(hull, options) {
  // Upright at the deck: angle 0, waterline at the top of the hull. No waterline
  // bisection is needed because the waterline is already known -- at angle 0 it
  // is centreline-flat, and full depth is by definition the whole hull -- so this
  // is one quadrature evaluation rather than sixty.
  //
  // This function used to call polygonHydrostatics, which sections.js never
  // exported: the import threw at module load, so stability.js could not be
  // imported AT ALL, by anything. It sat undetected across three commits because
  // no test imported it -- the suite exercised hull.js and sections.js directly
  // and never went through the layer that composes them. Hence the import check
  // now added in tests/stability.test.mjs: a module that cannot load is the
  // cheapest possible failure and the most expensive one to leave in.
  const state = heelAt(buildHeel(hull, 0, options), hull.depth);
  if (!state) throw new Error("uprightState: hull floats with zero volume at full depth");
  return state;
}

/**
 * The floating state at a heel angle: centreline waterline and hydrostatics.
 * Exposed because the renderer needs the same numbers the physics used -- a ship
 * drawn at a different waterline from the one its own stability was computed at
 * is the difference between a simulation and an illustration.
 */
export function floatStateAt(hull, angleRad, displacementVolume, options) {
  const state = floatState(hull, angleRad, displacementVolume, options);
  if (state.failure !== undefined) {
    const deg = (angleRad * 180 / Math.PI).toFixed(1);
    if (state.failure === FloatFailure.NOTHING_TO_INTEGRATE) {
      // A bug in the caller or the heel data, not a fact about the sea state:
      // there was no column at all to integrate. Raise loudly rather than
      // reporting a limit, because a limit would be a lie about the ship.
      throw new Error(
        `floatStateAt: no hull geometry to integrate at ${deg} deg.`,
      );
    }
    if (state.failure === FloatFailure.TOO_FULL) {
      throw new Error(
        `floatStateAt: displacement ${displacementVolume.toFixed(3)} m3 exceeds this ` +
        `hull's whole volume of ${state.maxVolume.toFixed(3)} m3, so it does not float ` +
        `at any angle.`,
      );
    }
    throw new Error(
      `floatStateAt: displacement ${displacementVolume.toFixed(3)} m3 is not achievable ` +
      `at ${deg} deg for this hull (best ${state.maxVolume.toFixed(3)} m3).`,
    );
  }
  return state;
}

/**
 * Righting arm GZ at one heel angle, for a centre of gravity at (0, KG).
 *
 * Returns the arm in metres alongside the displacement it belongs to. Null means
 * the hull cannot float that way at all -- no waterline reaches the required
 * displacement -- which the caller must show as "gone over" rather than coerce to
 * zero, because zero is also the reading for an upright ship and the two feel
 * nothing alike.
 */
export function rightingArm(hull, angleRad, KG, displacementVolume, options) {
  const hit = rightingArmAt(hull, angleRad, KG, displacementVolume, options);
  if (hit === null) return null;
  if (hit.failure !== undefined) return hit;
  return {
    gz: hit.gz,
    heelRad: angleRad,
    waterline: hit.waterline,
    displacementTonnes: hit.volume * SEAWATER_TONNES_PER_CUBIC_METRE,
    buoyancy: hit.body,
  };
}

/**
 * The GZ curve, sampled over heel angle.
 *
 * Reported in degrees because that is the unit people think in, and returned as
 * explicit {angleDeg, gz} pairs rather than a bare array so a caller cannot
 * silently assume a step size.
 *
 * The curve stops at the first angle that will not float, and `vanishedAt`
 * records where: that angle is itself a headline number about a hull, and a
 * truncated list is easier to misuse than a list with a stated end.
 *
 * "Will not float" arrives as a throw from the waterline solve, which is the
 * right thing for a caller that asked for a specific angle -- and the wrong thing
 * mid-sweep, where hitting the limit IS the answer. So the sweep catches it and
 * records it; a caller asking for one angle still sees the exception.
 */
export function gzCurve(hull, KG, displacementVolume, { stepDeg = 2, maxDeg = 180, ...options } = {}) {
  const samples = [];
  let vanishedAt = null;
  for (let deg = 0; deg <= maxDeg + 1e-9; deg += stepDeg) {
    let hit;
    try {
      hit = rightingArm(hull, deg * DEG, KG, displacementVolume, options);
    } catch (error) {
      if (!hitWillFloat(error)) throw error;
      vanishedAt = deg;
      break;
    }
    if (hit === null || hit.failure !== undefined) {
      vanishedAt = deg;
      break;
    }
    samples.push({ angleDeg: deg, gz: hit.gz });
  }
  return { samples, vanishedAt };
}

/**
 * The three numbers a stability summary is made of, read off the curve.
 *
 *   initial GM      slope of GZ at 0 -- the stiffness people quote
 *   maxGz / atDeg   how strong the righting is, and how far you can push
 *   vanishingDeg    where righting is finally lost: past this, the ship stays over
 *
 * GM here is measured as the small-angle SLOPE of the honest curve rather than
 * taken from KB + BM - KG, so it cannot disagree with the curve it summarises.
 * The two independent methods agree to 0.65% on the validation hull, and that
 * residual is this integration's chord error, not a modelling difference.
 */
export function stabilitySummary(hull, KG, displacementVolume, options) {
  const curve = gzCurve(hull, KG, displacementVolume, { stepDeg: 2, maxDeg: 180, ...options });
  if (curve.samples.length < 2) {
    throw new Error("stabilitySummary: hull does not float upright");
  }
  // Slope at the origin from the first two samples. Both are small angles, and
  // GZ(0) is 0 to within quadrature noise, so the secant is the slope to the
  // accuracy of the curve itself.
  const [first, second] = curve.samples;
  const initialGM = (second.gz - first.gz) / Math.sin(second.angleDeg * DEG) || 0;
  let peak = curve.samples[0];
  for (const sample of curve.samples) {
    if (sample.gz > peak.gz) peak = sample;
  }
  let vanishingDeg = null;
  for (let i = 1; i < curve.samples.length; i += 1) {
    if (curve.samples[i].gz <= 0) {
      // Linear interpolation between the last positive and first non-positive
      // sample: the zero crossing is the number, and a 2 deg grid would otherwise
      // report it quantised by 2 deg.
      const a = curve.samples[i - 1];
      const b = curve.samples[i];
      vanishingDeg = a.angleDeg + (b.angleDeg - a.angleDeg) * (a.gz / (a.gz - b.gz));
      break;
    }
  }
  return {
    initialGM,
    maxGz: peak.gz,
    maxGzAtDeg: peak.angleDeg,
    vanishingDeg,
    cannotFloatBeyondDeg: curve.vanishedAt,
  };
}
