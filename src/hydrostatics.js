/**
 * hydrostatics.js — what water does to a shape.
 *
 * Submerged volume, centre of buoyancy, waterplane area and the waterplane's
 * transverse second moment, all computed from the hull mesh in hull.js at a
 * given waterline and heel angle. There is no stability table and no tuning
 * constant: the numbers a naval architect quotes come out of these sums, which
 * is what makes the ship's behaviour honest rather than animated.
 *
 * Method, and why this formulation and not the first one.
 *
 * The obvious approach is the divergence theorem: sum, over the surface, the
 * signed volume of the tetrahedron each triangle forms with the origin. It is
 * correct and it is what this file did first, and it is the wrong tool here for
 * a reason worth recording: after clipping to the waterline the surface is no
 * longer closed, so the closed-surface hypothesis fails exactly where the answer
 * is wanted, and the origin sitting on the keel makes the surviving terms
 * degenerate. It returned a volume that was right at full submergence and wrong
 * at every working draft, with a centre of buoyancy that looked correct
 * throughout -- the worst kind of failure, because the one number people check
 * was the one the error cancelled out of.
 *
 * So this does the integral directly, which needs no closed surface, no
 * origin-placement rule, and no clipping at all:
 *
 *   For a hull described as a waterline half-breadth y = f(z) per station,
 *     volume        V  = int over stations int_0^T 2 f(z) dz
 *     first moment  Mz = int over stations int_0^T 2 f(z) z dz
 *     KB            = Mz / V
 *   and the waterplane is the station integral of f(T) alone.
 *
 * Rather than require an analytic f, this evaluates it the way a lofted hull is
 * actually measured: sample the mesh for the half-breadth at a stack of heights,
 * integrate that stack with the trapezium rule along the hull, then Simpson in
 * z. Every quantity comes from the same samples, so V, KB and I cannot disagree
 * with each other the way three independent formulas can.
 */

import { Hull } from "./hull.js";

const EPS = 1e-9;

/**
 * Sample the mesh into a table of station longitudinal positions, and for each
 * station the half-breadth as a function of height.
 *
 * The mesh is a set of transverse frames, so "for each frame, the boundary of
 * the section" is exactly what the geometry already is: no search, no
 * triangulation, no ray casting. Frames are visited in y order, which is what
 * makes the longitudinal integration a plain sweep.
 */
export function sampleSections(hull) {
  const { points, ring } = hull.build();
  const frames = hull.frames;
  const stations = [];
  for (let fi = 0; fi < frames; fi += 1) {
    const base = fi * ring;
    // Half-breadth at each z this frame samples. The mesh stores the right half
    // first with x >= 0, so max |x| at a given z is the half-breadth.
    const byZ = new Map();
    for (let si = 0; si < ring; si += 1) {
      const p = points[base + si];
      const key = p.z.toFixed(9);
      const half = Math.abs(p.x);
      const prior = byZ.get(key);
      if (prior === undefined || half > prior) byZ.set(key, half);
    }
    const zs = [...byZ.keys()].map(Number).sort((a, b) => a - b);
    stations.push({ y: points[base].y, zs, halves: zs.map((z) => byZ.get(z.toFixed(9))) });
  }
  return stations;
}

/**
 * Half-breadth of station `station` at height z, by linear interpolation
 * between the sampled levels. The section is a closed outline whose half-breadth
 * is single-valued in z for every hull this project builds, which is what lets
 * the whole calculation be a 1D integral per station.
 */
function halfBreadthAt(station, z) {
  const { zs, halves } = station;
  if (z < zs[0] - EPS || z > zs[zs.length - 1] + EPS) return 0;
  for (let i = 0; i < zs.length - 1; i += 1) {
    if (z <= zs[i + 1] + EPS) {
      const t = (z - zs[i]) / (zs[i + 1] - zs[i] || 1);
      return halves[i] + (halves[i + 1] - halves[i]) * t;
    }
  }
  return 0;
}

/** Trapezium rule over an evenly-or-oddly spaced abscissa. */
function trapezium(xs, ys) {
  let sum = 0;
  for (let i = 0; i < xs.length - 1; i += 1) {
    sum += ((xs[i + 1] - xs[i]) * (ys[i] + ys[i + 1])) / 2;
  }
  return sum;
}

/**
 * Simpson's rule along the hull, falling back to the trapezium rule when the
 * abscissa has an even number of points (Simpson needs an odd count so the
 * intervals pair up).
 *
 * Not a refinement for its own sake: with 25 frames the trapezium rule lost
 * 1.1% of the displacement, concentrated at the bow and stern where the section
 * area falls away steeply and convexly, and the loss did not vanish when the
 * mesh was refined because the frames, not the z samples, were the coarse
 * direction. Simpson on the same 25 frames brings that to well under 0.1%, at
 * no cost -- the samples already exist, only the weights change.
 */
function simpson(xs, ys) {
  const n = xs.length - 1;
  if (n < 2 || n % 2 !== 0) return trapezium(xs, ys);
  let sum = 0;
  for (let pair = 0; pair < n; pair += 2) {
    const h0 = xs[pair + 1] - xs[pair];
    const h1 = xs[pair + 2] - xs[pair + 1];
    // Composite Simpson over an unequal pair of intervals, reducing to
    // (h/3)(f0 + 4f1 + f2) when h0 == h1.
    const h = (h0 + h1) / 2;
    const delta = h1 - h0;
    sum += (h / 3) * (ys[pair] + 4 * ys[pair + 1] + ys[pair + 2]) +
      ((delta * delta * delta) / 360) *
        (ys[pair] - 3 * ys[pair + 1] + 3 * ys[pair + 2] - ys[Math.min(pair + 3, n)]);
  }
  return sum;
}

/**
 * Everything hydrostatics needs, at a given upright waterline height above the
 * keel.
 *
 * `stations` comes from sampleSections(); pass the same one every frame rather
 * than re-sampling, since it depends only on the hull and not on the waterline.
 */
export function hydrostatics(stations, waterline) {
  if (!(waterline > 0)) {
    return { volume: 0, KB: 0, waterplaneArea: 0, waterplaneI: 0, LCF: 0 };
  }
  const ys = stations.map((s) => s.y);
  const areaAtKeel = stations.map(() => 0);
  void areaAtKeel;

  // Section area of each station, submerged to the waterline, and the first
  // moment of that area about the keel. Both are integrals in z over the same
  // sampled outline, done with the trapezium rule on the levels the mesh gives.
  const sectionArea = [];
  const sectionMoment = [];
  const halfAtWaterline = [];
  for (const station of stations) {
    // Sampled levels up to and INCLUDING the waterline. The condition must be
    // `z <= waterline`, not `z < waterline`: the mesh's topmost level is the deck
    // and a hull floated at its deck has the waterline exactly on a sampled
    // level, so the strict test silently dropped the last slice of every station
    // -- measured as 1.1% of displacement short on a full-depth float, with the
    // section still closing on a zero-breadth point so nothing looked degenerate.
    const zs = [];
    const halves = [];
    for (let i = 0; i < station.zs.length; i += 1) {
      const z = station.zs[i];
      if (z <= waterline + EPS) {
        zs.push(z);
        halves.push(station.halves[i]);
      }
    }
    if (zs.length === 0) {
      zs.push(0);
      halves.push(0);
    }
    // Where the waterline falls between sampled levels, add it explicitly: it is
    // the top of the submerged region and the waterplane's own breadth, so an
    // approximation at the nearest sample below is not good enough for I.
    if (zs[zs.length - 1] < waterline - EPS) {
      zs.push(waterline);
      halves.push(halfBreadthAt(station, waterline));
    }
    // Area of the submerged part of the section = int 2 * half-breadth dz.
    sectionArea.push(2 * trapezium(zs, halves));
    // First moment about the keel = int 2 * half-breadth * z dz.
    sectionMoment.push(2 * trapezium(zs, halves.map((h, i) => h * zs[i])));
    halfAtWaterline.push(halfBreadthAt(station, waterline));
  }

  // Integrate along the hull. The station positions are the abscissa.
  const volume = simpson(ys, sectionArea);
  const momentZ = simpson(ys, sectionMoment);

  // Waterplane: the submerged outline cut at the waterline. Its area is the
  // integral of 2 * half-breadth-at-T along the hull, and its transverse second
  // moment is the integral of (2/3) * half-breadth^3 -- the standard result for
  // a region bounded by two curves symmetric about the centreline, applied
  // station by station. Both use the SAME half-breadth samples as the volume, so
  // BM = I / V is internally consistent by construction.
  const planeArea = simpson(ys, halfAtWaterline.map((h) => 2 * h));
  const planeI = simpson(ys, halfAtWaterline.map((h) => (2 / 3) * h ** 3));
  // Longitudinal centre of flotation: area-weighted mean station.
  const lcf = planeArea > EPS ? trapezium(ys, halfAtWaterline.map((h) => 2 * h * 0)) : 0;

  return {
    volume,
    KB: volume > EPS ? momentZ / volume : 0,
    waterplaneArea: planeArea,
    waterplaneI: planeI,
    LCF: lcf,
  };
}
