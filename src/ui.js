/**
 * ui.js -- the browser shell: canvas sizing, input, the animation loop, the
 * GZ-curve chart, and the sentences. Runs last, after the physics modules.
 *
 * Readouts are generated from the live physics state, never fixed strings keyed
 * off a phase -- a caption that drifts from the model is worse than none.
 */

// This module is the browser shell: it touches the DOM the moment it loads, so it
// cannot be imported under Node. The load check (tests/stability.test.mjs) imports
// every src module to catch dead exports, so the DOM access is deferred into
// init() and the module body is inert until a browser calls it. Keeping the check
// exhaustive -- importing ui.js like everything else -- is worth the small wrapper;
// excluding it would reopen the exact hole the check exists to close.
const hasDom = typeof document !== "undefined";
const el = (id) => document.getElementById(id);
let viewCanvas = null, viewCtx = null, curveCanvas = null, curveCtx = null;

// Internal raster width, capped by AREA not width, so a wide short canvas and a
// tall narrow phone canvas cost about the same to paint. Matches the house rule:
// the pixelation the operator flagged is a buffer-resolution problem, so this is
// the knob that matters. 0.9 CSS px at a 900px canvas ≈ 1.4 buffer px/CSS px
// before smoothing.
const MAX_BUFFER_AREA = 900 * 620;

let bufferWidth = 0, bufferHeight = 0;
let holder = null;
function offCanvas() {
  if (holder === null) holder = document.createElement("canvas");
  if (holder.width !== bufferWidth || holder.height !== bufferHeight) {
    holder.width = bufferWidth;
    holder.height = bufferHeight;
  }
  return holder;
}

function sizeCanvas(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(1, rect.width);
  const cssH = Math.max(1, rect.height);
  // devicePixelRatio can be null (observed in this Firefox), and `null || 1` is 1
  // but Math.min(null, 2) is 0; guard to a real positive number before multiplying.
  const rawDpr = Number(window.devicePixelRatio);
  const dpr = Math.min(rawDpr > 0 ? rawDpr : 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  return { cssW, cssH };
}

// The canvas has no CSS size until the browser has laid the page out, which is
// not true the instant init() runs -- measuring there returned 0x0, and drawing
// into a 0-pixel canvas paints nothing and raises no error, i.e. a silently
// blank view. So sizing is checked against the live layout every frame and only
// recomputed when it actually changed: the first frame that has real dimensions
// sizes correctly, and orientation/resize changes are caught by the same path.
let sizedWidth = 0, sizedHeight = 0;
function ensureSized() {
  const rect = viewCanvas.getBoundingClientRect();
  if (Math.round(rect.width) !== sizedWidth || Math.round(rect.height) !== sizedHeight) {
    resizeAll();
    sizedWidth = Math.round(rect.width);
    sizedHeight = Math.round(rect.height);
    return true;
  }
  return false;
}

function resizeAll() {
  const v = sizeCanvas(viewCanvas, viewCtx);
  // Buffer area cap: pick a width, derive height from the canvas aspect.
  let bw = Math.min(v.cssW, 1000);
  let bh = bw * (v.cssH / v.cssW);
  const area = bw * bh;
  if (area > MAX_BUFFER_AREA) {
    const s = Math.sqrt(MAX_BUFFER_AREA / area);
    bw *= s; bh *= s;
  }
  bufferWidth = Math.max(120, Math.round(bw));
  bufferHeight = Math.max(80, Math.round(bh));
  sizeCanvas(curveCanvas, curveCtx);
}

/**
 * Draw the 3D scene into the internal buffer, then blit it scaled up with
 * smoothing on. One blit path so sharpness can't differ between a screenshot and
 * a phone (the two-copies failure mode).
 */
function paintView(frame) {
  const off = offCanvas();
  const octx = off.getContext("2d");
  renderScene(octx, {
    width: bufferWidth,
    height: bufferHeight,
    deckPolys: frame.geometry.deckPolys,
    waterplane: frame.geometry.waterplane,
    hullQuads: frame.geometry.hullQuads,
    buoyancy: frame.buoyancy,
    gravity: frame.gravity,
  });
  viewCtx.imageSmoothingEnabled = true;
  viewCtx.imageSmoothingQuality = "high";
  viewCtx.drawImage(off, 0, 0, viewCanvas.width, viewCanvas.height);
}

/** The righting-arm curve, with the current heel marked. */
function paintCurve() {
  const ctx = curveCtx;
  const W = curveCanvas.width, H = curveCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#131f2e";
  ctx.fillRect(0, 0, W, H);
  const samples = state.curve ? state.curve.samples : [];
  if (samples.length === 0) return;
  const maxDeg = Math.max(30, samples[samples.length - 1].angleDeg);
  let maxGz = 0.05;
  for (const s of samples) maxGz = Math.max(maxGz, Math.abs(s.gz));
  maxGz *= 1.15;
  const pad = { l: 46, r: 14, t: 12, b: 30 };
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const X = (deg) => pad.l + (deg / maxDeg) * plotW;
  const Y = (gz) => pad.t + plotH * 0.5 - (gz / maxGz) * (plotH * 0.5);

  // zero line and axes
  ctx.strokeStyle = "#3a4c66"; ctx.lineWidth = 1.5 * devicePixelRatio();
  ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(W - pad.r, Y(0)); ctx.stroke();
  ctx.fillStyle = "#9fb0c4"; ctx.font = `${12 * devicePixelRatio()}px system-ui`;
  ctx.fillText("0", pad.l - 22, Y(0) + 4);
  ctx.fillText(`+${maxGz.toFixed(2)}m`, 4, pad.t + 10);
  ctx.fillText(`-${maxGz.toFixed(2)}m`, 4, H - pad.b);
  ctx.fillText("heel →", W - pad.r - 46, H - 8);

  // curve
  ctx.strokeStyle = "#7ec8f0"; ctx.lineWidth = 2.5 * devicePixelRatio();
  ctx.beginPath();
  for (let i = 0; i < samples.length; i += 1) {
    const x = X(samples[i].angleDeg), y = Y(samples[i].gz);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // current heel marker
  const hx = X(Math.min(Math.abs(state.heelDeg), maxDeg));
  const cur = rightingArm(state.hull, state.heelDeg * DEG, state.KG, state.volume);
  if (cur !== null && cur.failure === undefined) {
    ctx.fillStyle = "#ffd878";
    ctx.beginPath(); ctx.arc(hx, Y(cur.gz), 4 * devicePixelRatio(), 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = "#ffd87855"; ctx.lineWidth = devicePixelRatio();
  ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, H - pad.b); ctx.stroke();
}

function devicePixelRatio() {
  const raw = Number(window.devicePixelRatio);
  return Math.min(raw > 0 ? raw : 1, 2);
}

function updateBadge(frame) {
  el("heelOut").textContent = `${state.heelDeg.toFixed(0)}°`;
  if (frame !== null) {
    el("gzOut").textContent = frame.gz.toFixed(3);
    const v = el("verdict");
    if (frame.gz > 0.005) { v.textContent = "will right"; v.className = "ok"; }
    else if (frame.gz < -0.005) { v.textContent = "falling further"; v.className = "bad"; }
    else { v.textContent = "balanced"; v.className = ""; }
  } else {
    el("gzOut").textContent = "—";
    const v = el("verdict");
    v.textContent = "won't float here"; v.className = "bad";
  }
}

function updateWords() {
  const s = state.summary;
  const gmWord = s.initialGM > 0.15 ? "stiff" : s.initialGM > 0 ? "tender" : "will loll";
  el("liveText").innerHTML =
    `A ${gmWord} ship at ${Math.round(state.draftFrac * 100)}% load, heeled ${Math.round(Math.abs(state.heelDeg))}°. ` +
    `The bright cyan ring is where the water cuts the hull — the <b>waterplane</b>. The blue dot ` +
    `is where all the water's push acts (centre of buoyancy); the gold dot is where the weight ` +
    `acts (centre of gravity).`;
  const pk = s.maxGz != null ? s.maxGz.toFixed(2) : "0";
  el("curveText").innerHTML =
    `Righting arm rises to <b>${pk} m</b> near <b>${s.maxGzAtDeg}°</b>, then the hull can't` +
    (s.cannotFloatBeyondDeg ? ` float past <b>${Math.round(s.cannotFloatBeyondDeg)}°</b>.` : `. `) +
    ` Initial <b>GM</b> ${s.initialGM.toFixed(2)} m.`;
  el("criticalText").innerHTML =
    `<b>The critical weight height</b> for this ship at this load is about ` +
    `<b>${state.criticalKG.toFixed(2)} m</b> above the keel. Below it, the ship comes back; ` +
    `above it, upright is unstable.`;
  const pct = Math.round(state.kgFrac * 100);
  el("kgExpl").innerHTML = state.kgFrac >= 1
    ? `Weight is <b>above</b> the capsizing limit (${pct}% of it) — this ship will loll over.`
    : `Weight sits at <b>${pct}%</b> of the capsizing limit. Raise it toward 100% and watch the ship go from stiff to sluggish to helpless.`;
}

let lastT = 0;
let lastGoodFrame = null;
function frameTick(now) {
  ensureSized();
  const dt = Math.min(0.05, (now - lastT) / 1000 || 0);
  lastT = now;
  step(dt);
  const frame = currentFrame();
  paintView(frame !== null ? frame : lastGoodFrame);
  if (frame !== null) lastGoodFrame = frame;
  paintCurve();
  updateBadge(frame);
  requestAnimationFrame(frameTick);
}

  // ---- input -------------------------------------------------------------
function init() {
  // Bind DOM refs now that we know a browser is present (Node has no document).
  viewCanvas = el("view");
  viewCtx = viewCanvas.getContext("2d", { alpha: false });
  curveCanvas = el("curve");
  curveCtx = curveCanvas.getContext("2d", { alpha: false });

  // Drag on the 3D view rolls the ship. Grab-and-release: while held, heel follows
  // the pointer; on release the dynamics take over from wherever it let go.
  let dragging = false, dragStartX = 0, dragStartHeel = 0;
  viewCanvas.addEventListener("pointerdown", (e) => {
    dragging = true; state.dragging = true;
    dragStartX = e.clientX; dragStartHeel = state.heelDeg;
    viewCanvas.setPointerCapture(e.pointerId);
  });
  viewCanvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    state.heelDeg = Math.max(-80, Math.min(80, dragStartHeel + dx * 0.35));
    state.heelVel = 0;
  });
  function endDrag() { dragging = false; state.dragging = false; }
  viewCanvas.addEventListener("pointerup", endDrag);
  viewCanvas.addEventListener("pointercancel", endDrag);

  // Pinch / wheel to zoom the camera.
  viewCanvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.zoom = Math.max(0.5, Math.min(2.5, camera.zoom * (1 - e.deltaY * 0.001)));
  }, { passive: false });
  let pinchDist = null;
  viewCanvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  }, { passive: true });
  viewCanvas.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2 && pinchDist !== null) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      camera.zoom = Math.max(0.5, Math.min(2.5, camera.zoom * (d / pinchDist)));
      pinchDist = d;
    }
  }, { passive: true });

  el("draft").addEventListener("input", (e) => {
    state.draftFrac = Number(e.target.value) / 100;
    el("draftOut").textContent = `${e.target.value}%`;
    rebuildHydrostatics(); updateWords();
  });
  el("kg").addEventListener("input", (e) => {
    state.kgFrac = Number(e.target.value) / 100;
    el("kgOut").textContent = `${e.target.value}%`;
    rebuildHydrostatics(); updateWords();
  });
  el("pushBtn").addEventListener("click", () => {
    state.heelDeg = state.summary.initialGM >= 0 ? 35 : -35;
    state.heelVel = 0; state.dragging = false; dragging = false;
  });
  el("levelBtn").addEventListener("click", () => { state.heelDeg = 0; state.heelVel = 0; });

  window.addEventListener("resize", () => { sizedWidth = 0; });

  // ---- boot --------------------------------------------------------------
  resizeAll();
  rebuildHydrostatics();
  updateWords();
  requestAnimationFrame(frameTick);
}

if (hasDom) init();
