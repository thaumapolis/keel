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
  yaw: -0.52,
  pitch: 0.40,
  distance: 9.0,   // multiples of metre-scale world; eye sits clear of the hull
  zoom: 1.0,
};

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
  return { sx: width / 2 + x1 * f, sy: height / 2 - z2 * f, depth };
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
export function renderScene(ctx, { width, height, deckPolys, waterplane, buoyancy, gravity }) {
  const image = ctx.createImageData(width, height);
  const buf = { data: image.data, depth: new Float32Array(width * height) };
  const scale = Math.min(width, height) * 0.62;
  paintSky(buf, width, height);

  // Waterplane first (it is low, translucent, and read against the sky).
  if (waterplane && waterplane.length > 2) {
    const poly = waterplane.map((p) => project(p, width, height, scale)).filter((p) => p !== null);
    if (poly.length > 2) {
      const sheet = blend([120, 200, 220], 0.55, SKY_BOTTOM);
      fillPolygon(buf, width, height, poly, sheet, 500);
    }
  }

  // Hull deck edges as bright wireframe: the tilt of the ship reads against the
  // level horizon these lines make.
  if (deckPolys) {
    for (const ring of deckPolys) {
      const pts = ring.map((p) => project(p, width, height, scale));
      for (let i = 0; i < pts.length; i += 1) {
        strokeLine(buf, width, height, pts[i], pts[(i + 1) % pts.length], [230, 236, 244], 2);
      }
    }
  }

  // Centreline in the waterplane, so the offset of B from it (the arm) is visible.
  strokeLineWorld(buf, width, height, scale, { x: 0, y: -6, z: 0 }, { x: 0, y: 6, z: 0 }, [40, 48, 66], 1);

  // Vertical line of action through B, up toward G: the moment arm is its
  // horizontal distance from G.
  if (buoyancy && gravity) {
    strokeLineWorld(buf, width, height, scale, { x: buoyancy.x, y: buoyancy.y, z: buoyancy.z },
      { x: buoyancy.x, y: buoyancy.y, z: gravity.z }, [120, 220, 255], 1);
  }

  const dot = Math.max(0.06, 0.16);
  if (gravity) marker(buf, width, height, scale, gravity, [255, 224, 120], dot);
  if (buoyancy) marker(buf, width, height, scale, buoyancy, [90, 200, 255], dot);

  ctx.putImageData(image, 0, 0);
}

