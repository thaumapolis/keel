/**
 * app.js -- the interactive layer: wire the physics and the 3D view to input.
 *
 * What the user does, in one line: set how full the ship is and how high its
 * weight sits, then roll it over and let go, and watch whether it comes back.
 * Everything on screen is the physics's own numbers; nothing is animated by
 * hand. The roll is a real second-order equation (righting moment + damping +
 * your drag), integrated in real time, so the motion you see IS the stability
 * the GZ curve describes.
 *
 * The layout is a single column: the 3D view up top (the mechanism), the live
 * readout and the GZ curve below it (the numbers), controls at the bottom where
 * a thumb reaches them on a phone. On a wide screen the 3D view and the curve
 * sit side by side. The controls are large and labelled in plain words because
 * the whole claim of the app is that you can understand this without knowing the
 * jargon -- so the jargon (GM, GZ, metacentre) is introduced only after the
 * thing has been seen moving.
 */

import { Hull } from "./hull.js";
import { buildHeel, heelAt, floatState, renderGeometry } from "./sections.js";
import { DEG, gzCurve, rightingArm, stabilitySummary } from "./stability.js";
import { camera, renderScene } from "./view3d.js";


/**
 * The simulation state the user drives. Kept in one object so the controls, the
 * physics, and the render all read one source of truth.
 */
export const state = {
  draftFrac: 0.55,      // how full: fraction of depth the keel sits below water upright
  kgFrac: 0.60,         // how high the weight is, as a fraction of the hull's critical KG
  heelDeg: 0,           // current roll
  heelVel: 0,           // roll rate, deg/s
  hull: null,
  volume: 0,            // displaced m^3, held constant as it rolls
  criticalKG: 1.0,
  KG: 1.0,
  summary: null,
  curve: null,
  dragging: false,
};

const HULL_SPEC = { length: 12, beam: 4, depth: 2.4, blockCoefficient: 0.62, prismaticCoefficient: 0.9 };

export function rebuildHydrostatics() {
  state.hull = new Hull(HULL_SPEC);
  const draft = state.draftFrac * state.hull.depth;
  const up = heelAt(buildHeel(state.hull, 0), draft);
  state.volume = up.volume;
  // Critical KG: the height at which the ship stops returning upright. Bisect on
  // the small-angle slope; the result is what kgFrac scales, so "how close to
  // capsizing" stays a meaningful, hull-independent dial.
  let lo = 0.3, hi = state.hull.depth * 1.2;
  const coarse = { stepDeg: 5, maxDeg: 20 };
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (stabilitySummary(state.hull, mid, state.volume, coarse).initialGM > 0) lo = mid;
    else hi = mid;
  }
  state.criticalKG = (lo + hi) / 2;
  state.KG = state.kgFrac * state.criticalKG;
  state.summary = stabilitySummary(state.hull, state.KG, state.volume);
  state.curve = gzCurve(state.hull, state.KG, state.volume, { stepDeg: 2, maxDeg: 90 });
}

/** A frame of everything the view and the readout need, at the current heel. */
export function currentFrame() {
  const a = state.heelDeg * DEG;
  const st = floatState(state.hull, a, state.volume);
  if (st.failure !== undefined || st === null) return null;
  const g = renderGeometry(state.hull, a, st.waterline, { nStations: 80 });
  // heelAt's worldCenter.z is measured from the keel, so the water surface sits at
  // z = waterline there; renderGeometry drops the ship so the water surface is at
  // z = 0. Markers must live in the SAME frame as the hull they sit on, so they get
  // the same -waterline offset. Getting this wrong once put B and G floating above
  // the deck; the offset is applied here, once, matching renderGeometry's toWorld.
  const bWorld = st.worldCenter;
  const waterAtZero = (z) => z - st.waterline;
  return {
    heelDeg: state.heelDeg,
    geometry: g,
    buoyancy: { x: bWorld.x, y: 0, z: waterAtZero(bWorld.z) },
    gravity: { x: state.KG * Math.sin(a), y: 0, z: waterAtZero(state.KG * Math.cos(a)) },
    gz: bWorld.x - state.KG * Math.sin(a),
    state: st,
  };
}

/**
 * Advance the roll by dt seconds under the righting moment, damping, and while
 * dragging, the user's imposed angle. The righting moment comes from the SAME
 * rightingArm the curve is built from, so the motion and the graph cannot
 * disagree -- if GZ is negative at this angle the ship is shown falling further
 * over, not secretly held up.
 *
 * Roll dynamics: I * theta'' = -displacement * GZ(theta) * g_water_proxy - c *
 * theta'. Using displacement*GZ as the righting moment (tonnes*m) and a lumped
 * inertia, the constants below set a roll period of a few seconds, which reads as
 * a ship rather than a metronome. Damping is real: a real ship's roll decays.
 */
const GRAV = 9.81;
export function step(dt) {
  if (state.dragging) return;   // user holds the angle; no dynamics while dragged
  const a = state.heelDeg * DEG;
  const hit = rightingArm(state.hull, a, state.KG, state.volume);
  if (hit === null || hit.failure !== undefined) {
    // Past the floatable limit: the ship is going over. Let it keep rolling with
    // the same sign it was moving rather than freezing at the last valid angle.
    state.heelVel += Math.sign(state.heelVel || 1) * 20 * dt;
  } else {
    // Restoring torque opposes GZ's sign scaled by displacement; a broad stiff
    // hull snaps back fast, a tender one sluggishly -- which is exactly GM.
    const inertia = state.volume * 40;     // lumped roll inertia, kg*m^2-ish scale
    const torque = -hit.gz * state.volume * GRAV * 1.025;  // tonnes*m -> ~N*m
    const damping = -state.heelVel * inertia * 0.6;
    const accel = (torque * 1000 + damping) / inertia;      // deg/s^2 (approx, small angle mass factor)
    state.heelVel += accel * dt;
  }
  state.heelVel *= 0.999;
  state.heelDeg += state.heelVel * dt;
  // Reflect off the ends of the floatable range so the ship stops somewhere sane.
  if (state.heelDeg > 88) { state.heelDeg = 88; state.heelVel = 0; }
  if (state.heelDeg < -88) { state.heelDeg = -88; state.heelVel = 0; }
}
