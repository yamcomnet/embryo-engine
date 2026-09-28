// src/scene/stage.js — createStage(): the Darkfield specimen. Owns the renderer, camera rig, frame ingest, views,
// Apart, picking, annotations, post chain, quality tiers and render-on-demand (ADDENDUM §G.1).
import {
  MathUtils, NeutralToneMapping, PCFShadowMap, PerspectiveCamera, Ray, Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GRID, N, TISSUE_HEX, TYPE, VIEWS, VIEW_INDEX, FAMILY_OF_TYPE, FAMILY_LABELS } from '../shared.js';
import { tierOf } from './quality.js';
import { createCells } from './cells.js';
import { createSpecimen } from './specimen.js';
import { createPost } from './post.js';
import { createLabels } from './labels.js';
import { createRig } from './camera.js';
import { createMotes } from './motes.js';

const DEG = Math.PI / 180;
const EXPLODE_MAX = 1.49;              // stagger clock end: 1 + max delay (0.25 radius + 3 × 0.08 plate)
const EXPLODE_RATE = 1 / 1.2;          // per second (each cell's own flight takes 1.2 s)
const EMA_SETTLE_MS = 900;
const MAX_DIST = 900, MAX_DIST_MAP = 1600;    // OrbitControls' zoom-out cap (the map preset: camera.js's own clamp)
const GRID_ALL_R = 300;                // scale-grid fade radius that covers the whole dish from any organism centre
const TILT_GLINT = 25 * DEG;           // camera tilt rate (rad/s) at which the dish glass's reflection is halved
const GLIDE_DIM_IN = 0.12, GLIDE_DIM_OUT = 0.5;   // s: the glass's reflection fades out as a glide starts, back after it
const FAMILY_TYPE = [TYPE.ECTO, TYPE.MESO, TYPE.ENDO, TYPE.STEM];
// Narrow screens (phones) have no room beside the Apart stack for the full family names: the stack is framed to
// leave a column for the callouts (applyHudRegion).
const NARROW_PX = 760;
const PLATE_KEYS = ['plate0', 'plate1', 'plate2', 'plate3'];
// The plate callouts' shorter names, for the compact layouts labels.js falls back to when the full ones do not fit.
const FAMILY_LABELS_SHORT = ['Ecto + Neural', 'Meso family', 'Endoderm', 'Stem'];
// Width kept free to the right of the Apart stack on narrow screens for the plate callouts (CSS px): the column's
// leader (labels.js, 28 px) plus the widest short callout ("Ecto + Neural 1,006", 153 px) and a margin.
const NARROW_NOTE_COL = 188;
// Display geometry spring (rad/s): the organism's centre, radius, dome height and the Apart plate gap follow the
// ≤ 10 Hz stats through a critically damped spring, so plates, focus, framing and callouts glide instead of stepping.
const GEO_OMEGA = 6;
const GEO_N = 5;                       // channels: centre x, centre z, rMax, hMax, plate gap
// How far the first cells of a flight have risen (the vertex shader's eeFly at the stagger clock, capped at 1): the
// in-focus volume grows with the flight instead of jumping to the whole stack on its first and last frame.
const flightReach = (s) => 1 - Math.pow(1 - MathUtils.clamp(s, 0, 1), 4.9);
// Provisional field domains until setFieldInfo() (SPEC §4.5.2); channel order = morph RGBA.
const DEFAULT_FIELDS = [
  { key: 'activator', channel: 0, domain: [0, 0.25], scale: 'sqrt', gates: [] },
  { key: 'inhibitor', channel: 1, domain: [0, 8], scale: 'sqrt', gates: [] },
  { key: 'midline', channel: 2, domain: [0, 0.32], scale: 'sqrt', gates: [] },
  { key: 'ap', channel: 3, domain: [0, 0.51], scale: 'sqrt', gates: [] },
];

// Relief (mirrors RELIEF_GLSL in shaders.js; picking, anchors and framing use the same heights as the GPU):
// h(d) = 0.6 + H·(u(2−u))^P + T·(band edges crossed), u = (d − ½)/D, with D an eased copy of the deepest live depth,
// H = DOME_K·D + DOME_H0 − 2·e^(−D/6) (the dome's height grows with the embryo's thickness; a thin embryo, like the
// 37 seeds, stays a low pile of pearls) and T the terrace step (only once there are bands wide enough to terrace).
const DOME_K = 0.5, DOME_H0 = 0.4, DOME_P = 0.75, TERR_0 = 0.3, TERR_K = 0.016;
const domeH = (D) => DOME_K * D + DOME_H0 - 2 * Math.exp(-D / 6);
const terrace = (D) => (TERR_0 + TERR_K * D) * MathUtils.smoothstep(D, 5, 14);
const wrapG = (v) => ((v % GRID) + GRID) % GRID;
const fmt = (n) => Math.round(n).toLocaleString('en-US');

export async function createStage(canvas, {
  quality = 'medium', reducedMotion = false, labelsRoot = null, palette = TISSUE_HEX,
  onAction = () => {},            // kept for the contract: the Darkfield set has no in-world controls, so it never fires
  onUserCamera = () => {},
} = {}) {
  let tier = tierOf(quality);
  let dprOverride = null;
  // relief parameters (per stage) and the CPU mirror of RELIEF_GLSL
  const relief = { D: 4, H: domeH(4), T: terrace(4), e1: 1, e2: 2, e3: 6 };
  function hOf(d) {
    d = Math.max(1, d);
    const u = Math.min(1, Math.max(0, (d - 0.5) / Math.max(relief.D, 1)));
    const terr = (d >= relief.e1 + 0.5) + (d >= relief.e2 + 0.5) + (d >= relief.e3 - 0.5);
    return 0.6 + relief.H * Math.pow(u * (2 - u), DOME_P) + relief.T * terr;
  }

  // ── renderer ──
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;       // not ACES: tissue colours are data
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = tier.shadowSize > 0;
  renderer.shadowMap.type = PCFShadowMap;           // PCFSoftShadowMap is deprecated in r183
  renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  renderer.setClearColor(0x050605, 1);

  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.5, 4000);
  camera.position.set(0, 200, 400);

  const cells = createCells({ tier, palette });
  const post = createPost(renderer, scene, camera, tier);
  const spec = createSpecimen(renderer, {
    cellTextures: cells.textures, displayUniforms: cells.displayUniforms, cellUniforms: cells.uniforms, dofUniform: post.dofUniform,
  });
  spec.setShadowSize(tier.shadowSize);
  // No scene.environment: the props carry their own env map; the cells' reflections are analytic (cells.js).
  scene.add(spec.root, cells.mesh, cells.shadowMesh);
  const U = cells.uniforms, DU = cells.displayUniforms, AU = spec.agarUniforms;
  const motes = createMotes({ capacity: 512, dispA: U.uDispA, tau: U.uTau });
  motes.setCapacity(tier.motes);
  scene.add(motes.mesh);
  U.uKeyCol.value.copy(spec.key.color).multiplyScalar(spec.key.intensity);

  // ── controls + camera rig ──
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, {
    enableDamping: true, dampingFactor: 0.08, zoomToCursor: true, screenSpacePanning: true,
    minDistance: 25, maxDistance: MAX_DIST, minPolarAngle: 0.01, maxPolarAngle: 82 * DEG,
  });
  const rig = createRig(camera, controls, { reducedMotion });

  const labels = labelsRoot ? createLabels(labelsRoot, { max: tier.labels, onInvalidate: () => { st.dirty = true; } }) : null;

  // ── state ──
  const st = {
    viewIdx: 0, isolate: 0, exploded: false, explodeS: 0, flat: 0, hover: -1, pinned: -1,
    stats: null, fields: DEFAULT_FIELDS, params: null, reduced: !!reducedMotion,
    cx: 100, cy: 100, rMax: 4, dmax: 1, hMax: hOf(1), plateR: 12,
    lastTick: -1, viewing: false, dirty: true, busyUntil: 0, animating: false, renders: 0, shadowDirty: true,
    focusDist: 0, cpuMs: 0, anchorAz: 1e9, lastRenderT: 0, width: 1, height: 1, domeD: 0, domeTarget: 1, turntable: false,
    tiltEl: NaN, tilt: 0,             // the camera's elevation last render, and its eased tilt rate (rad/s)
    glide: 0,                         // how far the glass's reflection is held down for a camera glide (0..1, eased)
    clock: { visRel: 0, tauBirth: 1, tauDeath: 1, tauFate: 1 },
  };
  const times = new Float64Array(240);
  let tHead = 0, tCount = 0;
  const scratch = new Float64Array(240);
  // Apart plate floors, from the eased plate gap (geo): the shader, picking, callouts and the DOF all read these.
  const plateY = [72, 54, 36, 18];
  // eased display geometry: value, velocity and target per channel (see GEO_OMEGA)
  const geo = { x: new Float64Array(GEO_N), v: new Float64Array(GEO_N), t: new Float64Array(GEO_N), init: false, snap: false };
  const v3 = new Vector3(), v3b = new Vector3(), v3c = new Vector3(), bufSize = new Vector2(), ray = new Ray();
  const avoidBox = { x: 0, y: 0, rx: 0, ry: 0 };
  // Apart: each plate's screen ellipse [cx, cy, rx, ry] (disc, lit edge and glow), which callout text keeps off
  const plateEll = new Float64Array(16);
  const ellBox = new Float64Array(4);
  /** The plates' outlines into plateEll (eight points round each edge ring, and the ellipse through their bounding
   *  box, padded for the glow); returns the count. A small function of its own, so its arithmetic stays unboxed. */
  function platesOnScreen() {
    const r = st.plateR + 0.4, cx = geo.x[0], cz = geo.x[1], w = st.width, h = st.height;
    for (let k = 0; k < 4; k++) {
      ellBox[0] = Infinity; ellBox[1] = Infinity; ellBox[2] = -Infinity; ellBox[3] = -Infinity;
      for (let j = 0; j < 8; j++) {
        const a = (j * Math.PI) / 4;
        v3b.set(cx + r * Math.cos(a), plateY[k] - 0.18, cz + r * Math.sin(a)).project(camera);
        const px = (v3b.x * 0.5 + 0.5) * w, py = (0.5 - v3b.y * 0.5) * h;
        if (px < ellBox[0]) ellBox[0] = px;
        if (px > ellBox[2]) ellBox[2] = px;
        if (py < ellBox[1]) ellBox[1] = py;
        if (py > ellBox[3]) ellBox[3] = py;
      }
      const o = 4 * k;
      plateEll[o] = 0.5 * (ellBox[0] + ellBox[2]); plateEll[o + 1] = 0.5 * (ellBox[1] + ellBox[3]);
      plateEll[o + 2] = 0.5 * (ellBox[2] - ellBox[0]) + 3; plateEll[o + 3] = 0.5 * (ellBox[3] - ellBox[1]) + 3;
    }
    return 4;
  }
  // The HUD covers parts of the canvas: the view is shifted (camera view offset) so the specimen centres in the
  // free region, and auto-framing fits the organism to that region. Offsets in CSS px, eased toward the target.
  const hud = { l: 0, r: 0, t: 0, b: 0 };
  const viewOff = { x: 0, y: 0, tx: 0, ty: 0 };

  // The user takes the camera over only with a real gesture: a drag past TAKEOVER_PX, a second pointer (pinch or
  // pan), or the wheel. OrbitControls fires 'start' on every pointerdown, so a plain click or tap (which pins a cell)
  // would otherwise switch auto-framing off. Below the threshold the rig keeps framing and overwrites any nudge.
  const TAKEOVER_PX = 6;                                  // = main.js TAP_PX
  const downPts = new Map();
  let pending = null;
  function takeover() {
    pending = null;
    if (rig.userControlled) return;
    rig.onUserStart(); st.dirty = true; onUserCamera();
  }
  canvas.addEventListener('pointerdown', (e) => {
    downPts.set(e.pointerId, true);
    if (!pending) pending = { x: e.clientX, y: e.clientY };
    if (downPts.size >= 2) takeover();
  }, true);
  canvas.addEventListener('pointermove', (e) => {
    if (pending && downPts.has(e.pointerId) && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > TAKEOVER_PX) takeover();
  }, true);
  const lift = (e) => { downPts.delete(e.pointerId); if (!downPts.size) pending = null; };
  canvas.addEventListener('pointerup', lift, true);
  canvas.addEventListener('pointercancel', lift, true);
  canvas.addEventListener('wheel', takeover, { capture: true, passive: true });
  controls.addEventListener('start', () => { st.dirty = true; });
  controls.addEventListener('change', () => { st.dirty = true; });

  // ── views ──
  function applyView() {
    const v = VIEWS[st.viewIdx];
    DU.uView.value = st.viewIdx;
    const signal = v.group === 'signal';
    if (signal) {
      const fi = st.fields.find((f) => f.channel === v.channel) || DEFAULT_FIELDS[v.channel];
      DU.uChanMask.value.set(v.channel === 0 ? 1 : 0, v.channel === 1 ? 1 : 0, v.channel === 2 ? 1 : 0, v.channel === 3 ? 1 : 0);
      DU.uDomainMax.value = fi.domain[1];
      DU.uSqrtScale.value = fi.scale === 'sqrt' ? 1 : 0;
      // Relative gates (the activator's, × the mean at a cell's own depth) have no single field value: no iso-line.
      const gates = (fi.gates || []).filter((g) => typeof g.rel !== 'number' && Number.isFinite(g.v));
      AU.uGateN.value = Math.min(4, gates.length);
      AU.uGates.value.set(gates[0]?.v ?? 0, gates[1]?.v ?? 0, gates[2]?.v ?? 0, gates[3]?.v ?? 0);
    }
    AU.uSignal.value = signal ? 1 : 0;
    AU.uSurf.value = v.id === 'depth' ? 1 : 0;
    if (st.reduced) cells.snap();
    touch();
  }
  function touch(ms = EMA_SETTLE_MS) {
    st.dirty = true;
    st.busyUntil = Math.max(st.busyUntil, performance.now() + ms);
  }

  // ── annotation anchors (recomputed on stats and when the camera swings) ──
  const anchor = { ecto: -1, muscle: -1, stem: -1, neural: -1 };
  function cellAt(x, y) { return wrapG(Math.round(y)) * GRID + wrapG(Math.round(x)); }
  function marchRim(dx, dy) {
    let last = -1;
    for (let s = 0; s <= st.rMax + 4; s += 0.5) {
      const i = cellAt(st.cx + dx * s, st.cy + dy * s);
      if (cells.cell[4 * i]) last = i;
      else if (last >= 0 && cells.cell[4 * i + 2] === 0) break;
    }
    return last;
  }
  function marchFind(dx, dy, type) {
    for (let s = 0; s <= st.rMax + 2; s += 0.5) {
      const i = cellAt(st.cx + dx * s, st.cy + dy * s);
      if (cells.cell[4 * i] === type) return i;
    }
    return -1;
  }
  function spiralFind(x0, y0, type, R) {
    for (let r = 0; r <= R; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const i = cellAt(x0 + dx, y0 + dy);
          if (cells.cell[4 * i] === type) return i;
        }
      }
    }
    return -1;
  }
  function computeAnchors() {
    const az = rig.azimuth();
    st.anchorAz = az;
    const rx = Math.cos(az), rz = -Math.sin(az), fx = Math.sin(az), fz = Math.cos(az);   // camera right / toward camera
    let ex = 0.8 * rx + 0.6 * fx, ez = 0.8 * rz + 0.6 * fz, l = Math.hypot(ex, ez); ex /= l; ez /= l;
    anchor.ecto = marchRim(ex, ez);
    anchor.muscle = -1;
    const base = Math.atan2(0.45 * fz - 0.9 * rz, 0.45 * fx - 0.9 * rx);
    for (let k = 0; k < 13 && anchor.muscle < 0; k++) {
      const a = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 15 * DEG;
      anchor.muscle = marchFind(Math.cos(a), Math.sin(a), TYPE.MUSCLE);
    }
    anchor.stem = spiralFind(st.cx, st.cy, TYPE.STEM, 8);
    const ng = st.stats?.geom?.neural;
    anchor.neural = ng && ng.count > 0 ? spiralFind(ng.cx, ng.cy, TYPE.NEURAL, 10) : -1;
  }
  // Apart callouts on the plates' camera-right rims, from the eased geometry. `full` (stats, stain, width) declares
  // them; otherwise only their anchors move, every render while the plates ease or the camera turns (no allocation).
  // They stay on the right of the stack: flipped to the left they would sit on the plates. They are one label group:
  // labels.js shows all four, stepping from full names to short names to a column (packed into a free band on a short
  // screen) as room runs out, and keeps their text off the plates (plateEll) but as a last resort. Phones also get a
  // stack framed to leave them a column (applyHudRegion).
  const plateAnchor = [null, null, null, null];     // the plate callouts' world anchors, moved in place
  function placePlateNotes(full = true) {
    const s = st.stats;
    if (!labels || !s) return;
    const az = rig.azimuth(), rx = Math.cos(az), rz = -Math.sin(az), fx = Math.sin(az), fz = Math.cos(az);
    const r = st.plateR, ox = geo.x[0], oz = geo.x[1];
    const ax = r * (0.92 * rx + 0.38 * fx), az2 = r * (0.92 * rz + 0.38 * fz);
    for (let k = 0; k < 4; k++) {
      if (!full) { plateAnchor[k]?.set(ox + ax, plateY[k] + 0.6, oz + az2); continue; }
      const n = s.plates?.fate?.[k] ?? 0;
      labels.set(PLATE_KEYS[k], {
        priority: 1 + k, text: FAMILY_LABELS[k], short: FAMILY_LABELS_SHORT[k], group: 'plates', value: fmt(n),
        swatch: palette[FAMILY_TYPE[k]], side: 1,
        x: ox + ax, y: plateY[k] + 0.6, z: oz + az2,
      });
      plateAnchor[k] = labels.anchor(PLATE_KEYS[k]);
    }
  }
  function cellTopWorld(i, out) {
    const x = i % GRID, y = (i / GRID) | 0;
    const h = st.flat > 0.5 ? 0.6 : hOf(cells.cell[4 * i + 2]);
    return out.set(x - 99.5, h + 0.4, y - 99.5);
  }
  function updateNotes() {
    if (!labels) return;
    const s = st.stats;
    if (!s) { labels.hideAll(); return; }
    const tc = s.typeCounts;
    const tissue = st.viewIdx === 0;
    const apart = st.explodeS > 0.6 * EXPLODE_MAX;
    if (st.explodeS > 0.02 && st.explodeS < 0.9 * EXPLODE_MAX) { labels.hideAll(); return; }   // mid-flight
    if (apart) {
      for (const k of ['anterior', 'neural', 'ecto', 'stem', 'muscle']) labels.hide(k);
      placePlateNotes();
      return;
    }
    for (let k = 0; k < 4; k++) labels.hide(PLATE_KEYS[k]);
    labels.set('anterior', { priority: 1, text: 'Anterior', value: '↑', x: st.cx - 99.5, y: 0.8, z: st.cy - st.rMax - 6 - 99.5 });
    // Anatomical landmarks (ADDENDUM §C) in every stain; only the Tissue stain colours by type, so only there do they
    // carry the tissue's swatch and count. Elsewhere they are bare, dimmed landmarks, never read as a colour key.
    const note = (key, pri, i, text, count, type) => {
      if (i < 0 || !count) { labels.hide(key); return; }
      cellTopWorld(i, v3);
      labels.set(key, {
        priority: pri, text, value: tissue ? fmt(count) : '', swatch: tissue ? palette[type] : '', landmark: !tissue,
        x: v3.x, y: v3.y, z: v3.z,
      });
    };
    note('neural', 2, tc[TYPE.NEURAL] >= 10 ? anchor.neural : -1, 'Neural plate', tc[TYPE.NEURAL], TYPE.NEURAL);
    note('ecto', 3, anchor.ecto, 'Ectoderm', tc[TYPE.ECTO], TYPE.ECTO);
    // the core's own stem cells (core band), not every stem cell: newborns at the rim are stem too
    const core = s.bands?.stemCore;
    if (typeof core === 'number') note('stem', 4, anchor.stem, 'Stem core', core, TYPE.STEM);
    else note('stem', 4, anchor.stem, 'Stem', tc[TYPE.STEM], TYPE.STEM);
    // the first muscle cells are scattered singletons; "blocks" once they cluster (mean same-type share of live
    // neighbours ≥ 0.4, the engine doc's bar; back below 0.35 it reads "Muscle" again)
    const cl = s.signals?.muscleClustering ?? 0;
    st.muscleBlocks = cl >= 0.4 || (st.muscleBlocks && cl >= 0.35);
    note('muscle', 5, tc[TYPE.MUSCLE] >= 10 ? anchor.muscle : -1, st.muscleBlocks ? 'Muscle blocks' : 'Muscle', tc[TYPE.MUSCLE], TYPE.MUSCLE);
  }

  // ── picking ──
  function rayFrom(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const nx = ((clientX - r.left) / r.width) * 2 - 1, ny = -((clientY - r.top) / r.height) * 2 + 1;
    ray.origin.setFromMatrixPosition(camera.matrixWorld);
    ray.direction.set(nx, ny, 0.5).unproject(camera).sub(ray.origin).normalize();
    return ray;
  }
  // Analytic picking: a 2D DDA (Amanatides–Woo) over the grid inside a y-slab; each column is its footprint box
  // (inset from the cell edge like the rendered columns) up to its top. `plate` < 0 = assembled, else Apart plate k.
  const HW = 0.44;
  const slab = new Float64Array(12);
  function columnTop(i, plate) {
    const ty = cells.cell[4 * i];
    if (!ty) return -1;
    const dep = cells.cell[4 * i + 2];
    if (plate < 0) return st.flat > 0.5 ? 0.6 : hOf(dep);
    return FAMILY_OF_TYPE[ty] === plate ? plateY[plate] + 0.35 + 0.25 * Math.sqrt(Math.max(1, dep)) : -1;
  }
  function ddaPick(o, d, yLo, yHi, plate) {
    let t0 = 0, t1 = 1e9;
    const ax = slab;
    ax[0] = o.x; ax[1] = d.x; ax[2] = -100; ax[3] = 100; ax[4] = o.y; ax[5] = d.y; ax[6] = yLo; ax[7] = yHi;
    ax[8] = o.z; ax[9] = d.z; ax[10] = -100; ax[11] = 100;
    for (let k = 0; k < 12; k += 4) {
      const oc = ax[k], dc = ax[k + 1], lo = ax[k + 2], hi = ax[k + 3];
      if (Math.abs(dc) < 1e-9) { if (oc < lo || oc > hi) return null; continue; }
      let a = (lo - oc) / dc, b = (hi - oc) / dc;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return null;
    }
    let gx = MathUtils.clamp(Math.floor(o.x + d.x * (t0 + 1e-5) + 100), 0, GRID - 1);
    let gz = MathUtils.clamp(Math.floor(o.z + d.z * (t0 + 1e-5) + 100), 0, GRID - 1);
    const sx = d.x > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
    const ix = Math.abs(d.x) < 1e-9 ? 1e9 : 1 / d.x, iz = Math.abs(d.z) < 1e-9 ? 1e9 : 1 / d.z;
    let tX = Math.abs(d.x) < 1e-9 ? Infinity : (gx + (d.x > 0 ? 1 : 0) - 100 - o.x) * ix;
    let tZ = Math.abs(d.z) < 1e-9 ? Infinity : (gz + (d.z > 0 ? 1 : 0) - 100 - o.z) * iz;
    const dX = Math.abs(ix), dZ = Math.abs(iz);
    for (let step = 0; step < 460; step++) {
      const i = gz * GRID + gx;
      const top = columnTop(i, plate);
      if (top >= 0) {
        // ray vs the column's footprint box, inside this cell's span of the walk
        const cx = gx - 99.5, cz = gz - 99.5;
        let a = (cx - HW - o.x) * ix, b = (cx + HW - o.x) * ix;
        if (a > b) { const t = a; a = b; b = t; }
        let c = (cz - HW - o.z) * iz, e = (cz + HW - o.z) * iz;
        if (c > e) { const t = c; c = e; e = t; }
        const ta = Math.max(a, c, t0), tb = Math.min(b, e, t1);
        if (ta <= tb) {
          const base = plate < 0 ? 0 : plateY[plate];
          const ya = o.y + d.y * ta, yb = o.y + d.y * tb;
          if (Math.min(ya, yb) <= top && Math.max(ya, yb) >= base) return i;
        }
      }
      if (Math.min(tX, tZ) >= t1) break;
      if (tX < tZ) { gx += sx; tX += dX; } else { gz += sz; tZ += dZ; }
      if (gx < 0 || gx >= GRID || gz < 0 || gz >= GRID) break;
    }
    return null;
  }
  function pickAssembled(o, d) {
    return ddaPick(o, d, 0, (st.flat > 0.5 ? 0.6 : st.hMax) + 1, -1);
  }
  function pickPlates(o, d) {
    for (let k = 0; k < 4; k++) {                      // top plate first: the ray descends through the stack
      const hit = ddaPick(o, d, plateY[k], plateY[k] + 0.35 + 0.25 * Math.sqrt(Math.max(1, st.dmax)) + 0.1, k);
      if (hit !== null) return hit;
    }
    return null;
  }

  // ── sizing ──
  function resize() {
    const w = Math.max(1, canvas.clientWidth | 0), h = Math.max(1, canvas.clientHeight | 0);
    const dpr = Math.min(window.devicePixelRatio || 1, dprOverride ?? tier.dprCap);
    st.width = w; st.height = h;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    post.setSize(w, h, dpr);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    rig.setAspect(w / h);
    applyHudRegion();
    applyViewOffset();
    applyNoteMax();
    st.dirty = true;
  }
  // Narrow screens show three landmarks; Apart always shows all four plates (the stem plate's callout is the fourth).
  function applyNoteMax() {
    const cap = st.width < NARROW_PX ? 3 : tier.labels;
    labels?.setMax(st.exploded ? Math.max(4, cap) : cap);
  }

  function applyHudRegion() {
    const w = Math.max(1, st.width), h = Math.max(1, st.height);
    const l = MathUtils.clamp(hud.l, 0, 0.45 * w), r = MathUtils.clamp(hud.r, 0, 0.45 * w);
    const t = MathUtils.clamp(hud.t, 0, 0.45 * h), b = MathUtils.clamp(hud.b, 0, 0.45 * h);
    // Apart: the plate callouts run to the right of the stack, so on wide screens the stack moves left to make room.
    // A phone has no room beside a full-width stack: a column is kept free on the right for the callouts and the
    // stack is fitted, by its plates' width, into what is left.
    const apartShift = st.exploded && w >= NARROW_PX ? -Math.min(130, 0.09 * w) : 0;
    const col = st.exploded && w < NARROW_PX ? Math.min(NARROW_NOTE_COL, 0.6 * (w - l - r)) : 0;
    viewOff.tx = (l - r - col) / 2 + apartShift; viewOff.ty = (t - b) / 2;
    rig.setRegion((w - l - r - col) / w, (h - t - b) / h, col > 0);
    if (st.reduced || st.renders === 0) { viewOff.x = viewOff.tx; viewOff.y = viewOff.ty; }
  }
  function applyViewOffset() {
    const w = Math.max(1, st.width), h = Math.max(1, st.height);
    if (Math.abs(viewOff.x) < 0.25 && Math.abs(viewOff.y) < 0.25) { if (camera.view) camera.clearViewOffset(); }
    else camera.setViewOffset(w, h, -viewOff.x, -viewOff.y, w, h);
  }

  // Dome thickness D: follows dmax through a ±1.5 deadband (so a single deepest cell dying or being born does not
  // make the whole relief breathe) and eases there over ~1 s; snaps on the first stats and under reduced motion.
  function setDomeTarget(dmax, snap) {
    const d = Math.max(1, dmax);
    if (snap || st.domeD <= 0) { st.domeTarget = d; st.domeD = d; }
    else if (Math.abs(d - st.domeTarget) > 1.5) st.domeTarget = d;
    applyRelief();
  }
  function applyRelief() {
    relief.D = st.domeD;
    relief.H = domeH(st.domeD);
    relief.T = terrace(st.domeD);
    DU.uDome.value.set(relief.D, relief.H, DOME_P, relief.T);
    st.hMax = hOf(st.dmax);
  }

  // ── display geometry (see GEO_OMEGA) ──
  function geoTargets() {
    const t = geo.t;
    t[0] = st.cx - 99.5; t[1] = st.cy - 99.5; t[2] = st.rMax; t[3] = st.hMax; t[4] = MathUtils.clamp(0.35 * st.rMax, 6, 18);
  }
  function geoApply() {
    for (let k = 0; k < 4; k++) plateY[k] = 18 + (3 - k) * geo.x[4];
    st.plateR = geo.x[2] + 8;
    rig.setOrganism(geo.x[0], geo.x[1], geo.x[2], geo.x[3], plateY[3], plateY[0] + 3);
  }
  function geoSnap() {
    geoTargets();
    for (let k = 0; k < GEO_N; k++) { geo.x[k] = geo.t[k]; geo.v[k] = 0; }
    geo.init = true; geo.snap = false;
    geoApply();
  }
  /** Advance the geometry spring (exact critically damped step: frame-rate independent). True while it moves. */
  function geoStep(dt) {
    geoTargets();
    if (!geo.init || st.reduced) { geoSnap(); return false; }
    const x = geo.x, v = geo.v, t = geo.t, e = Math.exp(-GEO_OMEGA * dt);
    let moving = false;
    for (let k = 0; k < GEO_N; k++) {
      const x0 = x[k] - t[k];
      if (x0 === 0 && v[k] === 0) continue;
      const tmp = (v[k] + GEO_OMEGA * x0) * dt;
      v[k] = (v[k] - GEO_OMEGA * tmp) * e;
      x[k] = t[k] + (x0 + tmp) * e;
      if (Math.abs(x[k] - t[k]) < 1e-3 && Math.abs(v[k]) < 1e-3) { x[k] = t[k]; v[k] = 0; } else moving = true;
    }
    geoApply();
    return moving;
  }

  function applyTier(t) {
    tier = t;
    cells.setLod(t.lod);
    cells.setSheen(t.sheen);
    motes.setCapacity(t.motes);
    const shadows = t.shadowSize > 0;
    if (renderer.shadowMap.enabled !== shadows) { renderer.shadowMap.enabled = shadows; cells.material.needsUpdate = true; }
    spec.setShadowSize(t.shadowSize);
    st.shadowDirty = true;
    post.setTier(t);
    resize();
  }

  // ── public API ──
  const stage = {
    setFrame(frame) {
      const snap = st.lastTick < 0 || frame.tick < st.lastTick || frame.prevTick === frame.tick || !!frame.viewing !== st.viewing;
      cells.ingest(frame);
      if (snap) {
        cells.snap();
        const g = frame.stats?.geom;                 // a jump (fast-forward, reset, snapshot): the relief snaps too
        if (g && g.dmax > 0) { st.dmax = Math.max(1, g.dmax); setDomeTarget(st.dmax, true); }
        geo.snap = true;                             // and so does the display geometry, with the next stats
      }
      // energy motes: not under reduced motion, above 240 t/s, or for snapshot frames
      const tps = st.stats?.tps?.actual ?? 0;
      motes.spawn(cells.events, cells.eventCount, frame.tick, !st.reduced && tps <= 240 && !frame.viewing);
      st.lastTick = frame.tick;
      st.viewing = !!frame.viewing;
      st.shadowDirty = true;
      touch();
    },

    setStats(stats) {
      const first = st.stats === null;
      st.stats = stats;
      const g = stats.geom;
      if (g) {
        st.cx = g.cx; st.cy = g.cy; st.rMax = Math.max(1.5, g.rMax); st.dmax = Math.max(1, g.dmax || 1);
        const b = g.bands || { e1: 1, e2: 2, e3: 6 };
        relief.e1 = b.e1; relief.e2 = b.e2; relief.e3 = b.e3;
        DU.uBands.value.set(b.e1, b.e2, b.e3, st.dmax);
        setDomeTarget(st.dmax, first || st.reduced || st.viewing);
      }
      const e = stats.energy;
      if (e && e.thrStem) DU.uThr.value.set(e.thrStem, e.thrDiff);
      // new targets for the display geometry; render() eases toward them (a jump, or reduced motion, snaps)
      if (first || st.reduced || st.viewing || geo.snap) geoSnap(); else geoTargets();
      computeAnchors();
      updateNotes();
      st.dirty = true;
    },

    setFieldInfo(fieldInfo, params) {
      if (Array.isArray(fieldInfo) && fieldInfo.length) st.fields = fieldInfo;
      if (params) {
        st.params = params;
        if (params.divThreshStem) DU.uThr.value.set(params.divThreshStem, params.divThreshDiff);
      }
      applyView();
    },

    setClock({ visRel = 0, tauBirth = 1, tauDeath = 1, tauFate = 1 } = {}) {
      const c = st.clock;
      if (c.visRel === visRel && c.tauBirth === tauBirth && c.tauDeath === tauDeath && c.tauFate === tauFate) return;
      c.visRel = visRel; c.tauBirth = tauBirth; c.tauDeath = tauDeath; c.tauFate = tauFate;
      DU.uVisRel.value = visRel;
      U.uTau.value.set(Math.max(1e-3, tauBirth), Math.max(1e-3, tauDeath), Math.max(1e-3, tauFate));
      st.dirty = true;
    },

    setView(viewId) {
      const i = VIEW_INDEX[viewId];
      if (i === undefined || i === st.viewIdx) return;
      st.viewIdx = i;
      applyView();
      updateNotes();
    },
    setIsolate(type) {
      st.isolate = type ? type | 0 : 0;
      DU.uIsolate.value = st.isolate;
      touch();
    },
    setExploded(on) {
      st.exploded = !!on;
      rig.setExploded(st.exploded);
      applyHudRegion();
      applyNoteMax();
      if (st.reduced) st.explodeS = st.exploded ? EXPLODE_MAX : 0;
      touch(200);
    },

    setCamera(preset) {
      if (!['specimen', 'close', 'map'].includes(preset)) return;
      rig.setPreset(preset, { animate: !st.reduced });
      touch(200);
    },
    setAutoFrame(on) { rig.setAuto(!!on); touch(200); },
    /** Slow cinematic orbit (main turns it on while the run plays, untouched, without reduced motion). */
    setTurntable(on) { st.turntable = !!on; rig.setTurntable(st.turntable); touch(200); },
    frameOrganism() { rig.frame(); touch(200); },
    orbitBy(dAz = 0, dEl = 0) { rig.orbitBy(dAz, dEl); touch(200); },
    zoomBy(f = 1) { rig.zoomBy(f); touch(200); },

    /** The HUD's footprint on the canvas (CSS px): `insets` {left, right, top, bottom} = the panels framing the view
     *  (the specimen centres in what is left), `rects` [{left, top, right, bottom}] = every panel, kept clear by notes. */
    setHudLayout({ insets = null, rects = null } = {}) {
      if (insets) {
        const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
        const l = n(insets.left), r = n(insets.right), t = n(insets.top), b = n(insets.bottom);
        if (Math.abs(l - hud.l) + Math.abs(r - hud.r) + Math.abs(t - hud.t) + Math.abs(b - hud.b) > 2) {
          hud.l = l; hud.r = r; hud.t = t; hud.b = b;
          applyHudRegion();
          touch(200);
        }
      }
      if (rects && labels?.setExclusions(rects)) st.dirty = true;
    },

    setHighlight({ hover = null, pinned = null } = {}) {
      st.hover = hover ?? -1; st.pinned = pinned ?? -1;
      U.uHover.value = st.hover; U.uPinned.value = st.pinned;
      st.dirty = true;
    },

    pick(clientX, clientY) {
      const r = rayFrom(clientX, clientY);
      if (st.explodeS > 0.75 * EXPLODE_MAX) return pickPlates(r.origin, r.direction);
      if (st.explodeS > 0.05) return null;          // mid-flight: nothing is where the grid says
      return pickAssembled(r.origin, r.direction);
    },

    /** CSS px of the cell's cap relative to the canvas. `visible` is false off screen, behind the camera, or when
     *  the whole cap is hidden behind other columns; the anchor slides back across the cap to stay on the visible part. */
    projectCell(idx) {
      if (!(idx >= 0 && idx < N)) return { x: 0, y: 0, visible: false };
      const x = idx % GRID, y = (idx / GRID) | 0, ty = cells.cell[4 * idx];
      const apart = st.explodeS > 0.75 * EXPLODE_MAX;
      let h = st.flat > 0.5 ? 0.6 : hOf(cells.cell[4 * idx + 2]);
      if (apart && ty) h = plateY[FAMILY_OF_TYPE[ty]] + 0.35 + 0.25 * Math.sqrt(Math.max(1, cells.cell[4 * idx + 2]));
      const cx = x - 99.5, cz = y - 99.5;
      v3b.setFromMatrixPosition(camera.matrixWorld);
      let bx = cx - v3b.x, bz = cz - v3b.z;
      const bl = Math.hypot(bx, bz) || 1; bx /= bl; bz /= bl;
      let first = null;
      for (let k = 0; k < 3; k++) {
        const off = k * 0.18;                          // 0, 0.18, 0.36 cell away from the camera
        v3.set(cx + bx * off, h, cz + bz * off).project(camera);
        const px = (v3.x * 0.5 + 0.5) * st.width, py = (0.5 - v3.y * 0.5) * st.height;
        const onScreen = !!ty && v3.z > -1 && v3.z < 1 && px >= 0 && py >= 0 && px <= st.width && py <= st.height;
        if (!first) first = { x: px, y: py, visible: false };
        if (!onScreen) return first;
        if (st.explodeS > 0.05 && !apart) return { x: px, y: py, visible: true };
        ray.origin.copy(v3b);
        ray.direction.set(cx + bx * off - v3b.x, h + 0.02 - v3b.y, cz + bz * off - v3b.z).normalize();
        const hit = apart ? pickPlates(ray.origin, ray.direction) : pickAssembled(ray.origin, ray.direction);
        if (hit === idx) return { x: px, y: py, visible: true };
      }
      return first;
    },

    setQuality(q) {
      const name = typeof q === 'string' ? q : q?.tier;
      if (q && typeof q === 'object' && 'dpr' in q) dprOverride = q.dpr ?? null;
      applyTier(tierOf(name || tier.name));
    },
    getQuality() { return { tier: tier.name, dpr: renderer.getPixelRatio() }; },
    /** Compile the shadowless (Low tier) variants of the scene's programs now, while the browser is idle, so a later
     *  switch to Low picks them from the program cache instead of compiling synchronously (a visible freeze). The
     *  state is flipped and restored within this call: no frame is ever rendered with it. */
    precompileShadowless() {
      if (!renderer.shadowMap.enabled) return false;
      const mats = new Set();
      scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) mats.add(m); });
      const cast = spec.key.castShadow;
      try {
        renderer.shadowMap.enabled = false; spec.key.castShadow = false;
        for (const m of mats) m.needsUpdate = true;
        compileScene(false);                             // parallel compile where KHR_parallel_shader_compile exists
      } finally {
        renderer.shadowMap.enabled = true; spec.key.castShadow = cast;
        for (const m of mats) m.needsUpdate = true;      // back to the cached shadowed programs on the next render
        st.dirty = true; st.shadowDirty = true;
      }
      return true;
    },
    setReducedMotion(on) {
      st.reduced = !!on;
      rig.setReducedMotion(st.reduced);
      cells.setReducedMotion(st.reduced);
      post.setReducedMotion(st.reduced);
      labels?.setStill(st.reduced);
      if (st.reduced) { st.explodeS = st.exploded ? EXPLODE_MAX : 0; cells.snap(); }
      touch(200);
    },

    frameStats() {
      let n = 0, sum = 0;
      for (let k = 0; k < tCount; k++) { const v = times[(tHead - 1 - k + 240) % 240]; scratch[n++] = v; sum += v; }
      const arr = scratch.subarray(0, n).sort();
      return {
        fps: n ? 1000 / (sum / n) : 0,
        p90ms: n ? arr[Math.min(n - 1, Math.floor(0.9 * n))] : 0,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        cpuMs: st.cpuMs,
        samples: n,
      };
    },
    resetFrameStats() { tCount = 0; tHead = 0; st.lastRenderT = 0; },

    needsRender() {
      if (st.dirty || st.animating) return true;
      const now = performance.now();
      // the callouts may ask for one more update with nothing else moving (a layout chosen afresh once the view
      // has settled, or an upgrade that has waited its time): labels.js says when
      return now < st.busyUntil || (labels !== null && now >= labels.wake[0]);
    },

    render(dtSec = 1 / 60, nowMs = performance.now()) {
      const t0 = performance.now();
      const dt = MathUtils.clamp(dtSec || 0, 0, 0.25);
      if (st.lastRenderT > 0) {
        const iv = nowMs - st.lastRenderT;
        if (iv > 0 && iv < 250) { times[tHead] = iv; tHead = (tHead + 1) % 240; tCount = Math.min(240, tCount + 1); }
      }
      st.lastRenderT = nowMs;
      renderer.info.reset();

      // view offset toward the HUD-free region's centre
      let offMoving = false;
      if (viewOff.x !== viewOff.tx || viewOff.y !== viewOff.ty) {
        const k = st.reduced ? 1 : 1 - Math.exp(-dt / 0.3);
        viewOff.x += (viewOff.tx - viewOff.x) * k; viewOff.y += (viewOff.ty - viewOff.y) * k;
        if (Math.abs(viewOff.tx - viewOff.x) < 0.2 && Math.abs(viewOff.ty - viewOff.y) < 0.2) { viewOff.x = viewOff.tx; viewOff.y = viewOff.ty; }
        else offMoving = true;
        applyViewOffset();
      }

      // display geometry toward the latest stats (before the camera: the rig frames the eased organism)
      const geoMoving = geoStep(dt);
      const gx = geo.x[0], gz = geo.x[1], gr = geo.x[2], gh = geo.x[3];

      // camera
      const rigMoving = rig.update(dt);
      // Zoom-out cap: the map's narrow lens needs more distance (Apart from above on a phone, up to the rig's 1600).
      // It drops back only as the camera comes in, so leaving the map is never clamped in one jump.
      const capWant = rig.preset === 'map' ? MAX_DIST_MAP : MAX_DIST;
      if (controls.maxDistance !== capWant) {
        controls.maxDistance = capWant > controls.maxDistance ? capWant
          : Math.max(capWant, Math.min(controls.maxDistance, camera.position.distanceTo(controls.target) + 1));
      }
      const ctrlMoving = rig.userControlled ? controls.update(dt) : (controls.update(dt), false);
      const t = controls.target;
      const tx = MathUtils.clamp(t.x, -110, 110), ty = MathUtils.clamp(t.y, -5, 60), tz = MathUtils.clamp(t.z, -110, 110);
      if (tx !== t.x || ty !== t.y || tz !== t.z) { v3b.set(tx - t.x, ty - t.y, tz - t.z); t.add(v3b); camera.position.add(v3b); }

      // the map mix, before anything reads it (a cut under reduced motion drew one frame of the agar's halo)
      const flatTarget = rig.preset === 'map' ? 1 : 0;
      const flatMoving = st.flat !== flatTarget;
      if (flatMoving) {
        const step = st.reduced ? 1 : dt / 0.6;
        st.flat = st.flat < flatTarget ? Math.min(flatTarget, st.flat + step) : Math.max(flatTarget, st.flat - step);
      }

      // Apart flight clock and plates
      const exTarget = st.exploded ? EXPLODE_MAX : 0;
      const exMoving = st.explodeS !== exTarget;
      if (exMoving) {
        const step = st.reduced ? EXPLODE_MAX : EXPLODE_RATE * dt;
        st.explodeS = st.explodeS < exTarget ? Math.min(exTarget, st.explodeS + step) : Math.max(exTarget, st.explodeS - step);
      }
      U.uExplodeS.value = st.explodeS;
      U.uPlateY.value.set(plateY[0], plateY[1], plateY[2], plateY[3]);
      U.uOrg.value.set(gx, gz, gr);
      const plateA = MathUtils.clamp(st.explodeS / 0.5, 0, 1);
      spec.setPlates(plateY, st.plateR, plateA, gx, gz);
      AU.uApart.value = plateA;
      // scale grid: the map and depth views show it across the dish; elsewhere only a faint reticle near the organism
      // (entering the map, the reticle spreads out from the organism instead of appearing across the dish at once)
      const gridAll = Math.max(st.flat, st.viewIdx === 1 ? 1 : 0);
      AU.uGrid.value = MathUtils.lerp(0.013, 0.03, st.flat);
      AU.uGridFade.value.set(gx, gz, MathUtils.lerp(gr + 3, GRID_ALL_R, gridAll), 0.9 * gr + 12);
      AU.uEdgeLine.value = 0.05 * gridAll;
      AU.uHaloAmt.value = 0.17 * (1 - st.flat) * (st.viewIdx === 0 ? 1 : 0.5) * (1 - 0.7 * plateA);
      AU.uBaseTint.value = 0.06 * (1 - 0.85 * plateA);

      // relief: ease the dome thickness toward its target
      let domeMoving = false;
      if (st.domeD !== st.domeTarget) {
        const k = st.reduced ? 1 : 1 - Math.exp(-dt / 0.8);
        st.domeD += (st.domeTarget - st.domeD) * k;
        if (Math.abs(st.domeD - st.domeTarget) < 0.01) st.domeD = st.domeTarget; else domeMoving = true;
        applyRelief();
        st.shadowDirty = true;
      }

      // map preset: flat columns, unlit legend colours, no glow. Every map term follows st.flat continuously (the
      // glow, the lens in post.setFocus, the agar's grid and halo above): nothing is switched at the midpoint, where
      // the glide from a low pose is still close over the dish.
      U.uFlat.value = st.flat;
      U.uUnlit.value = MathUtils.smoothstep(st.flat, 0.4, 1.0);
      U.uGlowOn.value = st.viewIdx === 0 ? 1 : 0;       // the shader fades the glow with 1 − uFlat
      // lights follow the camera's azimuth (a turntable under fixed studio lights); the key's shadow frustum hugs
      // the organism, or the whole Apart stack
      const az = rig.azimuth();
      const apartR = st.explodeS > 0.02 ? st.plateR + 4 : 0;
      const shR = Math.max(gr + 8, apartR);
      if (spec.aimLights(az, gx, gz, shR, st.explodeS > 0.02 ? plateY[0] + 8 : gh + 4)) st.shadowDirty = true;
      camera.updateMatrixWorld();
      U.uKeyDirV.value.copy(spec.keyDir).transformDirection(camera.matrixWorldInverse);
      U.uBackDirV.value.copy(spec.backDir).transformDirection(camera.matrixWorldInverse);
      U.uUpV.value.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);

      if (Math.abs(MathUtils.euclideanModulo(rig.azimuth() - st.anchorAz + Math.PI, 2 * Math.PI) - Math.PI) > 15 * DEG) { computeAnchors(); updateNotes(); }
      if (exMoving) updateNotes();
      else if (st.explodeS >= EXPLODE_MAX && (geoMoving || rigMoving || ctrlMoving)) placePlateNotes(false);   // callouts ride the plates

      // display pass, motes, set, shadows, post
      cells.updateDisplay(renderer, dt);
      cells.updateTransients(dt);
      motes.update(st.lastTick, st.clock.visRel, st.flat, st.explodeS > 0.02);
      renderer.getDrawingBufferSize(bufSize);
      // haze: just above the dish's far rim, behind the organism
      v3c.set(camera.position.x - gx, 0, camera.position.z - gz).normalize();
      v3.set(gx - v3c.x * 100, 10, gz - v3c.z * 100).project(camera);
      spec.update(camera, bufSize.y, v3.x * 0.5 + 0.5, MathUtils.clamp(v3.y * 0.5 + 0.5, -0.5, 1.5));
      const el = rig.elevation();
      // The dish wall mirrors the illuminator ring in narrow bands of camera pose, and the dish is round, so the whole
      // wall lights up at once: a glide through such a band (a few degrees of elevation, or the dolly between two
      // presets) pulsed the frame by 10–40%, and on a large organism the Close pose sits right at the edge of one, so
      // the pulse came in the glide's first 0.15 s, while it was still slow. A glint swept that fast would smear across
      // a real camera's frame, so the glass's reflection is held down for the whole of every eased glide (preset, frame,
      // Apart), from its first frame: gone within GLIDE_DIM_IN, back over GLIDE_DIM_OUT once the camera has arrived.
      // User orbits scale it by 1 / (1 + (tilt rate / TILT_GLINT)²). At rest and under the turntable (which only
      // turns the round dish) it is unchanged. Cuts (reduced motion) sweep nothing and keep it.
      const dEl = Math.abs(el - st.tiltEl);
      st.tiltEl = el;
      const tiltRate = !st.reduced && dt > 0 && dEl < 30 * DEG ? dEl / dt : 0;   // a cut sweeps nothing
      st.tilt += (tiltRate - st.tilt) * (1 - Math.exp(-dt / (tiltRate > st.tilt ? 0.03 : 0.15)));
      if (st.tilt < 0.01) st.tilt = 0;                                      // the glass is back to 99.95 %
      if (rig.gliding && !st.reduced) st.glide = Math.min(1, st.glide + dt / GLIDE_DIM_IN);
      else if (st.glide > 0) st.glide = st.reduced ? 0 : Math.max(0, st.glide - dt / GLIDE_DIM_OUT);
      const glintMoving = st.tilt > 0 || st.glide > 0;
      const held = st.glide * st.glide * (3 - 2 * st.glide);
      spec.setGlassGlint((1 - held) / (1 + (st.tilt / TILT_GLINT) ** 2));
      // the objective is only ever seen melted by the depth of field: without DOF (Low) it stays out of the picture
      spec.setObjectiveFade(tier.dof ? (1 - MathUtils.smoothstep(el, 55 * DEG, 64 * DEG)) * (1 - plateA) : 0);
      spec.lip.visible = !!tier.dof;                 // the lit lip is drawn to be melted into a soft arc, likewise
      if (renderer.shadowMap.enabled) {
        // relief moves while the display EMA settles and during flights; Medium refreshes every other render
        const want = st.shadowDirty || nowMs < st.busyUntil || exMoving || flatMoving;
        renderer.shadowMap.needsUpdate = want && (tier.shadowEvery <= 1 || st.renders % tier.shadowEvery === 0);
        // a resized (disposed) shadow map is recreated at once: skipping it would leave the shadow samplers with no
        // depth texture for a frame (GL "mismatch between texture format and sampler type" on a tier change)
        if (spec.key.castShadow && !spec.key.shadow.map) renderer.shadowMap.needsUpdate = true;
        if (renderer.shadowMap.needsUpdate) st.shadowDirty = false;
      }

      // depth of field focus: the pinned cell, else the organism (or the middle of the Apart stack)
      const apartF = st.explodeS / EXPLODE_MAX;
      if (st.pinned >= 0 && cells.cell[4 * st.pinned]) cellTopWorld(st.pinned, v3);
      else v3.set(gx, MathUtils.lerp(0.4 * gh, 0.5 * (plateY[0] + plateY[3]), apartF), gz);
      v3.applyMatrix4(camera.matrixWorldInverse);
      const fd = -v3.z;
      const focusMoving = Math.abs(st.focusDist - fd) > 0.05 * Math.max(1, fd * 0.01);
      st.focusDist = st.focusDist === 0 ? fd : st.focusDist + (fd - st.focusDist) * (1 - Math.exp(-dt / 0.15));
      // The in-focus volume always contains every cell: it widens and rises with the flight, as far as the first
      // cells have flown (no cell is higher than eeFly(stagger clock) of the way to its plate). A switch at
      // explodeS > 0 would jump on a flight's first and last frame: on the last, the objective has faded back in
      // (opaque, in the depth buffer) while the volume still reached the top plate, so it rendered sharp for a frame.
      const reach = flightReach(st.explodeS);
      const range = 1.02 * gr + 3 + reach * (plateY[0] - plateY[3]) * 0.6;
      const topY = MathUtils.lerp(gh + 4, plateY[0] + 6, reach);
      post.setFocus(camera, st.focusDist, range, topY, st.flat);
      post.render(dt);

      if (labels) {
        // the organism's screen ellipse: labels keep off it (not in Apart, where plates carry the labels)
        let avoid = null;
        if (st.explodeS < 0.02) {
          v3.set(gx, 0.5 * gh, gz).project(camera);
          const ax = (v3.x * 0.5 + 0.5) * st.width, ay = (0.5 - v3.y * 0.5) * st.height;
          let rx = 0, ry = 0;
          for (let k = 0; k < 5; k++) {                // four rim points and the dome's top
            const a = (k * Math.PI) / 2, r = k < 4 ? gr : 0;
            v3.set(gx + Math.cos(a) * r, k === 4 ? gh + 0.5 : k % 2 ? 0 : 0.5 * gh, gz + Math.sin(a) * r).project(camera);
            rx = Math.max(rx, Math.abs((v3.x * 0.5 + 0.5) * st.width - ax));
            ry = Math.max(ry, Math.abs((0.5 - v3.y * 0.5) * st.height - ay));
          }
          // padded: rMax is measured at cell centres, the silhouette also shows column sides and caps
          avoidBox.x = ax; avoidBox.y = ay; avoidBox.rx = 1.05 * rx + 6; avoidBox.ry = 1.05 * Math.max(ry, 0.35 * rx) + 6;
          avoid = avoidBox;
        }
        const nEll = st.explodeS >= 0.9 * EXPLODE_MAX ? platesOnScreen() : 0;
        labels.update(camera, st.width, st.height, avoid, plateEll, nEll);
      }

      st.renders++;
      st.dirty = false;
      st.animating = rigMoving || ctrlMoving || exMoving || geoMoving || flatMoving || focusMoving || offMoving || domeMoving
        || glintMoving;
      st.cpuMs += (performance.now() - t0 - st.cpuMs) * 0.1;          // running average of JS time per render
    },

    resize,

    dispose() {
      controls.dispose();
      labels?.dispose();
      post.dispose();
      cells.dispose();
      motes.dispose();
      spec.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
    },

    /** Dev/QA access (harness, perf probes). Not part of the contract. */
    _debug: { renderer, scene, camera, controls, cells, spec, post, rig, labels, st, avoidBox, viewOff, hud },
  };

  // Programs are keyed by their output: the scene is drawn into the post chain's linear, un-tone-mapped target, so
  // it is compiled with that target bound (compiled against the canvas, every program would be a variant the first
  // render cannot use, and that render would compile them all again, synchronously).
  function compileScene(async) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(post.sceneRT);
    try { return async ? renderer.compileAsync(scene, camera) : renderer.compile(scene, camera); }
    finally { renderer.setRenderTarget(prev); }
  }

  applyView();
  applyRelief();
  resize();
  await compileScene(true);
  return stage;
}
