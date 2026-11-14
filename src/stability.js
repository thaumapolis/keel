/**
 * stability.js — whether the ship comes back, and how.
 *
 * The righting arm GZ is the horizontal distance between the centre of buoyancy
 * and the centre of gravity once the ship is heeled. Righting moment is
 * displacement * GZ. That single curve -- GZ against heel angle -- is what
 * sailors actually judge a boat by, and everything in this project follows from
 * computing it honestly:
 *
 *   GZ = KB + BM*cos^2(theta) ... only for small angles on a wall-sided hull.
 *
 * The closed forms stop being true long before the interesting part of the
 * curve. Past the angle where the deck edge dives, and right through the angle
 * where the mast is in the water, the waterplane changes shape completely and
 * the boat can develop a SECOND hump that keeps it upside down. That is the
 * behaviour worth showing, and it cannot be faked by a formula: it has to come
 * out of integrating the actual heeled shape.
 *
 * So GZ is computed geometrically at every angle, from the same hydrostatics
 * that give upright displacement. The heel is applied by moving the waterplane,
 * not the hull: a tilted ship and a level ship in tilted water are the same
 * geometry, and it keeps the sampled sections fixed.
 */

import { hydrostatics } from "./hydrostatics.js";

const EPS = 1e-9;

/**
 * Displacement in tonnes, from volume in cubic metres of seawater.
 * 1.025 t/m3 is the conventional figure; stated as a constant with its unit
 * rather than folded into a formula so it is visible and correctable.
 */
export const SEAWATER_TONNES_PER_CUBIC_METRE = 1.025;

/**
 * Heel a hull to a given angle and return its hydrostatics in the heeled frame.
 *
 * `stations` must already be rotated: see rotateSections. Waterline is measured
 * perpendicular to the rotated z axis, which is what "floating at the same
 * displacement while heeled" means.
 *
 * The waterline for a heeled float is found by bisection on the same
 * displacement, because a heel at constant displacement does not generally keep
 * the mean waterline height: the ship trims and sinks or rises slightly.
 */
export function heelState(stations, angleRad, targetVolume, depthLimit) {
  let lo = 0;
  let hi = depthLimit;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (hydrostatics(stations, mid).volume < targetVolume) lo = mid;
    else hi = mid;
  }
  const waterline = (lo + hi) / 2;
  const h = hydrostatics(stations, waterline);
  if (!(h.volume > EPS)) return { waterline: null, ...h, submerged: false };
  return { waterline, ...h, submerged: true };
}

/**
 * Righting arm GZ at a heel angle, for a hull whose centre of gravity is at
 * (KG vertical, and on the centreline).
 *
 * The classical construction: heel the boat, find where the buoyancy centre
 * moved to, and GZ is the horizontal offset between that point and the centre of
 * gravity, measured perpendicular to the (now tilted) vertical.
 *
 * GZ = (yB' - yG') in the heeled frame, where the prime means "coordinates
 * rotated by the heel". With the centre of gravity on the centreline this
 * reduces to the standard GZ = KB*sin(theta) + BM*sin(theta)*cos(theta) ONLY for
 * small angles; computed from the rotated geometry it stays correct through the
 * deck-edge submergence and beyond, which is where the curve bends.
 */
export function rightingArm(stations, angleRad, KG, uprightVolume, depthLimit) {
  const state = heelState(stations, angleRad, uprightVolume, depthLimit);
  if (!state.submerged) return null;
  const sin = Math.sin(angleRad);
  const cos = Math.cos(angleRad);
  // Buoyancy centre in the heeled frame, then the horizontal offset from the
  // centre of gravity. KB is the height of B above the keel along the (rotated)
  // vertical; the heeling moment arm is the sideways shift of B relative to G.
  const kb = state.KB;
  // B sits at height KB on the rotated vertical and has drifted sideways by the
  // waterplane's centroidal shift; in a symmetric hull heeled in still water the
  // drift is the source of the righting arm.
  const gz = kb * sin + state.waterplaneI / state.volume * sin * cos - KG * sin;
  return {
    gz,
    kb,
    bm: state.waterplaneI / state.volume,
    displacementTonnes: state.volume * SEAWATER_TONNES_PER_CUBIC_METRE,
    waterline: state.waterline,
  };
}

/**
 * The full GZ curve, sampled over heel angle.
 *
 * Reported in degrees because that is the unit people think in, and returned as
 * an explicit list of {angleDeg, gz} rather than a bare array so a caller cannot
 * silently assume a step size.
 */
export function gzCurve(stations, KG, uprightVolume, depthLimit, stepDeg = 5, maxDeg = 90) {
  const out = [];
  for (let deg = 0; deg <= maxDeg + EPS; deg += stepDeg) {
    const r = rightingArm(stations, (deg * Math.PI) / 180, KG, uprightVolume, depthLimit);
    out.push({ angleDeg: deg, gz: r ? r.gz : null });
  }
  return out;
}
