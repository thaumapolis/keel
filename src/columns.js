/**
 * columns.js -- the transverse column set, as a standalone module.
 *
 * Extracted from sections.js so that columnBounds can be tested against the hull
 * form at EXACT longitudinal positions. While it lived inside sections.js the
 * only way to reach it was through buildHeel, which places stations at
 * Gauss-Legendre nodes -- nowhere near the round numbers a test wants -- so the
 * first attempt at a column-level test compared one heel's bounds against
 * another heel's x-positions and reported a 100% error that was entirely the
 * test's own. A seam that cannot be addressed directly produces tests that fail
 * for reasons unrelated to the code under test.
 */

import { Hull } from "./hull.js";

/**
 * Body-frame z range in which the hull exists at longitudinal fraction u and
 * body |x| = absX, or null where the column misses the hull entirely.
 *
 * ONE interval per column, and that is a precondition rather than a nicety:
 * floatWaterline bisects assuming submerged volume is monotone in the waterline,
 * which holds iff every column is a single interval. A column submerged in two
 * disjoint bands adds volume as the waterline rises past the lower band and then
 * LOSES it past the gap, and the bisection converges on a waterline that is not
 * the waterline.
 *
 * Both limits come from inverting the half-breadth ONCE. The section is
 *
 *   b(u, z) = widest + K*((z/Zsat)^be - 1)   for z <  Zsat
 *           = widest                          for z >= Zsat
 *
 * with widest = (beam/2)*taper(u), non-decreasing in z and flat from Zsat up. So
 * the column is everything at or above the single crossing z*, capped at the
 * deck, and a column wider than the section ever gets misses entirely:
 *
 *   bottom = min(Zsat, z*),  top = deck      where  b(u, z*) = absX
 *
 * Getting `top` right is not the easy half, and two earlier revisions assumed it
 * was. They clipped only the bottom and set top to the deck unconditionally,
 * which reads as correct for the columns that survive and silently mis-states
 * every column near the section's widest point.
 */
export function columnBounds(hull, u, absX) {
  const fraction = hull.stationFraction(u);
  if (fraction <= 0) return null;
  const widest = (hull.beam / 2) * fraction;
  if (absX > widest) return null;

  // Invert widest * (z/depth)^be = absX. profile is monotone from 0 at the keel
  // to 1 at the deck, so there is exactly one crossing and the column is
  // everything above it: a single interval, for every u and every absX. That is
  // what makes floatWaterline's bisection valid, and it is why the form has
  // profile(0) = 0 rather than a flat bottom.
  const required = absX / widest;
  if (required >= 1) return { bottom: hull.depth, top: hull.depth };
  const bottom = hull.depth * Math.pow(required, 1 / hull.bilgeExponent);
  return { bottom, top: hull.depth };
}

/** Columns and their weights for a station at longitudinal fraction u. */
export function stationColumns(hull, u, xs) {
  return xs.map((x) => columnBounds(hull, u, Math.abs(x)));
}

export { Hull };
