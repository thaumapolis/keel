import { DEG } from "./stability.js";
/**
 * diagnostics.js -- draw the ship and its stability curve in text.
 *
 * Why this exists instead of more numeric assertions. The hydrostatics model was
 * debugged for a long time by reading tables of relative error, and the tables
 * were accurate, internally consistent, and completely useless for the one
 * question that mattered: is this a ship? The form had a bug that no band of
 * tolerance could express -- half-breadth separated as taper(u) * profile(z), so
 * the waterplane had the SAME SHAPE at every draft, only a different scale. That
 * makes the waterplane's second moment track volume in lockstep, which removes
 * the mechanism the whole model is supposed to demonstrate. It showed up the
 * instant the form was drawn: five waterplane outlines, pixel-identical, and a
 * GZ curve with GZ(30) == GZ(150) to five figures and GZ(180) == 0. A ship that
 * rights itself exactly as well upside down as upright is not a ship.
 *
 * So the cheap check runs first, in the form a reader can verify without
 * following any arithmetic, and every plot here has been run against a known-good
 * and a known-broken form to confirm it distinguishes them.
 *
 * Everything is a pure function of a hull (or a GZ sample list) returning a
 * string, so the tests can assert on shape properties -- "the waterplane shrinks
 * as the ship heels", "the curve is not symmetric about 90 degrees" -- rather
 * than on golden text.
 */



/**
 * Draw the waterplane at one heel angle: the outline of the hull sliced by the
 * water surface, seen from above.
 *
 * `breadthAt(u)` returns the half-breadth of the cut at longitudinal fraction u,
 * in body coordinates. Rows are transverse offsets, columns run bow to stern,
 * and the picture is symmetric about its centre row by construction.
 */
export function waterplaneText(breadthAt, { columns = 48, rows = 17, label = "" } = {}) {
  const half = 1;
  const out = [];
  if (label) out.push(label);
  const breadths = [];
  for (let c = 0; c < columns; c += 1) breadths.push(breadthOrZero(breadthAt, c / (columns - 1)));
  const maxBreadth = Math.max(...breadths, 1e-12);
  for (let r = 0; r < rows; r += 1) {
    // Offset of this row, as a fraction of the widest point in the drawing.
    const offset = half - (2 * half * r) / (rows - 1);
    let line = "";
    for (let c = 0; c < columns; c += 1) {
      const scaled = (breadths[c] / maxBreadth) * half;
      line += Math.abs(offset) <= scaled ? "#" : ".";
    }
    out.push(`|${line}|`);
  }
  return out.join("\n");
}

function breadthOrZero(breadthAt, u) {
  const value = breadthAt(u);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Draw transverse sections side by side, at several longitudinal positions and
 * several drafts. This is the plot that makes a separable form obvious: if the
 * section outline is the same shape at every draft, just wider, the waterplane
 * cannot be changing shape under the ship.
 */
export function sectionsText(hull, { stationsU = [0.15, 0.5, 0.85], drafts = [0.25, 0.5, 0.75, 1.0], cells = 41 } = {}) {
  const out = [];
  for (const u of stationsU) {
    out.push(`section at u=${u.toFixed(2)} (fraction of length from stern)`);
    for (const draftFraction of drafts) {
      const z = draftFraction * hull.depth;
      const breadth = hull.halfBreadth(u, z);
      let line = "";
      for (let c = 0; c < cells; c += 1) {
        const x = -hull.beam / 2 + (hull.beam * c) / (cells - 1);
        line += Math.abs(x) <= breadth ? "#" : ".";
      }
      out.push(`  draft ${(draftFraction * 100).toFixed(0).padStart(3)}%  half-breadth ${breadth.toFixed(3).padStart(6)}  |${line}|`);
    }
  }
  return out.join("\n");
}

/**
 * Draw a GZ curve. Rows are righting arm (positive up), columns heel angle.
 *
 * Read this plot for three things, in order:
 *   - Does it start at 0 and rise? If it never leaves 0 the ship is at best
 *     neutrally stable and there is nothing to simulate.
 *   - Where does it come back down, and does it cross zero? Past that angle the
 *     ship stays over. A curve that comes back to zero at 180 with the SAME
 *     height on both sides is describing a solid with upside-down symmetry, not a
 *     ship: no real hull rights itself as well inverted as upright.
 *   - Is the peak where it should be? A peak at the extreme of the range usually
 *     means the form has no way to lose stability, which is the same defect seen
 *     from the other end.
 */
export function gzCurveText(samples, { columns = 60, rows = 21, maxDeg = 180 } = {}) {
  if (samples.length === 0) return "(no samples -- the hull does not float at any angle tested)";
  // Plot from a floor at or below zero so that negative arms are visible, and
  // mark the zero line explicitly. Omitting the zero marker is not a cosmetic
  // lapse: a plot whose bottom row happens to be the zero line is
  // indistinguishable from one where every value is comfortably positive, and a
  // stability curve whose entire positive hump is 0.05 tall against a 0.58 peak
  // looks fine while actually being near-neutral.
  const gzValues = samples.map((s) => s.gz);
  const peak = Math.max(...gzValues, 1e-6);
  const floorValue = Math.min(...gzValues, 0);
  const span = peak - floorValue || 1;
  const angleAt = (column) => (maxDeg * column) / (columns - 1);
  const gzAt = (angleDeg) => {
    let nearest = samples[0];
    let best = Infinity;
    for (const sample of samples) {
      const d = Math.abs(sample.angleDeg - angleDeg);
      if (d < best) { best = d; nearest = sample; }
    }
    return nearest.gz;
  };
  const out = [];
  for (let r = rows - 1; r >= 0; r -= 1) {
    const level = floorValue + (span * r) / (rows - 1);
    let line = "";
    for (let c = 0; c < columns; c += 1) {
      const gz = gzAt(angleAt(c));
      if (gz >= level) line += gz >= 0 ? "#" : "x";
      else line += Math.abs(gz - level) < span / rows / 2 ? "-" : ".";
    }
    const isZeroRow = floorValue < 0 && level <= 0 && floorValue + span * (r + 1) / (rows - 1) > 0;
    out.push(`${level.toFixed(3).padStart(8)} ${isZeroRow ? "0" : " "} |${line}|`);
  }
  let ruler = "         +";
  for (let c = 0; c < columns; c += 1) {
    const angleDeg = Math.round(angleAt(c));
    ruler += angleDeg % 30 === 0 ? String(Math.floor(angleDeg / 30) % 10) : " ";
  }
  out.push(ruler);
  out.push("          heel, degrees (digit = 30). # = positive arm, x = negative, - = zero line");
  const last = samples[samples.length - 1];
  if (last.angleDeg < maxDeg - 1e-6) {
    out.push(`          curve ends at ${last.angleDeg} deg: beyond that no waterline holds the displacement`);
  }
  return out.join("\n");
}

/**
 * Shape properties of a GZ curve, stated as facts a test can assert.
 *
 * These are the assertions that would have caught the separable form. Numeric
 * error bands could not, because the model was computing the wrong quantity
 * accurately.
 */
export function gzCurveProperties(samples) {
  const positive = samples.filter((s) => s.gz > 0);
  const peak = samples.reduce((best, s) => (s.gz > best.gz ? s : best), samples[0]);
  let vanishingDeg = null;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].gz <= 0 && samples[i - 1].gz > 0) {
      const a = samples[i - 1];
      const b = samples[i];
      vanishingDeg = a.angleDeg + ((b.angleDeg - a.angleDeg) * a.gz) / (a.gz - b.gz);
      break;
    }
  }
  // Asymmetry about 90 degrees: the largest difference between GZ(theta) and
  // GZ(180-theta) over the samples that have a mirror partner. A separable hull
  // makes this exactly zero; a hull with any real shape makes it clearly nonzero.
  const byAngle = new Map(samples.map((s) => [Math.round(s.angleDeg), s.gz]));
  let asymmetry = 0;
  for (const [angle, gz] of byAngle) {
    const mirror = 180 - angle;
    if (!byAngle.has(mirror)) continue;
    asymmetry = Math.max(asymmetry, Math.abs(gz - byAngle.get(mirror)));
  }
  return {
    hasAnyRightingArm: positive.length > 0,
    peakAngleDeg: peak.angleDeg,
    peakGz: peak.gz,
    vanishingDeg,
    asymmetryAbout90Deg: asymmetry,
    sampleCount: samples.length,
  };
}

/**
 * Waterplane properties across drafts, the other plot that catches a separable
 * form: for a real hull the waterplane area per unit of breadth-squared changes
 * with draft, because the ends come into and out of the water.
 */
export function waterplaneAcrossDrafts(breadthAtByDraft) {
  return breadthAtByDraft.map(({ draft, breadthAt }) => {
    const n = 200;
    let area = 0;
    let maxBreadth = 0;
    for (let i = 0; i < n; i += 1) {
      const u = (i + 0.5) / n;
      const b = breadthAt(u);
      area += 2 * b;
      if (b > maxBreadth) maxBreadth = b;
    }
    area /= n;
    // A wall-sided form has area exactly proportional to maxBreadth, so the
    // ratio area/maxBreadth is constant across drafts. A real hull's ratio moves.
    return {
      draft,
      area,
      maxBreadth,
      areaPerBreadth: maxBreadth > 0 ? area / maxBreadth : 0,
    };
  });
}

export { DEG };
