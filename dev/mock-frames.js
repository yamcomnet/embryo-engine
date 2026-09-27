// dev/mock-frames.js: deterministic synthetic frames, stats, milestones and cell details for Embryo Engine v1.0.
//
// Lets the scene [S], UI [U] and worker [W] teams build against the real message shapes before src/engine.js
// lands. Imports only ../src/shared.js; no DOM, no Node APIs, no Math.random. Works in browsers, module
// workers and node >= 20. The same arguments always produce the same bytes.
//
// ─── API ──────────────────────────────────────────────────────────────────────────────────────────────
// MOCK_PARAMS, MOCK_FIELD_INFO, MOCK_ENGINE_VERSION
//   Stand-ins for the engine's PARAMS / FIELD_INFO / ENGINE_VERSION (ADDENDUM §A.2). Deep-frozen.
//
// makeMockFrame({ cells = 10000, tick, seed = 1, prev = null, id = 1,
//                 running = true, morph = true, series = true, buffers = null } = {}) → frame message
//   The exact 'frame' message of SPEC §3.3 as amended by ADDENDUM §B:
//   { type:'frame', id, tick, prevTick, running, viewing:null, cell, life, idx, idxCount, morph, events,
//     eventCount, eventsDropped, stats, series }
//   • Without `prev`, it builds an organism of exactly `cells` live cells (clamped to 1..25000) at `tick`
//     (default 5000): a disc centred on (100,100) with exterior depth, relative bands, all 7 types, a few interior
//     gaps and ghosts. prevTick = tick − 1, and `events` holds ~1% births, deaths and fates stamped at `tick`.
//     tick 0 gives the seed ball: all stem, no events, prevTick 0 (use cells: 37).
//   • With `prev` (a frame from this module), it advances that organism to `tick` (default prev.tick + 1). About 1%
//     of cells die (mostly the oldest), a matching number are born (first into older interior gaps, then at the
//     rim nearest the centroid, so the disc grows slowly), and about 1% change fate by the v1.0 rules (maturing
//     stem, relative-band re-specification, MESO → MUSCLE/VESSEL by the relative activator gate). Events are
//     coherent with prev: BIRTH daughters were empty in prev, DEATH cells were alive, FATE `from` = prev type.
//     Energy is conserved exactly (Float64, Σ = 250000). Chains are linear. The hidden per-cell state (exact
//     energy, provenance) lives in a private model that survives transferring the frame's buffers, so
//     `prev` may have detached buffers. Branching from an older frame rebuilds from its textures, with
//     approximate provenance.
//   • `buffers` { cell, life, idx, events, morph } lets a mock worker reuse acked buffers (wrong sizes are ignored).
//   • `morph: false` sends morph = null (as the worker does between field updates). `series: false` sends null.
//
// makeMockStats(frame, { params = MOCK_PARAMS } = {}) → Stats (ADDENDUM §B.2; every field populated)
// makeMockMilestones(tick) → AppState.milestones: [{ key, label, awaiting, tick|null, snapId|null, thumb:null }]
// makeMockThumbTypes(frame) → Uint8Array(128*128) of TYPE, the SPEC §3.3 thumb rule (square centred on (cx,cy),
//                             side clamp(2·rMax + 16, 24, 200), nearest neighbour, toroidal wrap, row-major, y down)
// makeMockCellDetail(frame, idx) → CellDetail (ADDENDUM §A.2) or null for empty/out-of-range cells
// makeMockReady({ seed = 1 } = {}) → the worker's 'ready' message
// mockTransferList(frame) → ArrayBuffer[] for postMessage(frame, list)
//
// Notes: `series` = { births, deaths: Uint16Array(600), head }, a per-tick ring; the count for tick T is at
// index T % 600, and head = (tick + 1) % 600 is the oldest slot. FIELD_INFO is ordered by channel. Milestones
// follow a fixed, plausible timeline (MOCK_MILESTONE_TICKS) and not the organism's actual counts.
// PARAMS.senescence and .hysteresis/.kinetics sub-keys are guesses until src/engine.js publishes its own.

import {
  GRID, N, DX, DY, TYPE, RULE_FATE_OF_BAND, FAMILY_OF_TYPE, EV, EV_WORDS, MAX_EVENTS_PER_FRAME,
  MSG, MILESTONES, encodeEnergy, decodeEnergy,
} from '../src/shared.js';

export const MOCK_ENGINE_VERSION = '1.0.0-mock';

const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };

export const MOCK_PARAMS = deepFreeze({
  totalEnergy: 250000, divThreshStem: 30, divThreshDiff: 42, divCooldown: 14, diffAge: 12, shareRate: 0.05,
  senescence: 500,
  bandFrac: { ecto: 0.15, meso: 0.30, endo: 0.85 },
  bandMin: { ecto: 1, meso: 2, endo: 6 },
  hysteresis: { depth: 1, ticks: 24 },
  gates: { neuralMid: 0.18, neuralAP: 0.18, muscleRel: 1.2, vesselRel: 0.8, mesoSpecializeAge: 40 },
  diffusion: { rates: [0.03, 0.325, 0.234, 0.208], decay: 0.96, substeps: [1, 2, 1, 1] },
  kinetics: { rho: 0.01, saturation: 0.02, basal: 0.0005, epsilon: 0.001, inhProd: 0.01, inhDecay: 0.02, noise: 0.02, clamp: 8 },
});

// One entry per morph channel (index = channel). Activator gates sit at 0.8× / 1.2× this mock's tissue mean (~0.52);
// the engine's real gates are relative to the live mean (stats.signals.meanAct).
export const MOCK_FIELD_INFO = deepFreeze([
  { key: 'activator', channel: 0, domain: [0, 2.4], scale: 'sqrt', gates: [{ v: 0.41, label: 'vessel below 0.8× mean' }, { v: 0.62, label: 'muscle above 1.2× mean' }] },
  { key: 'inhibitor', channel: 1, domain: [0, 3], scale: 'sqrt', gates: [] },
  { key: 'midline', channel: 2, domain: [0, 0.4], scale: 'linear', gates: [{ v: 0.18, label: 'neural gate' }] },
  { key: 'ap', channel: 3, domain: [0, 0.6], scale: 'linear', gates: [{ v: 0.18, label: 'neural gate' }] },
]);

// Fixed mock timeline, loosely from the audit's allfix_rel runs (5 seeds).
export const MOCK_MILESTONE_TICKS = Object.freeze({
  seed: 0, firstFates: 14, layers: 212, muscle: 380, neural: 640, founders: 1180, endoCore: 1600, turnover: 2380,
});

// ─── constants ───────────────────────────────────────────────────────────────────────────────────────
const { STEM, ECTO, MESO, ENDO, NEURAL, MUSCLE, VESSEL } = TYPE;
const SEED_COUNT = 37;
const WIN = 200;                 // stats.win.W
const RING = 600;                // per-tick history length (= series length)
const MAX_CELLS = 25000;         // keeps the disc (r ≈ 89) clear of the torus seam
const TPS_TARGET = 60;
const THUMB = 128;
const NO_EVENT = -(1 << 30);     // evTick sentinel
const RATE = { birth: 0.0105, death: 0.0095, fate: 0.01, growth: 0.0002 };   // per frame, as a fraction of live cells
const LIFE_MULT = [0, 0.6, 1.3, 0.9, 1.4, 2.5, 1.6, 1.8];      // lifespan multipliers per type (v0.9)
const LIFE_SPREAD = 150;
const SPOT_WAVELENGTH = 9;       // Turing spot spacing, cells
const N_SEGMENTS = 16;           // angular muscle blocks around the mesoderm ring
const CAUSE = { age: 0, isolated: 1, tip: 2, crowded: 3 };
const OPP = [1, 0, 3, 2];        // opposite direction of d
const TWO_PI = Math.PI * 2;
const S3 = Math.sqrt(3) / 2;

// Composition over time (audit allfix_rel means): [tick, cells, stem, ecto, meso, endo, neural, muscle, vessel].
const COMPOSITION = [
  [0, 37, 1, 0, 0, 0, 0, 0, 0],
  [14, 38, 0.79, 0.13, 0.03, 0.05, 0, 0, 0],
  [30, 51, 0.373, 0.373, 0.078, 0.176, 0, 0, 0],
  [100, 93, 0.129, 0.258, 0.14, 0.398, 0, 0.021, 0.054],
  [200, 211, 0.114, 0.256, 0.076, 0.313, 0, 0.009, 0.232],
  [300, 365, 0.065, 0.235, 0.03, 0.18, 0, 0.007, 0.483],
  [500, 818, 0.046, 0.253, 0.003, 0.072, 0, 0.108, 0.518],
  [1000, 1693, 0.021, 0.194, 0, 0.029, 0.091, 0.15, 0.515],
  [2000, 2706, 0.032, 0.19, 0.005, 0.302, 0.118, 0.145, 0.208],
  [5000, 4342, 0.032, 0.21, 0.014, 0.43, 0.08, 0.05, 0.184],
  [20000, 6899, 0.036, 0.203, 0.019, 0.47, 0.045, 0.026, 0.201],
];

// Toroidal neighbour table: NB[4i + d] = idx of (x + DX[d], y + DY[d]).
const NB = new Int32Array(4 * N);
for (let i = 0; i < N; i++) {
  const x = i % GRID, y = (i / GRID) | 0;
  for (let d = 0; d < 4; d++) NB[4 * i + d] = ((y + DY[d] + GRID) % GRID) * GRID + ((x + DX[d] + GRID) % GRID);
}
const SIN = new Float64Array(GRID), COS = new Float64Array(GRID);
for (let k = 0; k < GRID; k++) { SIN[k] = Math.sin((TWO_PI * k) / GRID); COS[k] = Math.cos((TWO_PI * k) / GRID); }

// ─── small helpers ───────────────────────────────────────────────────────────────────────────────────
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const wrapDelta = (d) => (d > GRID / 2 ? d - GRID : d < -GRID / 2 ? d + GRID : d);   // shortest toroidal offset

// Stateless 32-bit hash → [0, 1).
function hash(a, b, c = 0) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca77) ^ Math.imul((c | 0) + 0x165667b1, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Partial Fisher–Yates: moves `k` random picks from list[0..len) to the front; returns how many.
function pick(list, len, k, rng) {
  const n = Math.min(k, len);
  for (let j = 0; j < n; j++) {
    const r = j + Math.floor(rng() * (len - j));
    const t = list[j]; list[j] = list[r]; list[r] = t;
  }
  return n;
}
function lifespan(type, i, salt, params = MOCK_PARAMS) {
  return Math.max(60, Math.round(params.senescence * LIFE_MULT[type] + (hash(i, salt, 41) - 0.5) * LIFE_SPREAD));
}
function founderSector(m, i) {   // lineage wedges: the descendants of each founder fan out as a sector
  const dx = wrapDelta((i % GRID) - m.cx), dy = wrapDelta(((i / GRID) | 0) - m.cy);
  const a = (Math.atan2(dy, dx) + Math.PI) / TWO_PI + 0.04 * Math.sin(0.35 * Math.hypot(dx, dy));
  return Math.floor(((a % 1) + 1) % 1 * SEED_COUNT) % SEED_COUNT;
}
function compositionAt(tick) {
  let k = 0;
  while (k < COMPOSITION.length - 2 && COMPOSITION[k + 1][0] <= tick) k++;
  const a = COMPOSITION[k], b = COMPOSITION[k + 1];
  const f = clamp01((tick - a[0]) / (b[0] - a[0]));
  const cells = Math.round(a[1] + (b[1] - a[1]) * f);
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  let sum = 0;
  for (let t = 2; t <= 7; t++) { counts[t] = Math.round(cells * (a[t + 1] + (b[t + 1] - a[t + 1]) * f)); sum += counts[t]; }
  counts[STEM] = Math.max(0, cells - sum);
  return counts;
}

// ─── model: the hidden full state behind a chain of frames ───────────────────────────────────────────
const MODELS = new WeakMap();   // frame → { m, serial }

function createModel(seed) {
  const ring = () => new Float64Array(RING);
  return {
    seed, tick: 0, serial: 0, cellCount: 0,
    type: new Uint8Array(N), energy: new Float64Array(N), age: new Uint16Array(N), maxAge: new Uint16Array(N),
    depth: new Uint8Array(N), band: new Uint8Array(N), ext: new Uint8Array(N),
    bornTick: new Uint32Array(N), founder: new Uint8Array(N).fill(255), fateTick: new Uint32Array(N),
    fateFrom: new Uint8Array(N), typeSince: new Uint32Array(N),
    evTick: new Int32Array(N).fill(NO_EVENT), evKind: new Uint8Array(N), evDir: new Uint8Array(N), evPrev: new Uint8Array(N),
    morph: new Float32Array(4 * N),
    queue: new Int32Array(N), list: new Int32Array(N), mark: new Uint8Array(N),   // scratch
    dmax: 0, e1: 1, e2: 2, e3: 6, cx: GRID / 2, cy: GRID / 2, rMax: 0, meanAct: 0, pool: 0, frameStart: 0,
    events: new Int32Array(EV_WORDS * MAX_EVENTS_PER_FRAME), eventCount: 0, eventsDropped: 0,
    totals: { births: 0, deaths: 0, fates: 0 },
    hist: {
      tick: new Int32Array(RING).fill(-1), births: ring(), deaths: ring(), fates: ring(), recycled: ring(),
      reSpec: ring(), stemF: ring(), rim: ring(), cause: [ring(), ring(), ring(), ring()], fatesTo: Array.from({ length: 8 }, ring),
    },
  };
}

// History ring: one slot per tick.
const slotOf = (t) => ((t % RING) + RING) % RING;
// An empty torus 4-neighbour (Rule 1's room to divide).
function roomAt(type, i) {
  const x = i % GRID, y = (i / GRID) | 0;
  return type[y * GRID + (x + 1) % GRID] === 0 || type[y * GRID + (x + GRID - 1) % GRID] === 0
    || type[((y + 1) % GRID) * GRID + x] === 0 || type[((y + GRID - 1) % GRID) * GRID + x] === 0;
}
function touch(h, t) {
  const s = slotOf(t);
  if (h.tick[s] !== t) {
    h.tick[s] = t;
    h.births[s] = h.deaths[s] = h.fates[s] = h.recycled[s] = h.reSpec[s] = h.stemF[s] = h.rim[s] = 0;
    for (const a of h.cause) a[s] = 0;
    for (const a of h.fatesTo) a[s] = 0;
  }
  return s;
}
function winSum(h, arr, tick, w) {
  let s = 0;
  for (let t = Math.max(0, tick - w + 1); t <= tick; t++) { const k = slotOf(t); if (h.tick[k] === t) s += arr[k]; }
  return s;
}

function pushEvent(m, kind, idx, t, a, b) {
  if (m.eventCount >= MAX_EVENTS_PER_FRAME) { m.eventsDropped++; return; }
  const o = m.eventCount++ * EV_WORDS;
  m.events[o] = kind | (idx << 8); m.events[o + 1] = t; m.events[o + 2] = a; m.events[o + 3] = b;
}

// Exterior flood fill (empty cells connected to the grid border) + BFS depth through live cells, then bands.
function computeDepth(m, params = MOCK_PARAMS) {
  const { type, depth, band, ext, queue } = m;
  ext.fill(0); depth.fill(0); band.fill(0);
  let head = 0, tail = 0;
  for (let k = 0; k < GRID; k++) {
    for (let e = 0; e < 4; e++) {
      const i = e === 0 ? k : e === 1 ? (GRID - 1) * GRID + k : e === 2 ? k * GRID : k * GRID + GRID - 1;
      if (!type[i] && !ext[i]) { ext[i] = 1; queue[tail++] = i; }
    }
  }
  while (head < tail) {
    const i = queue[head++];
    for (let d = 0; d < 4; d++) { const j = NB[4 * i + d]; if (!type[j] && !ext[j]) { ext[j] = 1; queue[tail++] = j; } }
  }
  head = tail = 0;
  for (let i = 0; i < N; i++) {
    if (!type[i]) { depth[i] = ext[i] ? 0 : 255; continue; }
    for (let d = 0; d < 4; d++) if (ext[NB[4 * i + d]]) { depth[i] = 1; queue[tail++] = i; break; }
  }
  let dmax = 0;
  while (head < tail) {
    const i = queue[head++], di = depth[i];
    if (di > dmax) dmax = di;
    for (let d = 0; d < 4; d++) {
      const j = NB[4 * i + d];
      if (type[j] && !depth[j]) { depth[j] = Math.min(254, di + 1); queue[tail++] = j; }
    }
  }
  dmax = Math.max(1, dmax);
  const { bandFrac: f, bandMin: b } = params;
  m.dmax = dmax;
  m.e1 = Math.max(b.ecto, Math.round(f.ecto * dmax));
  m.e2 = Math.max(b.meso, Math.round(f.meso * dmax));
  m.e3 = Math.max(b.endo, Math.ceil(f.endo * dmax));
  let n = 0;
  for (let i = 0; i < N; i++) {
    if (!type[i]) continue;
    n++;
    if (!depth[i]) depth[i] = dmax;   // enclosed by gaps only (rare): treat as core
    band[i] = bandOf(m, depth[i]);
  }
  m.cellCount = n;
}
const bandOf = (m, d) => (d <= m.e1 ? 1 : d <= m.e2 ? 2 : d < m.e3 ? 3 : 4);

// Toroidal-safe centroid (circular mean) and rMax.
function computeGeom(m) {
  let sx = 0, cxs = 0, sy = 0, cys = 0, n = 0;
  for (let i = 0; i < N; i++) {
    if (!m.type[i]) continue;
    const x = i % GRID, y = (i / GRID) | 0;
    sx += SIN[x]; cxs += COS[x]; sy += SIN[y]; cys += COS[y]; n++;
  }
  if (!n) { m.cx = m.cy = GRID / 2; m.rMax = 0; return; }
  const toGrid = (s, c) => { const v = (Math.atan2(s, c) / TWO_PI) * GRID; return ((v % GRID) + GRID) % GRID; };
  m.cx = toGrid(sx, cxs); m.cy = toGrid(sy, cys);
  let r2 = 0;
  for (let i = 0; i < N; i++) {
    if (!m.type[i]) continue;
    const dx = wrapDelta((i % GRID) - m.cx), dy = wrapDelta(((i / GRID) | 0) - m.cy);
    if (dx * dx + dy * dy > r2) r2 = dx * dx + dy * dy;
  }
  m.rMax = Math.sqrt(r2);
}

// Morphogen fields, all synthetic but shaped like v1.0's:
//  activator: hexagonal Turing spots; in the mesoderm band an angular block pattern relative to the tissue mean
//             (so the MUSCLE/VESSEL relative gates carve somite-like blocks); inhibitor: a smoother version;
//  midline:   gaussian across x at cx; A–P: rises toward −y (anterior). Fields fade over ~4 cells outside the tissue.
function computeFields(m) {
  const { morph, type, band, cx, cy, seed } = m;
  morph.fill(0);
  const R = Math.max(3, m.rMax), reach = R + 28;
  const k = TWO_PI / SPOT_WAVELENGTH, ph = m.tick * 0.0015 + hash(seed, 7, 7) * TWO_PI;
  const ox = hash(seed, 1, 9) * 50, oy = hash(seed, 2, 9) * 50;
  const sigma = Math.max(3, 0.56 * R), inv2s2 = 1 / (2 * sigma * sigma);
  const segPhase = hash(seed, 3, 9) * TWO_PI;
  let sumBase = 0, nBase = 0;
  for (let i = 0; i < N; i++) {                       // pass 1: base spots, inhibitor, midline, A–P
    const x = i % GRID, y = (i / GRID) | 0;
    const dx = wrapDelta(x - cx), dy = wrapDelta(y - cy), dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > reach) continue;
    const live = type[i] !== 0;
    const mask = live || dist <= R ? 1 : Math.exp(-(dist - R) / 4);
    const px = x + ox, py = y + oy;
    const c = Math.cos(k * px + ph) + Math.cos(k * (-0.5 * px + S3 * py) + ph) + Math.cos(k * (-0.5 * px - S3 * py) + ph);
    const spot = smooth(0.6, 3, c);
    const base = 0.3 + 1.9 * spot;
    if (live && band[i] !== 2) { sumBase += base; nBase++; }
    const o = 4 * i;
    morph[o] = base * mask;
    morph[o + 1] = (0.25 + 1.5 * (0.5 + c / 6)) * mask;
    morph[o + 2] = 0.34 * Math.exp(-dx * dx * inv2s2) * mask;
    const a = clamp01(0.5 - (0.5 * dy) / R);
    morph[o + 3] = 0.52 * a * a * a * mask;
  }
  const m0 = nBase ? sumBase / nBase : 0.8;
  let sumAct = 0;
  for (let i = 0; i < N; i++) {                       // pass 2: mesoderm blocks, inhibitor follows activator
    const o = 4 * i;
    if (morph[o] === 0 && morph[o + 1] === 0) continue;
    const x = i % GRID, y = (i / GRID) | 0;
    const dx = wrapDelta(x - cx), dy = wrapDelta(y - cy), dist = Math.sqrt(dx * dx + dy * dy);
    const live = type[i] !== 0;
    const mask = live || dist <= R ? 1 : Math.exp(-(dist - R) / 4);
    let act = morph[o];
    const w = live ? (band[i] === 2 ? 1 : 0) : smooth(0.64, 0.7, dist / R) * (1 - smooth(0.85, 0.9, dist / R));
    if (w > 0) {
      const spot = clamp01((act / mask - 0.3) / 1.9);
      const q = 0.5 + 0.5 * Math.cos(N_SEGMENTS * Math.atan2(dy, dx) + segPhase);
      const blk = smooth(0.55, 0.9, q);
      const ring = m0 * (0.5 + 1.1 * blk + 0.15 * (spot - 0.3));
      act = (act / mask) * (1 - w) + ring * w;
      act *= mask;
      morph[o] = act;
    }
    morph[o + 1] += 0.3 * act;
    if (live) sumAct += act;
  }
  m.meanAct = m.cellCount ? sumAct / m.cellCount : 0;
}

const neuralZone = (m, i, params = MOCK_PARAMS) =>
  m.morph[4 * i + 2] > params.gates.neuralMid && m.morph[4 * i + 3] > params.gates.neuralAP;
function ruleFate(m, i) {
  const b = m.band[i];
  return b === 1 ? (neuralZone(m, i) ? NEURAL : ECTO) : RULE_FATE_OF_BAND[b];
}

// ─── state changes (each emits its event and keeps energy exactly conserved) ─────────────────────────
function die(m, i, t, cause) {
  const ty = m.type[i], e = m.energy[i];
  m.type[i] = 0; m.energy[i] = 0; m.age[i] = 0; m.band[i] = 0;
  let mask = 0, cnt = 0;
  for (let d = 0; d < 4; d++) if (m.type[NB[4 * i + d]]) { mask |= 1 << d; cnt++; }
  if (cnt) { for (let d = 0; d < 4; d++) if (mask & (1 << d)) m.energy[NB[4 * i + d]] += e / cnt; }
  else { m.pool += e; if (cause === CAUSE.age) cause = CAUSE.isolated; }
  m.evKind[i] = EV.DEATH; m.evTick[i] = t; m.evPrev[i] = ty; m.evDir[i] = 0;
  pushEvent(m, EV.DEATH, i, t, ty | (mask << 4) | (cause << 8), Math.round(e * 1000));
  const s = touch(m.hist, t);
  m.hist.deaths[s]++; m.hist.cause[cause][s]++; m.hist.recycled[s] += e;
  m.totals.deaths++; m.cellCount--;
}
function birth(m, q, d, t, rim) {
  const p = NB[4 * q + OPP[d]];   // daughter q = parent p + (DX[d], DY[d])
  const e = m.energy[p] * 0.5;
  m.energy[p] = e; m.age[p] = 0;
  m.type[q] = STEM; m.energy[q] = e; m.age[q] = 0; m.maxAge[q] = lifespan(STEM, q, t);
  m.bornTick[q] = t; m.founder[q] = m.founder[p]; m.fateTick[q] = 0; m.fateFrom[q] = 0; m.typeSince[q] = t;
  m.evKind[q] = EV.BIRTH; m.evTick[q] = t; m.evDir[q] = d; m.evPrev[q] = 0;
  pushEvent(m, EV.BIRTH, q, t, p, d);
  const s = touch(m.hist, t);
  m.hist.births[s]++; if (rim) m.hist.rim[s]++;
  m.totals.births++; m.cellCount++;
}
function fate(m, i, to, t) {
  const from = m.type[i];
  m.type[i] = to;
  if (from === STEM) { m.age[i] = 0; m.maxAge[i] = lifespan(to, i, t); }   // only STEM→X resets the clock
  m.fateTick[i] = t; m.fateFrom[i] = from; m.typeSince[i] = t;
  m.evKind[i] = EV.FATE; m.evTick[i] = t; m.evPrev[i] = from; m.evDir[i] = 0;
  pushEvent(m, EV.FATE, i, t, from | (to << 4) | (Math.min(m.depth[i], 255) << 12), m.band[i]);
  const s = touch(m.hist, t);
  m.hist.fates[s]++; m.hist.fatesTo[to][s]++;
  // as the worker counts them: a stem cell's first fate, or a change of germ-layer family (a band crossing)
  if (from === STEM) m.hist.stemF[s]++; else if (FAMILY_OF_TYPE[from] !== FAMILY_OF_TYPE[to]) m.hist.reSpec[s]++;
  m.totals.fates++;
}
function spreadPool(m) {
  if (m.pool <= 0 || !m.cellCount) return;
  const each = m.pool / m.cellCount;
  for (let i = 0; i < N; i++) if (m.type[i]) m.energy[i] += each;
  m.pool = 0;
}
function shareEnergy(m, rate) {   // pairwise exchange with right/down neighbours: conservative to rounding
  const { type, energy } = m;
  for (let i = 0; i < N; i++) {
    if (!type[i]) continue;
    for (let d = 0; d <= 2; d += 2) {
      const j = NB[4 * i + d];
      if (!type[j]) continue;
      const f = rate * (energy[j] - energy[i]);
      energy[i] += f; energy[j] -= f;
    }
  }
}
const liveNeighbours = (m, i) => (m.type[NB[4 * i]] ? 1 : 0) + (m.type[NB[4 * i + 1]] ? 1 : 0) + (m.type[NB[4 * i + 2]] ? 1 : 0) + (m.type[NB[4 * i + 3]] ? 1 : 0);
// Parent for a daughter at empty q: the live, non-newborn neighbour with the most energy that has not divided this tick.
function parentDir(m, q, t, preferDeep) {
  let best = -1, bestScore = -Infinity;
  for (let d = 0; d < 4; d++) {
    const p = NB[4 * q + OPP[d]];
    if (!m.type[p] || m.mark[p] || (m.evTick[p] > m.frameStart && m.evKind[p] === EV.BIRTH)) continue;
    const score = preferDeep ? m.depth[p] * 1000 + m.energy[p] : m.energy[p];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

// ─── building a standalone organism ──────────────────────────────────────────────────────────────────
function buildModel(cells, tick, seed) {
  const m = createModel(seed);
  const P = MOCK_PARAMS;
  m.tick = tick; m.frameStart = tick - 1;
  const n = Math.max(1, Math.min(MAX_CELLS, Math.round(cells)));
  const early = tick < MOCK_MILESTONE_TICKS.firstFates;
  const rng = mulberry32(Math.imul(seed, 0x51ed27) ^ tick ^ 0x3c6ef372);
  const nDeaths = tick > 0 && n >= 60 ? Math.max(1, Math.round(n * RATE.death)) : 0;
  const gapSites = tick > 300 && n >= 400 ? Math.max(2, Math.round(n / 2500)) : 0;
  const body = n + nDeaths + 2 * gapSites;

  // 1. Body: the `body` positions nearest (100,100) under a gently wobbling radius (exact disc at tick 0).
  const R0 = Math.sqrt(body / Math.PI);
  const wob = tick === 0 ? 0 : Math.min(1, R0 / 20);
  const a1 = hash(seed, 1, 21) * TWO_PI, a2 = hash(seed, 2, 21) * TWO_PI;
  const key = new Float64Array(N), cand = [];
  for (let i = 0; i < N; i++) {
    const dx = (i % GRID) - 100, dy = ((i / GRID) | 0) - 100, r = Math.sqrt(dx * dx + dy * dy);
    if (r > R0 + 6) continue;
    const th = Math.atan2(dy, dx);
    key[i] = r + wob * (0.8 * Math.sin(3 * th + a1) + 0.6 * Math.sin(5 * th + a2) + 0.35 * (hash(i, seed, 22) - 0.5)) + i * 1e-9;
    cand.push(i);
  }
  cand.sort((a, b) => key[a] - key[b]);
  for (let k = 0; k < body; k++) m.type[cand[k]] = STEM;

  // 2. Interior gap sites (pairs of cells, older deaths that are still ghosts).
  for (let s = 0, tries = 0; s < gapSites && tries < 500; tries++) {
    const i = cand[Math.floor((0.12 + 0.45 * rng()) * body)];
    const j = NB[4 * i + Math.floor(rng() * 4)];
    if (!m.type[i] || !m.type[j]) continue;
    for (const g of [i, j]) {
      m.type[g] = 0;
      m.evKind[g] = EV.DEATH; m.evTick[g] = tick - 3 - Math.floor(rng() * 22); m.evPrev[g] = rng() < 0.5 ? ENDO : VESSEL;
    }
    s++;
  }

  computeDepth(m); computeGeom(m); computeFields(m);

  // 3. Types by band (Rule 3) with the terminal extras that make a real T5000 organism.
  const { e1, e2 } = m;
  const hasMuscle = tick >= MOCK_MILESTONE_TICKS.muscle, hasNeural = tick >= MOCK_MILESTONE_TICKS.neural;
  const vesselT = MOCK_MILESTONE_TICKS.layers;
  for (let i = 0; i < N; i++) {
    if (!m.type[i]) continue;
    if (early) continue;   // seed-ball era: all stem
    const b = m.band[i], d = m.depth[i], h = hash(i, seed, 31), act = m.morph[4 * i];
    let ty = RULE_FATE_OF_BAND[b];
    if (b === 1) {
      ty = hasNeural && neuralZone(m, i) ? NEURAL : ECTO;
      if (d === 1 && h < 0.05) ty = STEM;                                   // newborn at the rim, not yet mature
    } else if (b === 2) {
      if (hasNeural && d <= e1 + 2 && neuralZone(m, i)) ty = NEURAL;           // terminal, buried as the cap thickens
      else if (d === e1 + 1 && h > 0.93) ty = ECTO;                          // yesterday's skin, about to re-specify
      else if (d === e1 + 1 && h < 0.3) ty = MESO;                           // freshly re-specified
      else if (tick >= vesselT) {
        const rel = act / (m.meanAct || 1);
        ty = hasMuscle && rel > P.gates.muscleRel ? MUSCLE : rel < P.gates.vesselRel ? VESSEL : MESO;
      } else ty = MESO;
    } else if (b === 3) {
      if (tick >= vesselT && d <= e2 + 3 && h < 0.1) ty = VESSEL;          // terminal vessel buried by growth
    }
    m.type[i] = ty;
  }

  // 4. Ages, provenance and energy weights.
  let wSum = 0;
  for (let i = 0; i < N; i++) {
    const ty = m.type[i];
    if (!ty) continue;
    const h1 = hash(i, seed, 32), h2 = hash(i, seed, 33), h3 = hash(i, seed, 34);
    m.maxAge[i] = lifespan(ty, i, 0);
    let age = Math.floor(h1 * 0.97 * m.maxAge[i]);
    const immature = ty === STEM && m.band[i] !== 4;
    if (immature) age = Math.floor(h1 * P.diffAge);   // recently divided stem away from the core
    age = Math.min(age, tick);
    m.age[i] = age;
    m.bornTick[i] = Math.max(1, tick - age - (immature ? 0 : Math.floor(h2 * 150)));
    if (ty === STEM) { m.typeSince[i] = m.bornTick[i]; m.fateTick[i] = 0; m.fateFrom[i] = 0; }
    else {
      let from = STEM, since = tick - age;
      if (ty === MESO) { from = m.depth[i] <= e1 + 1 ? ECTO : STEM; since = tick - Math.floor(h3 * 45); }
      else if (ty === MUSCLE || ty === VESSEL) { from = MESO; since = tick - Math.floor(h3 * Math.min(age + 1, 400)); }
      else if (ty === ENDO && h3 < 0.4) { from = MESO; since = tick - Math.floor(h3 * age); }
      else if (ty === NEURAL && h3 < 0.3) { from = ECTO; since = tick - Math.floor(h3 * age); }
      else if (ty === ECTO && m.band[i] === 2) { from = STEM; }
      since = Math.min(tick, Math.max(m.bornTick[i], since));
      m.typeSince[i] = since; m.fateTick[i] = since; m.fateFrom[i] = from;
    }
    m.founder[i] = founderSector(m, i);
    const w = tick === 0 ? 1 : 0.6 + 0.8 * hash(i, seed, 35) + (ty === STEM ? 0.5 : 0) + (ty === MESO || ty === MUSCLE ? 0.2 : 0);
    m.energy[i] = w; wSum += w;
  }
  const scale = P.totalEnergy / wSum;
  for (let i = 0; i < N; i++) if (m.type[i]) m.energy[i] *= scale;

  // 5. Founders still alive: the stem cells nearest the centroid (all 37 at tick 0).
  const nFounders = tick === 0 ? Math.min(SEED_COUNT, n) : Math.max(0, Math.round(SEED_COUNT * (1 - tick / MOCK_MILESTONE_TICKS.founders)));
  if (nFounders) {
    const core = cand.slice(0, body).filter((i) => m.type[i] === STEM).slice(0, nFounders);
    core.forEach((i, k) => { m.bornTick[i] = 0; m.founder[i] = k; if (tick === 0) m.age[i] = 0; });
  }

  if (tick > 0) standaloneEvents(m, n, nDeaths, rng);
  computeDepth(m); computeGeom(m); computeFields(m);
  // FATE events report the depth/band of the state this frame shows.
  for (let k = 0; k < m.eventCount; k++) {
    const o = k * EV_WORDS;
    if ((m.events[o] & 0xff) !== EV.FATE) continue;
    const i = m.events[o] >> 8;
    m.events[o + 2] = (m.events[o + 2] & 0xfff) | (Math.min(m.depth[i], 255) << 12);
    m.events[o + 3] = m.band[i];
  }
  fillHistory(m, tick, n);
  return m;
}

// ~1% deaths, births and fates, all stamped at m.tick, consistent with the state they leave behind.
function standaloneEvents(m, n, nDeaths, rng) {
  const t = m.tick, { list, mark } = m;
  mark.fill(0);
  // Deaths: ~35% at the rim (tip or age), the rest old interior cells. Afterwards `n` cells remain.
  let len = 0;
  for (let i = 0; i < N; i++) if (m.type[i] && m.depth[i] === 1 && m.bornTick[i] !== 0) list[len++] = i;
  const rimD = pick(list, len, Math.round(nDeaths * 0.35), rng);
  for (let k = 0; k < rimD; k++) mark[list[k]] = 2;
  len = 0;
  for (let i = 0; i < N; i++) if (m.type[i] && !mark[i] && m.bornTick[i] !== 0 && (m.band[i] === 2 || m.band[i] === 3)) list[len++] = i;
  const inD = pick(list, len, nDeaths - rimD, rng);
  for (let k = 0; k < inD; k++) mark[list[k]] = 2;
  for (let i = 0; i < N; i++) {
    if (mark[i] !== 2) continue;
    const cause = m.depth[i] === 1 && liveNeighbours(m, i) === 1 ? CAUSE.tip : CAUSE.age;
    die(m, i, t, cause);
  }
  spreadPool(m);
  mark.fill(0);

  // Births: rim cells become newborn stem daughters of an inner neighbour (which just divided).
  const nBirths = Math.max(1, Math.round(n * RATE.birth));
  len = 0;
  for (let i = 0; i < N; i++) if (m.type[i] && m.depth[i] === 1 && m.bornTick[i] !== 0) list[len++] = i;
  pick(list, len, len, rng);
  let born = 0;
  for (let k = 0; k < len && born < nBirths; k++) {
    const q = list[k];
    if (mark[q]) continue;
    const e = m.energy[q], was = m.type[q];
    m.type[q] = 0;                                   // treat the slot as empty for the parent search
    const d = parentDir(m, q, t, true);
    if (d < 0) { m.type[q] = was; continue; }
    const p = NB[4 * q + OPP[d]];
    m.energy[p] += e;                                // the slot's synthetic energy was the daughter's half
    birth(m, q, d, t, true);
    m.cellCount--;                                   // replaced an existing cell: count unchanged
    mark[q] = 1; mark[p] = 1; born++;
  }

  // Fates: cells whose type has a natural predecessor where they sit.
  const nFates = t >= MOCK_MILESTONE_TICKS.firstFates ? Math.max(1, Math.round(n * RATE.fate)) : 0;
  len = 0;
  for (let i = 0; i < N; i++) {
    const ty = m.type[i];
    if (!ty || mark[i] || m.bornTick[i] === 0) continue;
    const b = m.band[i], d = m.depth[i];
    if ((b === 1 && (ty === ECTO || ty === NEURAL)) || (ty === MESO && d === m.e1 + 1) || (ty === ENDO && d === m.e2 + 1) ||
        (b === 2 && (ty === MUSCLE || ty === VESSEL)) || (b === 4 && ty === STEM && d <= m.e3 + 1)) list[len++] = i;
  }
  const nf = pick(list, len, nFates, rng);
  for (let k = 0; k < nf; k++) {
    const i = list[k], to = m.type[i];
    const from = to === ECTO || to === NEURAL ? STEM : to === MESO ? ECTO : to === ENDO ? MESO : to === STEM ? ENDO : MESO;
    m.type[i] = from;
    fate(m, i, to, t);
  }
}

// Synthetic per-tick history for the ticks before a standalone frame (the frame's own tick keeps its real events).
function fillHistory(m, tick, n) {
  const h = m.hist, turnover = n / 650, meanE = MOCK_PARAMS.totalEnergy / Math.max(1, n);
  const fateMix = [0, 0.02, 0.42, 0.14, 0.26, 0.03, 0.04, 0.09];
  let ringB = 0, ringD = 0, ringF = 0;
  for (let t = Math.max(1, tick - RING + 1); t < tick; t++) {
    const s = touch(h, t);
    const noise = (salt) => (hash(t, m.seed, salt) - 0.5) * 2 * Math.sqrt(turnover + 1);
    const grow = n * (t < 3000 ? 0.0006 : 0.00008);
    const b = Math.max(0, Math.round(turnover + grow + noise(11)));
    const d = t < 400 ? (hash(t, m.seed, 12) < 0.1 ? 1 : 0) : Math.max(0, Math.round(turnover * 0.97 + noise(12)));
    const f = t < MOCK_MILESTONE_TICKS.firstFates ? 0 : Math.max(0, Math.round(b * 1.2 + noise(13)));
    h.births[s] = b; h.deaths[s] = d; h.fates[s] = f;
    h.rim[s] = Math.round(b * 0.8); h.recycled[s] = d * meanE * (0.8 + 0.4 * hash(t, m.seed, 14));
    const tip = Math.round(d * 0.18), iso = hash(t, m.seed, 15) < 0.05 && d > tip ? 1 : 0;
    h.cause[CAUSE.age][s] = d - tip - iso; h.cause[CAUSE.tip][s] = tip; h.cause[CAUSE.isolated][s] = iso;
    let rest = f;
    for (let ty = 3; ty <= 7; ty++) { const c = Math.min(rest, Math.round(f * fateMix[ty])); h.fatesTo[ty][s] = c; rest -= c; }
    h.fatesTo[STEM][s] = Math.min(rest, Math.round(f * fateMix[STEM])); rest -= h.fatesTo[STEM][s];
    h.fatesTo[ECTO][s] = rest;
    // band crossings are a real share of fate changes while the embryo thickens, a few percent once it has settled
    h.reSpec[s] = Math.max(0, Math.round(f * (t < 3000 ? 0.15 : 0.03) + hash(t, m.seed, 16) - 0.5));
    h.stemF[s] = Math.min(f, Math.round(f * 0.55));
    ringB += b; ringD += d; ringF += f;
  }
  const t0 = touch(h, tick);   // keep this tick's real events (already recorded by die/birth/fate)
  ringB += h.births[t0]; ringD += h.deaths[t0]; ringF += h.fates[t0];
  const before = Math.max(0, tick - RING + 1 - 400) * turnover * 0.6;
  const deaths = Math.round(ringD + before);
  m.totals.deaths = deaths;
  m.totals.births = Math.max(Math.round(ringB), m.cellCount - SEED_COUNT + deaths);
  m.totals.fates = Math.round(Math.max(ringF, 1.25 * m.totals.births));
  if (tick === 0) m.totals.births = m.totals.deaths = m.totals.fates = 0;
}

// ─── advancing a chain ───────────────────────────────────────────────────────────────────────────────
function advanceModel(m, tick) {
  const P = MOCK_PARAMS, t0 = m.tick, span = tick - t0;
  const rng = mulberry32(Math.imul(m.seed, 0x2545f491) ^ Math.imul(tick, 0x9e3779b9));
  m.eventCount = 0; m.eventsDropped = 0;
  m.frameStart = t0;   // at most one event per cell per frame: cells with evTick > frameStart are left alone
  for (let t = Math.max(t0 + 1, tick - RING + 1); t <= tick; t++) touch(m.hist, t);
  const slices = Math.min(span, 4);
  let tPrev = t0;
  for (let s = 1; s <= slices; s++) {
    const t = t0 + Math.round((s * span) / slices), dt = t - tPrev;
    tPrev = t;
    for (let i = 0; i < N; i++) if (m.type[i]) m.age[i] = Math.min(65535, m.age[i] + dt);
    const n = m.cellCount;
    const died = killCells(m, t, Math.round((n * RATE.death) / slices), rng);
    spreadPool(m);
    computeDepth(m);
    const grow = m.rMax < 86 && m.cellCount < MAX_CELLS ? Math.max(1, Math.round((n * RATE.growth) / slices)) : 0;
    divideCells(m, t, died + grow, rng);
    computeDepth(m);
    specifyCells(m, t, Math.max(1, Math.round((n * RATE.fate) / slices)), rng, P);
  }
  shareEnergy(m, P.shareRate * 0.5);
  m.tick = tick;
  computeGeom(m); computeFields(m);
}

function killCells(m, t, budget, rng) {
  const { list, mark } = m;
  let killed = 0, len = 0;
  mark.fill(0);
  // Tip cells (a single live neighbour at the rim), then the oldest: expired first, then ≥ 80%, then ≥ 30% of lifespan.
  for (let i = 0; i < N; i++) {
    if (m.type[i] && m.depth[i] === 1 && m.bornTick[i] !== 0 && m.age[i] > MOCK_PARAMS.divCooldown &&
        m.evTick[i] <= m.frameStart && liveNeighbours(m, i) === 1) list[len++] = i;
  }
  let k = pick(list, len, Math.ceil(budget * 0.15), rng);
  for (let j = 0; j < k; j++) { mark[list[j]] = 1; die(m, list[j], t, CAUSE.tip); killed++; }
  for (const minFrac of [1, 0.8, 0.3]) {
    if (killed >= budget) break;
    len = 0;
    for (let i = 0; i < N; i++) {
      if (!m.type[i] || mark[i] || m.evTick[i] > m.frameStart) continue;
      if (m.age[i] >= minFrac * m.maxAge[i]) list[len++] = i;
    }
    k = pick(list, len, budget - killed, rng);
    for (let j = 0; j < k; j++) { mark[list[j]] = 1; die(m, list[j], t, CAUSE.age); killed++; }
  }
  return killed;
}

function divideCells(m, t, budget, rng) {
  const { list, mark } = m;
  mark.fill(0);
  let born = 0, len = 0;
  const fresh = (i) => m.evTick[i] > m.frameStart || (m.evKind[i] === EV.DEATH && t - m.evTick[i] < 3);   // let ghosts play out
  // 1. Interior gaps.
  for (let i = 0; i < N; i++) {
    if (m.type[i] || m.ext[i] || fresh(i)) continue;
    if (liveNeighbours(m, i)) list[len++] = i;
  }
  let k = pick(list, len, budget, rng);
  for (let j = 0; j < k && born < budget; j++) {
    const q = list[j], d = parentDir(m, q, t, false);
    if (d < 0) continue;
    mark[NB[4 * q + OPP[d]]] = 1; birth(m, q, d, t, false); born++;
  }
  if (born >= budget) return born;
  // 2. The rim: exterior empty cells next to tissue, nearest the centroid first (keeps the disc round).
  len = 0;
  for (let i = 0; i < N; i++) {
    if (m.type[i] || !m.ext[i] || fresh(i) || !liveNeighbours(m, i)) continue;
    list[len++] = i;
  }
  const dist = (i) => { const dx = wrapDelta((i % GRID) - m.cx), dy = wrapDelta(((i / GRID) | 0) - m.cy); return Math.sqrt(dx * dx + dy * dy) + 0.8 * hash(i, t, 51); };
  const sorted = Array.from(list.subarray(0, len)).sort((a, b) => dist(a) - dist(b));
  for (let j = 0; j < sorted.length && born < budget; j++) {
    const q = sorted[j];
    if (m.type[q]) continue;
    const d = parentDir(m, q, t, false);
    if (d < 0) continue;
    mark[NB[4 * q + OPP[d]]] = 1; birth(m, q, d, t, true); born++;
  }
  return born;
}

function specifyCells(m, t, budget, rng, P) {
  const { list } = m;
  let done = 0;
  const classes = [
    // 1. maturing stem cells take their band's fate
    (i, ty) => (ty === STEM && m.age[i] > P.diffAge && m.band[i] !== 4 ? ruleFate(m, i) : 0),
    // 2. mesoderm old enough in its type specialises by the relative activator gate
    (i, ty) => {
      if (ty !== MESO || t - m.typeSince[i] < P.gates.mesoSpecializeAge) return 0;
      const rel = m.morph[4 * i] / (m.meanAct || 1);
      return rel > P.gates.muscleRel ? MUSCLE : rel < P.gates.vesselRel ? VESSEL : 0;
    },
    // 3. germ-layer cells re-specify when the growing embryo moves their band (with a hold time as hysteresis)
    (i, ty) => {
      if (ty !== ECTO && ty !== MESO && ty !== ENDO) return 0;
      if (m.age[i] <= P.diffAge || t - m.typeSince[i] < P.hysteresis.ticks) return 0;
      const to = ruleFate(m, i);
      return to !== ty ? to : 0;
    },
  ];
  for (const target of classes) {
    if (done >= budget) break;
    let len = 0;
    for (let i = 0; i < N; i++) {
      const ty = m.type[i];
      if (ty && m.evTick[i] <= m.frameStart && target(i, ty)) list[len++] = i;
    }
    const k = pick(list, len, budget - done, rng);
    for (let j = 0; j < k; j++) { const i = list[j]; fate(m, i, target(i, m.type[i]), t); done++; }
  }
}

// Rebuilds a model from a frame's textures (for frames that crossed a thread boundary or went stale).
function modelFromFrame(frame) {
  const { cell, life } = frame;
  if (!(cell instanceof Uint8Array) || cell.length !== 4 * N || !(life instanceof Uint8Array) || life.length !== 4 * N) {
    throw new Error('mock-frames: frame textures are missing or detached; pass the frame object returned by makeMockFrame (its state survives transfer) or an intact copy');
  }
  const seed = frame.stats?.seed ?? 1, tick = frame.tick;
  const m = createModel(seed);
  m.tick = tick;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const o = 4 * i, ty = cell[o], bits = life[o + 1], evAge = life[o + 2];
    const kind = bits & 3;
    if (kind) {
      m.evKind[i] = kind; m.evDir[i] = (bits >> 2) & 3; m.evPrev[i] = (bits >> 4) & 7;
      m.evTick[i] = evAge >= 255 ? tick - 255 - Math.floor(hash(i, seed, 61) * 400) : tick - evAge;
    }
    if (!ty) continue;
    m.type[i] = ty;
    m.energy[i] = decodeEnergy(cell[o + 3]); sum += m.energy[i];
    m.maxAge[i] = lifespan(ty, i, 0);
    m.age[i] = Math.min(tick, Math.round((life[o] / 255) * m.maxAge[i]));
    m.bornTick[i] = Math.max(1, Math.min(tick, tick - m.age[i] - Math.floor(hash(i, seed, 34) * 150)));
    if (kind === EV.BIRTH && evAge < 255) m.bornTick[i] = m.evTick[i];
    if (kind === EV.FATE && evAge < 255) { m.fateTick[i] = m.typeSince[i] = m.evTick[i]; m.fateFrom[i] = m.evPrev[i]; }
    else if (ty === STEM) m.typeSince[i] = m.bornTick[i];
    else { m.typeSince[i] = m.fateTick[i] = Math.max(m.bornTick[i], tick - m.age[i]); m.fateFrom[i] = ty === MUSCLE || ty === VESSEL ? MESO : STEM; }
  }
  const total = frame.stats?.energy?.total ?? MOCK_PARAMS.totalEnergy;
  if (sum > 0) for (let i = 0; i < N; i++) if (m.type[i]) m.energy[i] *= total / sum;
  computeDepth(m); computeGeom(m);
  for (let i = 0; i < N; i++) if (m.type[i]) m.founder[i] = founderSector(m, i);
  const founders = frame.stats?.foundersAlive ?? 0;
  if (founders) {
    const byDist = [];
    for (let i = 0; i < N; i++) if (m.type[i] === STEM) byDist.push(i);
    const dist = (i) => Math.hypot(wrapDelta((i % GRID) - m.cx), wrapDelta(((i / GRID) | 0) - m.cy));
    byDist.sort((a, b) => dist(a) - dist(b)).slice(0, founders).forEach((i, k) => { m.bornTick[i] = 0; m.founder[i] = k; });
  }
  if (frame.morph instanceof Float32Array && frame.morph.length === 4 * N) {
    m.morph.set(frame.morph);
    let s = 0;
    for (let i = 0; i < N; i++) if (m.type[i]) s += m.morph[4 * i];
    m.meanAct = m.cellCount ? s / m.cellCount : 0;
  } else computeFields(m);
  const count = Math.min(frame.eventCount ?? 0, MAX_EVENTS_PER_FRAME);
  if (frame.events instanceof Int32Array && frame.events.length >= count * EV_WORDS) {
    m.events.set(frame.events.subarray(0, count * EV_WORDS)); m.eventCount = count;
  }
  fillHistory(m, tick, m.cellCount);
  // Replace the synthetic history of this frame's own span with its real events.
  const prevTick = Math.min(tick, frame.prevTick ?? tick);
  for (let t = Math.max(prevTick + 1, tick - RING + 1); t <= tick; t++) { m.hist.tick[slotOf(t)] = -1; touch(m.hist, t); }
  for (let k = 0; k < m.eventCount; k++) {
    const o = k * EV_WORDS, kind = m.events[o] & 0xff, i = m.events[o] >> 8, t = m.events[o + 1], a = m.events[o + 2];
    if (t <= tick - RING) continue;
    const s = touch(m.hist, t), h = m.hist;
    if (kind === EV.BIRTH) { h.births[s]++; if (m.depth[i] === 1) h.rim[s]++; }
    else if (kind === EV.DEATH) { h.deaths[s]++; h.cause[(a >> 8) & 3][s]++; h.recycled[s] += m.events[o + 3] / 1000; }
    else if (kind === EV.FATE) {
      const from = a & 7, to = (a >> 4) & 7;
      h.fates[s]++; h.fatesTo[to][s]++;
      if (from === STEM) h.stemF[s]++; else if (FAMILY_OF_TYPE[from] !== FAMILY_OF_TYPE[to]) h.reSpec[s]++;
    }
  }
  if (frame.stats?.totals) Object.assign(m.totals, frame.stats.totals);
  return m;
}

function modelOf(frame) {
  const entry = MODELS.get(frame);
  if (entry && entry.serial === entry.m.serial) return entry.m;
  const m = modelFromFrame(frame);
  MODELS.set(frame, { m, serial: m.serial });
  return m;
}

// ─── packing a frame message ─────────────────────────────────────────────────────────────────────────
const reuse = (buf, Ctor, len) => (buf instanceof Ctor && buf.length === len ? buf : new Ctor(len));

function packFrame(m, { id, prevTick, running, withMorph, withSeries, buffers }) {
  const P = MOCK_PARAMS, tick = m.tick;
  const cell = reuse(buffers?.cell, Uint8Array, 4 * N), life = reuse(buffers?.life, Uint8Array, 4 * N);
  const idx = reuse(buffers?.idx, Uint16Array, N), events = reuse(buffers?.events, Int32Array, EV_WORDS * MAX_EVENTS_PER_FRAME);
  const morph = withMorph ? reuse(buffers?.morph, Float32Array, 4 * N) : null;
  const ghostTicks = Math.min(255, Math.ceil(0.5 * Math.max(TPS_TARGET, 2.5)) + (tick - prevTick));
  let count = 0;
  for (let i = 0; i < N; i++) {
    const o = 4 * i, ty = m.type[i], kind = m.evKind[i];
    const evAge = kind ? Math.min(255, tick - m.evTick[i]) : 255;
    let ready = 0;
    if (ty) {
      const thr = ty === STEM ? P.divThreshStem : P.divThreshDiff;
      // bit 7 as the worker sets it: above threshold, past the cooldown, and an empty neighbour to divide into
      ready = m.energy[i] > thr && m.age[i] > P.divCooldown && roomAt(m.type, i) ? 1 : 0;
      cell[o] = ty; cell[o + 1] = m.band[i]; cell[o + 2] = m.depth[i]; cell[o + 3] = encodeEnergy(m.energy[i]);
      life[o] = Math.round(255 * Math.min(1, m.age[i] / m.maxAge[i]));
      idx[count++] = i;
    } else {
      cell[o] = 0; cell[o + 1] = 0; cell[o + 2] = m.ext[i] ? 0 : 255; cell[o + 3] = 0;
      life[o] = 0;
      if (kind === EV.DEATH && evAge <= ghostTicks) idx[count++] = i;
    }
    life[o + 1] = (kind & 3) | ((m.evDir[i] & 3) << 2) | ((m.evPrev[i] & 7) << 4) | (ready << 7);
    life[o + 2] = evAge;
    life[o + 3] = 0;
  }
  events.set(m.events.subarray(0, m.eventCount * EV_WORDS));
  if (morph) morph.set(m.morph);
  let series = null;
  if (withSeries) {
    const births = new Uint16Array(RING), deaths = new Uint16Array(RING);
    for (let t = Math.max(0, tick - RING + 1); t <= tick; t++) {
      const s = slotOf(t);
      if (m.hist.tick[s] !== t) continue;
      births[s] = Math.min(65535, m.hist.births[s]); deaths[s] = Math.min(65535, m.hist.deaths[s]);
    }
    series = { births, deaths, head: slotOf(tick + 1) };
  }
  return {
    type: MSG.FRAME, id, tick, prevTick, running, viewing: null,
    cell, life, idx, idxCount: count, morph, events, eventCount: m.eventCount, eventsDropped: m.eventsDropped,
    stats: computeStats(m, P, running), series,
  };
}

// ─── stats ───────────────────────────────────────────────────────────────────────────────────────────
function computeStats(m, params, running) {
  const P = params, g = P.gates;
  const typeCounts = [0, 0, 0, 0, 0, 0, 0, 0], bandCounts = [0, 0, 0, 0, 0], plates = [0, 0, 0, 0];
  const histStem = new Array(24).fill(0), histDiff = new Array(24).fill(0);
  let total = 0, comp = 0, eStem = 0, eDiff = 0, ready = 0, readyStem = 0, readyDiff = 0, old = 0, match = 0, gaps = 0, founders = 0;
  let readyRoom = 0, stemCore = 0, muscSame = 0, muscN = 0;
  let maxAct = 0, maxInh = 0, maxMid = 0, maxAP = 0, sumAct = 0, maxMesoAct = 0, competent = 0;
  let nN = 0, nX = 0, nY = 0, nXX = 0, nYY = 0, nAnt = 0;
  for (let i = 0; i < N; i++) {
    const ty = m.type[i];
    if (!ty) { if (!m.ext[i]) gaps++; continue; }
    const e = m.energy[i], o = 4 * i;
    typeCounts[ty]++;
    const t = total + e;   // Neumaier compensated sum
    comp += Math.abs(total) >= Math.abs(e) ? total - t + e : e - t + total;
    total = t;
    const stem = ty === STEM, thr = stem ? P.divThreshStem : P.divThreshDiff;
    const bin = Math.min(23, Math.floor((e / thr) * 12));
    if (stem) { eStem += e; histStem[bin]++; } else { eDiff += e; histDiff[bin]++; }
    if (e > thr && m.age[i] > P.divCooldown) { ready++; if (stem) readyStem++; else readyDiff++; if (roomAt(m.type, i)) readyRoom++; }
    if (stem && m.band[i] === 4) stemCore++;
    if (ty === MUSCLE) {
      const x = i % GRID, y = (i / GRID) | 0;
      const nb = [m.type[y * GRID + (x + 1) % GRID], m.type[y * GRID + (x + GRID - 1) % GRID], m.type[((y + 1) % GRID) * GRID + x], m.type[((y + GRID - 1) % GRID) * GRID + x]];
      const lv = nb.filter((v) => v !== 0).length;
      if (lv) { muscSame += nb.filter((v) => v === MUSCLE).length / lv; muscN++; }
    }
    if (m.age[i] / m.maxAge[i] > 0.85) old++;
    const b = m.band[i];
    bandCounts[b]++;
    const fam = FAMILY_OF_TYPE[ty];
    plates[fam]++;
    if (fam === b - 1) match++;
    if (m.bornTick[i] === 0) founders++;
    const act = m.morph[o], inh = m.morph[o + 1], mid = m.morph[o + 2], ap = m.morph[o + 3];
    if (act > maxAct) maxAct = act;
    if (inh > maxInh) maxInh = inh;
    if (mid > maxMid) maxMid = mid;
    if (ap > maxAP) maxAP = ap;
    sumAct += act;
    if (ty === MESO && act > maxMesoAct) maxMesoAct = act;
    if (b === 1 && mid > g.neuralMid && ap > g.neuralAP) competent++;
    if (ty === NEURAL) {
      const dx = wrapDelta((i % GRID) - m.cx), dy = wrapDelta(((i / GRID) | 0) - m.cy);
      nN++; nX += dx; nY += dy; nXX += dx * dx; nYY += dy * dy;
      if (dy < 0) nAnt++;
    }
  }
  total += comp;
  const n = m.cellCount, nStem = typeCounts[STEM], nDiff = n - nStem;
  const mx = nN ? nX / nN : 0, my = nN ? nY / nN : 0;
  const h = m.hist, tick = m.tick;
  const wb = winSum(h, h.births, tick, WIN);
  const milestones = makeMockMilestones(tick);
  let stage = { key: 'seed', label: MILESTONES[0].label, index: 0 };
  const milestoneStats = {};
  milestones.forEach((ms, index) => {
    if (ms.tick === null) return;
    milestoneStats[ms.key] = { tick: ms.tick, typeCounts: compositionAt(ms.tick) };
    if (ms.tick >= (milestoneStats[stage.key]?.tick ?? 0)) stage = { key: ms.key, label: ms.label, index };
  });
  return {
    tick, seed: m.seed, seedCount: SEED_COUNT, cellCount: n, typeCounts,
    energy: {
      total, initial: P.totalEnergy, driftPpm: ((total - P.totalEnergy) / P.totalEnergy) * 1e6, lost: 0,
      mean: n ? total / n : 0, meanStem: nStem ? eStem / nStem : 0, meanDiff: nDiff ? eDiff / nDiff : 0,
      thrStem: P.divThreshStem, thrDiff: P.divThreshDiff, ready, readyStem, readyDiff, readyRoom, histStem, histDiff,
    },
    totals: { ...m.totals },
    win: {
      W: WIN, births: wb, deaths: winSum(h, h.deaths, tick, WIN), fates: winSum(h, h.fates, tick, WIN),
      recycled: winSum(h, h.recycled, tick, WIN),
      deathsByCause: h.cause.map((a) => winSum(h, a, tick, WIN)),
      fatesTo: h.fatesTo.map((a) => winSum(h, a, tick, WIN)),
      reSpecified: winSum(h, h.reSpec, tick, WIN),
      stemFates: winSum(h, h.stemF, tick, WIN),
      rimBirthPct: wb ? (100 * winSum(h, h.rim, tick, WIN)) / wb : 0,
    },
    geom: {
      cx: m.cx, cy: m.cy, rMax: m.rMax, dmax: m.dmax, bands: { e1: m.e1, e2: m.e2, e3: m.e3 }, gaps,
      neural: {
        count: nN, cx: ((m.cx + mx) % GRID + GRID) % GRID, cy: ((m.cy + my) % GRID + GRID) % GRID,
        spread: nN ? Math.sqrt(Math.max(0, nXX / nN - mx * mx + nYY / nN - my * my)) : 0,
        anteriorPct: nN ? (100 * nAnt) / nN : 0,
      },
    },
    signals: { maxAct, maxInh, maxMid, maxAP, meanAct: n ? sumAct / n : 0, maxMesoAct, neuralCompetent: competent, muscleClustering: muscN ? muscSame / muscN : 0 },
    bands: { counts: bandCounts, matchPct: n ? (100 * match) / n : 0, stemCore },
    age: { old },
    plates: { fate: plates },
    stage, milestoneStats,
    tps: { target: TPS_TARGET, actual: running ? TPS_TARGET - (tick % 3 === 0 ? 2 : 0) : 0 },
    foundersAlive: founders,
  };
}

// ─── public API ──────────────────────────────────────────────────────────────────────────────────────
export function makeMockFrame({
  cells = 10000, tick, seed = 1, prev = null, id = 1, running = true, morph = true, series = true, buffers = null,
} = {}) {
  let m, prevTick;
  if (prev) {
    m = modelOf(prev);
    const next = tick ?? prev.tick + 1;
    if (!(next > prev.tick)) throw new RangeError(`mock-frames: tick ${next} must be after prev.tick ${prev.tick}`);
    advanceModel(m, next);
    m.serial++;
    prevTick = prev.tick;
  } else {
    const t = Math.max(0, Math.floor(tick ?? 5000));
    m = buildModel(cells, t, seed);
    prevTick = t > 0 ? t - 1 : 0;
  }
  const frame = packFrame(m, { id, prevTick, running, withMorph: morph, withSeries: series, buffers });
  MODELS.set(frame, { m, serial: m.serial });
  return frame;
}

export function makeMockStats(frame, { params = MOCK_PARAMS } = {}) {
  return computeStats(modelOf(frame), params, frame.running ?? true);
}

export function makeMockMilestones(tick) {
  const reached = MILESTONES.filter((ms) => MOCK_MILESTONE_TICKS[ms.key] <= tick)
    .sort((a, b) => MOCK_MILESTONE_TICKS[a.key] - MOCK_MILESTONE_TICKS[b.key]);
  return MILESTONES.map(({ key, label, awaiting }) => {
    const k = reached.findIndex((ms) => ms.key === key);
    return { key, label, awaiting, tick: k >= 0 ? MOCK_MILESTONE_TICKS[key] : null, snapId: k >= 0 ? k + 1 : null, thumb: null };
  });
}

export function makeMockThumbTypes(frame) {
  const m = modelOf(frame);
  const out = new Uint8Array(THUMB * THUMB);
  const side = Math.min(200, Math.max(24, 2 * m.rMax + 16)), x0 = m.cx - side / 2, y0 = m.cy - side / 2;
  for (let v = 0; v < THUMB; v++) {
    const y = ((Math.floor(y0 + ((v + 0.5) * side) / THUMB) % GRID) + GRID) % GRID;
    for (let u = 0; u < THUMB; u++) {
      const x = ((Math.floor(x0 + ((u + 0.5) * side) / THUMB) % GRID) + GRID) % GRID;
      out[v * THUMB + u] = m.type[y * GRID + x];
    }
  }
  return out;
}

export function makeMockCellDetail(frame, idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= N) return null;
  const m = modelOf(frame);
  const type = m.type[idx];
  if (!type) return null;
  const P = MOCK_PARAMS, o = 4 * idx, threshold = type === STEM ? P.divThreshStem : P.divThreshDiff;
  return {
    idx, x: idx % GRID, y: (idx / GRID) | 0, tick: m.tick, type,
    energy: m.energy[idx], threshold, age: m.age[idx], maxAge: m.maxAge[idx],
    depth: m.depth[idx], band: m.band[idx], ruleFate: ruleFate(m, idx),
    ready: m.energy[idx] > threshold && m.age[idx] > P.divCooldown, hasRoom: roomAt(m.type, idx),
    act: m.morph[o], inh: m.morph[o + 1], mid: m.morph[o + 2], ap: m.morph[o + 3],
    bornTick: m.bornTick[idx], founder: m.founder[idx], fateTick: m.fateTick[idx], fateFrom: m.fateFrom[idx], typeSince: m.typeSince[idx],
  };
}

export function makeMockReady({ seed = 1 } = {}) {
  return {
    type: MSG.READY, engineVersion: MOCK_ENGINE_VERSION, seed, seedCount: SEED_COUNT, grid: GRID,
    params: MOCK_PARAMS, fieldInfo: MOCK_FIELD_INFO, totalEnergy0: MOCK_PARAMS.totalEnergy,
  };
}

export function mockTransferList(frame) {
  const list = [frame.cell.buffer, frame.life.buffer, frame.idx.buffer, frame.events.buffer];
  if (frame.morph) list.push(frame.morph.buffer);
  return list;
}
