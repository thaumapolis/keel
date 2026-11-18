/**
 * view3d.js -- a software 3D view of the ship heeled to one side, WebGL-free.
 *
 * Why software: the browser this project is verified in (headless Firefox)
 * returns null for both webgl2 and webgl, and no other browser starts in this
 * sandbox. So everything is rasterised on the CPU into an ImageData buffer with
 * a painter's back-to-front fill and a per-pixel depth test -- the approach the
 * other projects here use for the same reason.
 *
 * Why 3D rather than the GZ curve alone: the curve is the answer, but the
 * MECHANISM is spatial. Righting happens because the submerged shape changes when
 * the ship tilts: the centre of buoyancy slides out toward the low side while the
 * centre of gravity stays on the centreline, and the two vertical forces -- up at
 * B, down at G -- form a couple that rotates the hull back. Seen head-on that is
 * just a shifting picture; seen in perspective, hull tilted and the waterline
 * staying level, you watch the arm between them open and close. Depth is the
 * information, so the view has depth.
 *
 * What is drawn, and each part is the PHYSICS's own output, not a lookalike:
 *   - the heeled hull as its deck silhouette and a waterline band, so the tilt is
 *     legible against a level horizon;
 *   - the WATERPLANE: the actual water surface polygon the float solve found, as a
 *     translucent sheet. This is the shape that does the righting, and watching it
 *     skew and slide sideways as heel grows is the whole story in one picture.
 *   - B (centre of buoyancy) and G (centre of gravity), both real points from
 *     sections.js, and the vertical line through B whose intersection with the
 *     centreline is the metacentre. The gap between that line and G is GZ.
 *
 * The renderer never derives floatation or buoyancy itself -- it draws exactly the
 * state handed to it from the physics, which is what separates a simulation from
 * an illustration.
 */

export const camera = {
  // Framing chosen by search, not by eye: near-broadside (yaw ~ -1.4) so the
  // 12 m length spans the frame, slight downward pitch so the water reads as a
  // receding surface with a horizon, and the waterline lands near mid-frame. An
  // earlier yaw of -0.52 looked end-on and made the ship a small blob.
  yaw: -0.9,
  pitch: 0.30,
  distance: 10,
  zoom: 1.15,
  // Vertical framing pivot as a fraction of canvas height. The horizon of the
  // water plane lands at centerY + tan(pitch)*scale/height*... ; centerY lets the
  // ship and its horizon be placed together without recomputing the projection.
  centerY: 0.40,
};

/** Screen row of the water-plane horizon for the given canvas and scale. */
export function horizonY(height, scale) {
  return height * camera.centerY + Math.tan(camera.pitch) * scale * camera.zoom;
}

const SKY_TOP = [16, 28, 44];
const SKY_BOTTOM = [86, 122, 138];

/**
 * Rotate a world point (x starboard, y forward, z up) by yaw then pitch, and
 * project. null when the point is behind the eye -- the caller must drop the
 * whole primitive rather than clip a partial line, because a line drawn through
 * the eye smears across the canvas.
 */
function project(point, width, height, scale) {
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  const x1 = point.x * cy - point.y * sy;
  const y1 = point.x * sy + point.y * cy;
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  const y2 = y1 * cp - point.z * sp;
  const z2 = y1 * sp + point.z * cp;
  const depth = camera.distance - y2;
  if (depth <= 0.05) return null;
  const f = (scale * camera.zoom) / depth;
  return { sx: width / 2 + x1 * f, sy: height * camera.centerY - z2 * f, depth };
}

function setPixel(buf, width, height, x, y, rgb, depth) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const k = y * width + x;
  // Depth is camera.distance - y, so LARGER means CLOSER. A fragment draws only
  // if it is at least as close as whatever owns the pixel already; sky is seeded
  // at -Infinity so real geometry always wins it. This comparison was inverted
  // (kept smaller = farther) which rejected all geometry and left only sky.
  if (depth < buf.depth[k]) return;
  buf.depth[k] = depth;
  const i = k * 4;
  buf.data[i] = rgb[0]; buf.data[i + 1] = rgb[1]; buf.data[i + 2] = rgb[2]; buf.data[i + 3] = 255;
}

function paintSky(buf, width, height) {
  for (let y = 0; y < height; y += 1) {
    const t = y / (height - 1);
    const r = SKY_TOP[0] + (SKY_BOTTOM[0] - SKY_TOP[0]) * t;
    const g = SKY_TOP[1] + (SKY_BOTTOM[1] - SKY_TOP[1]) * t;
    const b = SKY_TOP[2] + (SKY_BOTTOM[2] - SKY_TOP[2]) * t;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      buf.data[i] = r; buf.data[i + 1] = g; buf.data[i + 2] = b; buf.data[i + 3] = 255;
      buf.depth[y * width + x] = -Infinity;  // sky is farthest; always loses to geometry
    }
  }
}

/** Depth-tested thick line between two already-projected points. */
function strokeLine(buf, width, height, a, b, rgb, thickness) {
  if (a === null || b === null) return;
  const steps = Math.ceil(Math.hypot(b.sx - a.sx, b.sy - a.sy)) || 1;
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const sx = a.sx + (b.sx - a.sx) * t;
    const sy = a.sy + (b.sy - a.sy) * t;
    const depth = a.depth + (b.depth - a.depth) * t;
    const rad = Math.max(0, thickness - 1);
    for (let dy = -rad; dy <= rad; dy += 1) {
      for (let dx = -rad; dx <= rad; dx += 1) {
        if (dx * dx + dy * dy > rad * rad) continue;
        setPixel(buf, width, height, Math.round(sx + dx), Math.round(sy + dy), rgb, depth);
      }
    }
  }
}

function strokeLineWorld(buf, width, height, scale, p0, p1, rgb, thickness) {
  strokeLine(buf, width, height,
    project(p0, width, height, scale), project(p1, width, height, scale), rgb, thickness);
}

/** Fill a projected polygon with one colour and a single depth value. */
function fillPolyDepth(buf, width, height, poly, rgb, depth) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of poly) { if (p.sy < minY) minY = p.sy; if (p.sy > maxY) maxY = p.sy; }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y += 1) {
    const xs = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i].sy, yj = poly[j].sy;
      if ((yi > y) !== (yj > y)) xs.push(poly[i].sx + ((y + 0.5 - yi) / (yj - yi)) * (poly[j].sx - poly[i].sx));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.floor(xs[k]));
      const xb = Math.min(width - 1, Math.ceil(xs[k + 1]));
      for (let x = xa; x <= xb; x += 1) setPixel(buf, width, height, x, y, rgb, depth);
    }
  }
}

function fillPolygon(buf, width, height, poly, rgb, depth) {
  // Even-odd fill of a projected closed polygon. The waterplane is near-convex so
  // even-odd and non-zero agree; even-odd is chosen only because it needs no
  // winding assumption about the point order the physics hands back.
  let minY = Infinity, maxY = -Infinity;
  for (const p of poly) { if (p.sy < minY) minY = p.sy; if (p.sy > maxY) maxY = p.sy; }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y += 1) {
    // scanline crossings
    const xs = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i].sy, yj = poly[j].sy;
      if ((yi > y) !== (yj > y)) {
        xs.push(poly[i].sx + ((y + 0.5 - yi) / (yj - yi)) * (poly[j].sx - poly[i].sx));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.floor(xs[k]));
      const xb = Math.min(width - 1, Math.ceil(xs[k + 1]));
      for (let x = xa; x <= xb; x += 1) setPixel(buf, width, height, x, y, rgb, depth);
    }
  }
}

function blend(rgb, alpha, under) {
  return [
    Math.round(rgb[0] * alpha + under[0] * (1 - alpha)),
    Math.round(rgb[1] * alpha + under[1] * (1 - alpha)),
    Math.round(rgb[2] * alpha + under[2] * (1 - alpha)),
  ];
}

function marker(buf, width, height, scale, point, rgb, radiusWorld) {
  const p = project(point, width, height, scale);
  if (p === null) return;
  const r = Math.max(3, Math.round(radiusWorld * scale * camera.zoom / camera.distance));
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy > r * r) continue;
      setPixel(buf, width, height, Math.round(p.sx + dx), Math.round(p.sy + dy), rgb, 1e6);
    }
  }
}

/**
 * Render one heel state. Everything here is world-frame, waterline at z = 0.
 *   deckOutline    [{x,y}] world points of the deck edge (the sheer), for the hull silhouette
 *   waterplane     [{x,y}] world points of the water surface polygon, z = 0
 *   buoyancy, gravity  {x,y,z} world points; gravity has z = KG*cos(heel) etc.
 */
/**
 * Colour helpers and the scene composition.
 *
 * Palette: a dusk sea. The hull is a warm topsides above the waterline and a
 * cooler antifouling red below, so the waterline is legible as a colour break even
 * where geometry is edge-on. The water surface is a translucent teal so the ship
 * reads as sitting IN it; the waterplane (the shape that rights the ship) is a
 * bright thin ring at the waterline, not a filled blob -- filled, it read as the
 * whole ship and hid the hull behind it.
 */
const SEA = [22, 58, 82];
const SEA_FAR = [46, 96, 116];
const HULL_DRY = [206, 120, 74];
const HULL_WET = [122, 66, 74];
const WATERLINE = [150, 226, 240];
const DECK = [52, 60, 74];
const LIGHT = { x: 0.45, y: -0.5, z: 0.74 };

function shade(rgb, normal) {
  let d = (normal.x * LIGHT.x + normal.y * LIGHT.y + normal.z * LIGHT.z);
  d = Math.max(0, d);
  const level = 0.4 + 0.6 * d;
  return [Math.min(255, rgb[0] * level), Math.min(255, rgb[1] * level), Math.min(255, rgb[2] * level)];
}

function normalOf(poly3) {
  const ax = poly3[1].x - poly3[0].x, ay = poly3[1].y - poly3[0].y, az = poly3[1].z - poly3[0].z;
  const bx = poly3[2].x - poly3[0].x, by = poly3[2].y - poly3[0].y, bz = poly3[2].z - poly3[0].z;
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}

export function renderScene(ctx, { width, height, deckPolys, waterplane, hullQuads, buoyancy, gravity }) {
  const image = ctx.createImageData(width, height);
  const buf = { data: image.data, depth: new Float32Array(width * height) };
  const scale = Math.min(width, height) * 0.66;
  paintSky(buf, width, height);

  // Water surface: a large flat quad on zw = 0, so there is a sea plane and a
  // horizon the ship's tilt reads against. Depth is uniform, drawn before the hull.
  fillWater(buf, width, height, scale);

  // Hull: opaque lofted quads, wet below zw = 0, dry above. Painter-sorted far to
  // near (smaller depth first means farther for this projection is larger; we sort
  // descending so far quads paint first and near overwrite them).
  if (hullQuads && hullQuads.length) {
    const faces = [];
    for (const q of hullQuads) {
      const proj = q.map((pt) => project(pt, width, height, scale));
      if (proj.some((p) => p === null)) continue;
      const meanZ = (q[0].z + q[1].z + q[2].z + q[3].z) / 4;
      const depth = proj.reduce((t, p) => t + p.depth, 0) / proj.length;
      const rgb = shade(meanZ < 0 ? HULL_WET : HULL_DRY, normalOf(q));
      faces.push({ proj, depth, rgb });
    }
    faces.sort((a, b) => a.depth - b.depth);   // far (large depth is near; here sort so far paints first)
    for (const f of faces) fillPolyDepth(buf, width, height, f.proj, f.rgb, f.depth);
  }

  // Deck outline + sheer: a bright thin ring so the topsides edge reads against sky.
  if (deckPolys) {
    for (const ring of deckPolys) {
      const pts = ring.map((p) => project(p, width, height, scale));
      for (let i = 0; i < pts.length; i += 1) {
        strokeLine(buf, width, height, pts[i], pts[(i + 1) % pts.length], DECK, 2);
      }
    }
  }

  // Waterplane: the water's cut through the hull -- the shape that does the
  // righting. Drawn as a thin bright ring (not filled), on top of the hull.
  // Segments near the bow/stern convergence (where the hull narrows to a point)
  // are skipped: there the ring's two sides collapse together and a stroke
  // smears along the waterline as dashes -- an artifact, not the waterline.
  if (waterplane && waterplane.length > 2) {
    const pts = waterplane.map((p) => project(p, width, height, scale));
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (a === null || b === null) continue;
      if (Math.hypot(a.sx - b.sx, a.sy - b.sy) < 2.5) continue;
      strokeLine(buf, width, height, a, b, WATERLINE, 2);
    }
  }

  // Line of action: vertical through B up to G's height. GZ is the horizontal gap
  // between this line and the centreline's weight point -- the visible mechanism.
  if (buoyancy && gravity) {
    strokeLineWorld(buf, width, height, scale,
      { x: buoyancy.x, y: buoyancy.y, z: buoyancy.z },
      { x: buoyancy.x, y: buoyancy.y, z: gravity.z }, [150, 226, 240], 1);
    strokeLineWorld(buf, width, height, scale,
      { x: gravity.x, y: gravity.y, z: gravity.z },
      { x: buoyancy.x, y: buoyancy.y, z: gravity.z }, [255, 224, 120], 1);
  }
  const dotR = 0.18;
  if (gravity) marker(buf, width, height, scale, gravity, [255, 224, 120], dotR);
  if (buoyancy) marker(buf, width, height, scale, buoyancy, [90, 200, 255], dotR);

  ctx.putImageData(image, 0, 0);
}

/**
 * Fill the sea plane. A rectangle on zw = 0 spanning well past the hull, shaded
 * with distance so the far edge meets the sky as a horizon. Because the plane is
 * flat and huge, project its four far corners and fill the quad.
 */
/**
 * The sea, drawn as everything below the horizon.
 *
 * A finite plane centred on the ship does not work here: at this pitch the near
 * edge swings behind the eye and the quad cannot be rasterised (an earlier attempt
 * drew nothing because three of four corners projected behind the camera). The
 * horizon is what actually reads as "at sea", and it is stable: project one far
 * water point straight away from the camera, take its screen row as the horizon,
 * and fill below it with a distance gradient. The ship then sits on a level water
 * line you can tilt it against, which is the whole point of showing water at all.
 */
function fillWater(buf, width, height, scale) {
  // The sea is everything below the ship's own waterline (the world origin, which
  // every heeled state keeps on the surface). Anchoring the fill to the projected
  // waterline rather than an analytic horizon means the hull reads as afloat at any
  // pitch and any canvas aspect -- the earlier per-aspect horizon math left the ship
  // floating in the sky on a tall portrait canvas. The near water is drawn at the
  // waterline; it deepens toward the bottom of the frame.
  const origin = project({ x: 0, y: 0, z: 0 }, width, height, scale);
  const waterRow = origin === null ? height * 0.4 : origin.sy;
  const span = Math.max(1, height - waterRow);
  for (let y = Math.floor(waterRow); y < height; y += 1) {
    const t = (y - waterRow) / span;
    const rgb = [
      SEA_FAR[0] + (SEA[0] - SEA_FAR[0]) * t,
      SEA_FAR[1] + (SEA[1] - SEA_FAR[1]) * t,
      SEA_FAR[2] + (SEA[2] - SEA_FAR[2]) * t,
    ];
    const depth = 20 * (1 - t) + 4;
    for (let x = 0; x < width; x += 1) setPixel(buf, width, height, x, y, rgb, depth);
  }
}

