// src/engine.js — Embryo Engine v1.0: the simulation core.
//
// One law, three rules and four signal fields on a 200×200 torus:
//   Law     A fixed pot of energy (250 000) is conserved exactly: no sources, no sinks.
//   Rule 1  Divide: a cell with enough energy splits it 50/50 with a STEM daughter placed in a free neighbour.
//   Rule 2  Die: of old age, of isolation, or as a dangling tip. The energy goes to the nearest living cells.
//   Rule 3  Depth → fate, continuously: every germ-layer cell keeps re-reading its depth below the exterior
//           surface, as a fraction of the depth of the embryo's deepest cell, and takes that band's fate.
// Signals: four morphogen fields (activator, inhibitor, midline, A–P). A Gierer–Meinhardt activator–inhibitor
// pair breaks the mesoderm band into muscle blocks separated by vessel; midline × A–P gates the neural plate.
//
// Pure ES module: no DOM, no globals, no Math.random, no transcendental Math calls in the dynamics (determinism
// across JS engines). Every buffer is allocated in createSim(); step() allocates nothing.
// Hot loops use neighbour tables instead of modulo (see the audit's 'export const in % GS' pitfall).

import { GRID, EV, EV_WORDS, RULE_FATE_OF_BAND } from './shared.js';

export const ENGINE_VERSION = '1.0.0';

// Local literal copies keep hot-path constants foldable by the JIT (never read imported bindings in loops).
const GS = 200;
const N = GS * GS;
if (GRID !== GS) throw new Error('engine.js expects GRID = 200');

const EMPTY = 0, STEM = 1, ECTO = 2, MESO = 3, ENDO = 4, NEURAL = 5, MUSCLE = 6, VESSEL = 7;
const EV_BIRTH = EV.BIRTH, EV_DEATH = EV.DEATH, EV_FATE = EV.FATE;
const RULE_FATE = Uint8Array.from(RULE_FATE_OF_BAND); // local copy: no imported bindings in hot code
const FAM_BAND = Uint8Array.of(0, 4, 1, 2, 3, 1, 2, 2);  // the band each type belongs to (stem = core)
const NEVER = 0xFFFFFFFF;              // prov.fateTick for cells that never changed type
const EVENT_CAP = 16384;               // internal event ring capacity (events)
if (EV_WORDS !== 4) throw new Error('engine.js expects EV_WORDS = 4');
const SNAPSHOT_KIND = 'embryo-engine-snapshot';

// ---------------------------------------------------------------------------------------------------------------
// Parameters

const RATES = [0.03, 0.325, 0.234, 0.208]; // activator, inhibitor, midline, A–P (inhibitor 0.325 = 2 × 0.1625)
const MAX_RATE = 0.24;                     // explicit 5-point diffusion is stable for r ≤ 0.25; sub-step above this

function substepsFor(rate, maxRate) {
  // power-of-two sub-steps so the per-substep decay is an exact chain of square roots (deterministic)
  let s = 1;
  while (rate / s > maxRate) s *= 2;
  return s;
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

export const PARAMS = deepFreeze({
  totalEnergy: 250000,
  seedRadius2: 10,             // founders fill the disk dx²+dy² ≤ 10 at the grid centre (37 cells)
  // depth = BFS distance to the exterior. 'octagonal': rings alternate 4- and 8-neighbour steps (odd rings may step
  // diagonally), which keeps layers round; 'manhattan': 4-neighbour steps only (square cores). Depth 1 = 4-adjacent.
  depthMetric: 'octagonal',
  divThreshStem: 30,           // Rule 1 thresholds (energy must exceed them)
  divThreshDiff: 42,
  divCooldown: 14,             // a cell may divide once its age (ticks since birth/last division) exceeds this
  diffAge: 12,                 // germ-layer cells re-read their depth only when older than this
  shareRate: 0.05,             // fraction of the energy difference exchanged with each live neighbour per tick
  senescence: {                // maxAge = floor(base·factor[type] + (u − ½)·spread); founders use base·1
    base: 500, spread: 150,
    factor: [0, 0.6, 1.3, 0.9, 1.4, 2.5, 1.6, 1.8],
  },
  death: { tipP: 0.08, orphanRadius: 2 },
  // Rule 3 bands, as fractions of dRef (the hysteresis-filtered max live depth):
  //   e1 = max(1, round(ecto·d)), e2 = max(2, round(meso·d)), e3 = max(6, ceil(endo·d))
  //   band 1 if depth ≤ e1, 2 if ≤ e2, 3 if < e3, else 4
  bandFrac: { ecto: 0.15, meso: 0.30, endo: 0.85 },
  bandMin: { ecto: 1, meso: 2, endo: 6 },
  hysteresis: {
    dmaxDeadband: 1,           // dRef moves only when dmax leaves [dRef − 1, dRef + 1]
    depthMargin: 1,            // a cell keeps its current band while its depth is within ±margin of that band
    persist: 6,                // ...and changes fate only after this many consecutive ticks of disagreement
    terminalRevert: 150,       // terminal cells out of their band this many ticks revert to the band's fate (0 = never)
    flipWindow: 50,            // flip-flop = a fate change undone within this many ticks (measured, not a rule)
  },
  gates: {
    neuralMid: 0.18, neuralAP: 0.18,      // band 1 → NEURAL where midline > neuralMid and A–P > neuralAP
    muscleRel: 1.2, vesselRel: 0.8,       // MESO → MUSCLE if act > muscleRel·meanAct, → VESSEL if act < vesselRel·meanAct
    mesoSpecializeAge: 40,                // ...once it has been MESO for more than this many ticks
    mesoReference: 'depth',               // compare with the mean activator of the cell's depth shell ('depth') or the tissue
  },
  diffusion: {
    rates: RATES, decay: 0.96, maxRate: MAX_RATE,
    substeps: RATES.map((r) => substepsFor(r, MAX_RATE)),
    floor: 0.0003, cap: 8,
  },
  kinetics: {                  // a += rho·a²/((b+epsB)(1+sat·a²)) + basal + noise·(u−½);  b += inhProd·a² − inhDecay·b
    rho: 0.01, sat: 0.02, epsB: 0.001, basal: 0.0005, noise: 0.02, inhProd: 0.01, inhDecay: 0.02, cap: 8,
  },
  sources: {                   // per-tick morphogen deposits. v0.9's activator/inhibitor deposits (birth +0.1 act,
    birthAct: 0, deathInh: 0,  //   death +0.06 inh, endoderm +0.006 act/tick) are off: they entrain the Turing pattern
    midline: 0.01, midlineSigma: 14, ap: 0.01, apScale: 20,
    ectoMid: 0.002, neuralMid: 0.012, neuralAP: 0.008, mesoAP: 0.004, endoAct: 0,
    founderAct: [0.3, 0.3], founderAPStep: 0.08, founderAPLen: 6,
  },
});

// Fixed display domains for the four signal views (not auto-ranged, so colours stay comparable over time). The
// measurements behind them (p99 and max of live cells over 5 seeds × 20K ticks) are in docs/engine-v1.md, "FIELD_INFO".
// Muscle/vessel gates are relative to the mean activator at the cell's own depth: `rel` is the factor, `v` its value
// at the typical tissue mean (1.24).
export const FIELD_INFO = deepFreeze([
  { key: 'activator', label: 'Activator', channel: 0, domain: [0, 3], scale: 'linear',
    gates: [
      { v: 1.49, rel: 1.2, label: 'Muscle: > 1.2× mean at that depth' },
      { v: 0.99, rel: 0.8, label: 'Vessel: < 0.8× mean at that depth' },
    ] },
  { key: 'inhibitor', label: 'Inhibitor', channel: 1, domain: [0, 0.6], scale: 'linear', gates: [] },
  { key: 'midline', label: 'Midline', channel: 2, domain: [0, 0.45], scale: 'linear',
    gates: [{ v: 0.18, label: 'Neural gate (with A–P)' }] },
  { key: 'ap', label: 'A–P', channel: 3, domain: [0, 0.65], scale: 'sqrt',
    gates: [{ v: 0.18, label: 'Neural gate (with midline)' }] },
]);

function mergeParams(over) {
  const merge = (base, o) => {
    if (Array.isArray(base)) return (o === undefined ? base : o).slice();
    if (typeof base !== 'object' || base === null) return o === undefined ? base : o;
    const out = {};
    for (const k of Object.keys(base)) out[k] = merge(base[k], o === undefined ? undefined : o[k]);
    return out;
  };
  const p = merge(PARAMS, over || {});
  p.diffusion.substeps = p.diffusion.rates.map((r) => substepsFor(r, p.diffusion.maxRate));
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Static tables

// NB[i*4 + d] = neighbour of cell i in direction d (DX/DY order of shared.js: +x, −x, +y, −y), toroidal.
const NB = new Int32Array(N * 4);
const COL = new Uint8Array(N), ROW = new Uint8Array(N);
for (let y = 0; y < GS; y++) {
  for (let x = 0; x < GS; x++) {
    const i = y * GS + x;
    COL[i] = x; ROW[i] = y;
    NB[i * 4] = y * GS + (x + 1) % GS;
    NB[i * 4 + 1] = y * GS + (x + GS - 1) % GS;
    NB[i * 4 + 2] = ((y + 1) % GS) * GS + x;
    NB[i * 4 + 3] = ((y + GS - 1) % GS) * GS + x;
  }
}
// NBD[i*4 + k] = diagonal neighbours (+x+y, +x−y, −x+y, −x−y), toroidal (octagonal depth metric).
const NBD = new Int32Array(N * 4);
for (let i = 0; i < N; i++) {
  NBD[i * 4] = NB[NB[i * 4] * 4 + 2]; NBD[i * 4 + 1] = NB[NB[i * 4] * 4 + 3];
  NBD[i * 4 + 2] = NB[NB[i * 4 + 1] * 4 + 2]; NBD[i * 4 + 3] = NB[NB[i * 4 + 1] * 4 + 3];
}
// Manhattan-distance-2 ring as pairs of directions (for orphan energy): straight ×2, then the diagonals.
const RING2 = [0, 0, 1, 1, 2, 2, 3, 3, 0, 2, 0, 3, 1, 2, 1, 3];

// Deterministic e^(−u), u ≥ 0: Taylor series of e^(−u/64) (Horner), squared 6 times. Relative error < 1e-8.
function expNeg(u) {
  if (u >= 40) return 0;
  const v = -u / 64;
  let p = 1 + v / 10;
  p = 1 + (v / 9) * p; p = 1 + (v / 8) * p; p = 1 + (v / 7) * p; p = 1 + (v / 6) * p;
  p = 1 + (v / 5) * p; p = 1 + (v / 4) * p; p = 1 + (v / 3) * p; p = 1 + (v / 2) * p; p = 1 + v * p;
  p *= p; p *= p; p *= p; p *= p; p *= p; p *= p;
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// The simulation
//
// Implementation note: the state lives on a class instance and the hot helpers are module-level functions. With
// closures, a second live instance (the worker keeps a live sim and a snapshot-view sim) stops V8 from treating
// closure variables as constants: helpers stop inlining, returned doubles get boxed, and the step allocated
// ~0.5 MB/tick. Doubles that change every tick are kept in typed arrays (F, dcoef) for the same reason.

// Indices into Sim.F (Float64Array of per-tick double scalars)
const CX = 0, CY = 1, TOTAL_EN = 2, MEAN_ACT = 3, POOL = 4, RECYCLED = 5, TOTAL_RECYCLED = 6;

// sfc32 over an Int32Array state. Returns the top 30 bits as a small integer (never boxed, even when the call is not
// inlined); callers scale with U30 to get a uniform double in [0, 1).
const U30 = 1 / 1073741824;
function rng30(RS) {
  const a = RS[0], b = RS[1], c = RS[2], d = (RS[3] + 1) | 0;
  const t = (((a + b) | 0) + d) | 0;
  RS[0] = b ^ (b >>> 9);
  RS[1] = (c + (c << 3)) | 0;
  RS[2] = (((c << 21) | (c >>> 11)) + t) | 0;
  RS[3] = d;
  return t >>> 2;
}

// splitmix32 expands the seed into the four sfc32 words; the first 15 outputs are discarded.
function seedRng(RS, seed) {
  let z = seed | 0;
  for (let k = 0; k < 4; k++) {
    z = (z + 0x9E3779B9) | 0;
    let t = z ^ (z >>> 16); t = Math.imul(t, 0x21F0AAAD);
    t ^= t >>> 15; t = Math.imul(t, 0x735A2D97);
    RS[k] = (t ^ (t >>> 15)) | 0;
  }
  for (let k = 0; k < 15; k++) rng30(RS);
}

function bandOfDepth(d, e1, e2, e3) { return d <= e1 ? 1 : d <= e2 ? 2 : d < e3 ? 3 : 4; }

// Explicit 5-point diffusion of Sa into Da with rate coef[2m] and decay coef[2m+1], computed only over the bbox of
// non-zero input + 1 (exact: everything outside is +0 and stays +0). Falls back to the full axis (with wrap) when the
// region touches a grid edge. bs/bd hold [x0,x1,y0,y1] at offsets os/od (empty when x0 > x1); bd receives the tight
// bbox of the output. coef[8] = floor (values below become 0), coef[9] = cap.
function diffuse(Sa, Da, coef, m, bs, os, bd, od) {
  const r = coef[2 * m], dec = coef[2 * m + 1], floor = coef[8], cap = coef[9];
  let xa, xb, ya, yb;
  const empty = bs[os] > bs[os + 1];
  if (empty) { xa = 1; xb = 0; ya = 1; yb = 0; } else {
    xa = bs[os] - 1; xb = bs[os + 1] + 1; ya = bs[os + 2] - 1; yb = bs[os + 3] + 1;
    if (xa <= 0 || xb >= GS - 1) { xa = 0; xb = GS - 1; }
    if (ya <= 0 || yb >= GS - 1) { ya = 0; yb = GS - 1; }
  }
  // clear stale non-zero data of the destination that the region will not overwrite
  if (bd[od] <= bd[od + 1] && !(xa <= bd[od] && xb >= bd[od + 1] && ya <= bd[od + 2] && yb >= bd[od + 3])) {
    for (let y = bd[od + 2]; y <= bd[od + 3]; y++) Da.fill(0, y * GS + bd[od], y * GS + bd[od + 1] + 1);
  }
  if (empty) { bd[od] = 1; bd[od + 1] = 0; bd[od + 2] = 1; bd[od + 3] = 0; return; }
  let nx0 = GS, nx1 = -1, ny0 = -1, ny1 = -1;
  const fullX = xa === 0 && xb === GS - 1;
  for (let y = ya; y <= yb; y++) {
    const row = y * GS;
    const up = (y === 0 ? GS - 1 : y - 1) * GS, dn = (y === GS - 1 ? 0 : y + 1) * GS;
    let rmin = GS, rmax = -1, x = xa, xe = xb;
    if (fullX) {
      for (let k = 0; k < 2; k++) {
        const xx = k === 0 ? 0 : GS - 1, i = row + xx, s = Sa[i];
        const lft = k === 0 ? Sa[row + GS - 1] : Sa[i - 1], rgt = k === 0 ? Sa[i + 1] : Sa[row];
        let v = (s + r * (lft + rgt + Sa[up + xx] + Sa[dn + xx] - 4 * s)) * dec;
        if (v < floor) v = 0; else { if (v > cap) v = cap; if (xx < rmin) rmin = xx; if (xx > rmax) rmax = xx; }
        Da[i] = v;
      }
      x = 1; xe = GS - 2;
    }
    for (; x <= xe; x++) {
      const i = row + x, s = Sa[i];
      let v = (s + r * (Sa[i - 1] + Sa[i + 1] + Sa[up + x] + Sa[dn + x] - 4 * s)) * dec;
      if (v < floor) v = 0; else { if (v > cap) v = cap; if (x < rmin) rmin = x; if (x > rmax) rmax = x; }
      Da[i] = v;
    }
    if (rmax >= 0) {
      if (ny0 < 0) ny0 = y;
      ny1 = y;
      if (rmin < nx0) nx0 = rmin;
      if (rmax > nx1) nx1 = rmax;
    }
  }
  if (ny0 < 0) { bd[od] = 1; bd[od + 1] = 0; bd[od + 2] = 1; bd[od + 3] = 0; }
  else { bd[od] = nx0; bd[od + 1] = nx1; bd[od + 2] = ny0; bd[od + 3] = ny1; }
}

function tightBBox(a, bb, o) {
  let x0 = GS, x1 = -1, y0 = -1, y1 = -1;
  for (let y = 0; y < GS; y++) {
    const row = y * GS;
    for (let x = 0; x < GS; x++) {
      if (a[row + x] !== 0) {
        if (y0 < 0) y0 = y;
        y1 = y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
  }
  if (y0 < 0) { bb[o] = 1; bb[o + 1] = 0; bb[o + 2] = 1; bb[o + 3] = 0; }
  else { bb[o] = x0; bb[o + 1] = x1; bb[o + 2] = y0; bb[o + 3] = y1; }
}

// bb |= living bbox + 1 (the only places a step writes morphogens: live cells, births, deaths)
function unionLivingBBox(bb, o, lx0, lx1, ly0, ly1) {
  if (lx0 > lx1) return;
  let x0 = lx0 - 1, x1 = lx1 + 1, y0 = ly0 - 1, y1 = ly1 + 1;
  if (x0 < 0 || x1 > GS - 1) { x0 = 0; x1 = GS - 1; }
  if (y0 < 0 || y1 > GS - 1) { y0 = 0; y1 = GS - 1; }
  if (bb[o] > bb[o + 1]) { bb[o] = x0; bb[o + 1] = x1; bb[o + 2] = y0; bb[o + 3] = y1; return; }
  if (x0 < bb[o]) bb[o] = x0;
  if (x1 > bb[o + 1]) bb[o + 1] = x1;
  if (y0 < bb[o + 2]) bb[o + 2] = y0;
  if (y1 > bb[o + 3]) bb[o + 3] = y1;
}

function pushEvent(s, kind, idx, a, b) {
  const n = s.evCount;
  if (n >= EVENT_CAP) { s.evDropped++; return; }
  const o = n * EV_WORDS, E = s.evBuf;
  E[o] = kind | (idx << 8); E[o + 1] = s.tick; E[o + 2] = a; E[o + 3] = b;
  s.evCount = n + 1;
}

function assignMaxAge(s, type) {
  const v = Math.floor(s.maxAgeBase[type] + (rng30(s.RS) * U30 - 0.5) * s.senSpread);
  return v < 1 ? 1 : v > 65535 ? 65535 : v;
}

// Every type change of a live cell: bookkeeping, flip-flop count and a FATE event.
function setFate(s, TB, i, from, to, bnd) {
  TB[i] = to;
  s.fatesT++;
  const tick = s.tick;
  // fateFrom is 0 until the first change (types are ≥ 1), so the NEVER sentinel of fateTick is never loaded here
  if (s.fateFrom[i] === to && tick - s.fateTick[i] <= s.flipWindow) s.flipsT++;
  s.fateFrom[i] = from; s.fateTick[i] = tick; s.typeSince[i] = tick; s.pend[i] = 0;
  pushEvent(s, EV_FATE, i, from | (to << 4) | (s.depth[i] << 12), bnd);
}

// Rule 2 bookkeeping. The whole energy goes to the live 4-neighbours (in the partly updated grid), else to the
// nearest live cells at Manhattan distance 2, else to the global pool (spread over all live cells at tick end).
function die(s, TB, i, t, cause, m1) {
  const energy = s.energy;
  const e = energy[i];
  energy[i] = 0; TB[i] = EMPTY; s.age[i] = 0; s.maxAge[i] = 0; s.pend[i] = 0;
  m1[i] += s.deathInh;
  const b = i << 2;
  const n0 = NB[b], n1 = NB[b + 1], n2 = NB[b + 2], n3 = NB[b + 3];
  const mask = (TB[n0] !== 0 ? 1 : 0) | (TB[n1] !== 0 ? 2 : 0) | (TB[n2] !== 0 ? 4 : 0) | (TB[n3] !== 0 ? 8 : 0);
  if (mask !== 0) {
    const k = (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
    const each = e / k;
    if (mask & 1) energy[n0] += each;
    if (mask & 2) energy[n1] += each;
    if (mask & 4) energy[n2] += each;
    if (mask & 8) energy[n3] += each;
  } else {
    let k = 0;
    for (let q = 0; q < 16; q += 2) if (TB[NB[(NB[b + RING2[q]] << 2) + RING2[q + 1]]] !== 0) k++;
    if (k > 0) {
      const each = e / k;
      for (let q = 0; q < 16; q += 2) {
        const j = NB[(NB[b + RING2[q]] << 2) + RING2[q + 1]];
        if (TB[j] !== 0) energy[j] += each;
      }
    } else {
      s.F[POOL] += e;
    }
  }
  s.deathsT++; s.F[RECYCLED] += e;
  pushEvent(s, EV_DEATH, i, t | (mask << 4) | (cause << 8), Math.round(e * 1000));
}

function floodExterior(dist, queue, qt) {
  let head = 0;
  while (head < qt) {
    const c = queue[head++], b = c << 2;
    let j = NB[b];     if (dist[j] === 254) { dist[j] = 0; queue[qt++] = j; }
    j = NB[b + 1];     if (dist[j] === 254) { dist[j] = 0; queue[qt++] = j; }
    j = NB[b + 2];     if (dist[j] === 254) { dist[j] = 0; queue[qt++] = j; }
    j = NB[b + 3];     if (dist[j] === 254) { dist[j] = 0; queue[qt++] = j; }
  }
}

// Fallback exterior (organism near the torus seam): label empty components (temporarily 252), keep the largest as
// the exterior (0), mark the rest as unvisited gaps (254).
function largestEmptyComponentAsExterior(dist, queue) {
  let bestStart = -1, bestSize = 0;
  for (let s = 0; s < N; s++) {
    if (dist[s] !== 254) continue;
    dist[s] = 252;
    let qt = 0, head = 0;
    queue[qt++] = s;
    while (head < qt) {
      const c = queue[head++], b = c << 2;
      for (let d = 0; d < 4; d++) { const j = NB[b + d]; if (dist[j] === 254) { dist[j] = 252; queue[qt++] = j; } }
    }
    if (qt > bestSize) { bestSize = qt; bestStart = s; }
  }
  if (bestStart >= 0) {
    dist[bestStart] = 0;
    let qt = 0, head = 0;
    queue[qt++] = bestStart;
    while (head < qt) {
      const c = queue[head++], b = c << 2;
      for (let d = 0; d < 4; d++) { const j = NB[b + d]; if (dist[j] === 252) { dist[j] = 0; queue[qt++] = j; } }
    }
  }
  for (let i = 0; i < N; i++) if (dist[i] === 252) dist[i] = 254;
}

class Sim {
  constructor(seed, P) {
    this.params = P;
    this.seed = seed;
    this.seedCount = 0;
    this.tick = 0;

    // ---- parameters as plain numbers (hoisted into locals by the hot loops) ----
    this.totalEnergy0 = P.totalEnergy;
    this.thrStem = P.divThreshStem; this.thrDiff = P.divThreshDiff; this.cooldown = P.divCooldown;
    this.diffAge = P.diffAge; this.shareRate = P.shareRate;
    this.senBase = P.senescence.base; this.senSpread = P.senescence.spread;
    this.maxAgeBase = new Float64Array(8);
    for (let t = 0; t < 8; t++) this.maxAgeBase[t] = P.senescence.base * P.senescence.factor[t];
    this.tipP = P.death.tipP;
    this.bandFrac = Float64Array.of(P.bandFrac.ecto, P.bandFrac.meso, P.bandFrac.endo);
    this.bandMin = Int32Array.of(P.bandMin.ecto, P.bandMin.meso, P.bandMin.endo);
    this.octagonal = P.depthMetric === 'octagonal';
    this.deadband = P.hysteresis.dmaxDeadband; this.persist = P.hysteresis.persist;
    this.margin = P.hysteresis.depthMargin; this.revert = P.hysteresis.terminalRevert;
    this.flipWindow = P.hysteresis.flipWindow;
    this.gMid = P.gates.neuralMid; this.gAP = P.gates.neuralAP;
    this.gMuscle = P.gates.muscleRel; this.gVessel = P.gates.vesselRel; this.specAge = P.gates.mesoSpecializeAge;
    this.refDepth = P.gates.mesoReference === 'depth';
    this.dsub = Int32Array.from(P.diffusion.substeps);
    this.dcoef = new Float64Array(10);  // [rate/sub, decay^(1/sub)] × 4 channels, floor, cap
    for (let m = 0; m < 4; m++) {
      let dec = P.diffusion.decay;
      for (let k = P.diffusion.substeps[m]; k > 1; k >>= 1) dec = Math.sqrt(dec);
      this.dcoef[2 * m] = P.diffusion.rates[m] / P.diffusion.substeps[m];
      this.dcoef[2 * m + 1] = dec;
    }
    this.dcoef[8] = P.diffusion.floor; this.dcoef[9] = P.diffusion.cap;
    const K = P.kinetics, S = P.sources;
    this.kin = Float64Array.of(K.rho, K.sat, K.epsB, K.basal, K.noise, K.inhProd, K.inhDecay, K.cap);
    this.src = Float64Array.of(S.birthAct, S.midline, S.ap, S.ectoMid, S.neuralMid, S.neuralAP, S.mesoAP, S.endoAct,
      2 * S.midlineSigma * S.midlineSigma, S.apScale);
    this.deathInh = S.deathInh;

    // ---- primary state ----
    this.typeA = new Uint8Array(N);      // current types
    this.typeB = new Uint8Array(N);      // next types (ping-pong)
    this.energy = new Float64Array(N);
    this.age = new Uint16Array(N);
    this.maxAge = new Uint16Array(N);
    this.morphA = [new Float32Array(N), new Float32Array(N), new Float32Array(N), new Float32Array(N)];
    this.morphB = [new Float32Array(N), new Float32Array(N), new Float32Array(N), new Float32Array(N)];
    this.pend = new Uint16Array(N);      // consecutive ticks a cell's type has disagreed with its band's fate
    this.bornTick = new Uint32Array(N);
    this.founder = new Uint8Array(N).fill(255);
    this.fateTick = new Uint32Array(N).fill(NEVER);
    this.fateFrom = new Uint8Array(N);
    this.typeSince = new Uint32Array(N);
    this.RS = new Int32Array(4);         // PRNG state

    // ---- derived state and scratch ----
    this.depth = new Uint8Array(N);      // live 1..254; empty 0 = exterior, 255 = interior gap
    this.band = new Uint8Array(N);       // live 1..4; empty 0
    this.dist = new Uint8Array(N);       // BFS scratch: 0 exterior, 1..253 distance, 254/255 unvisited empty/live
    this.scratch = new Float32Array(N);  // intermediate buffer for sub-stepped diffusion
    this.bbA = new Int32Array(16); this.bbB = new Int32Array(16); this.bbS = new Int32Array(4);
    for (let m = 0; m < 4; m++) { this.bbA[m * 4] = 1; this.bbB[m * 4] = 1; }
    this.bbS[0] = 1;
    this.living = new Int32Array(N);
    this.queue = new Int32Array(N);
    this.midCol = new Float64Array(GS); this.apRow = new Float64Array(GS);
    this.actByDepth = new Float64Array(256); this.cntByDepth = new Int32Array(256);
    this.evBuf = new Int32Array(EVENT_CAP * EV_WORDS);
    this.evCount = 0; this.evDropped = 0;
    this.F = new Float64Array(8);        // CX, CY, TOTAL_EN, MEAN_ACT, POOL, RECYCLED, TOTAL_RECYCLED
    this.typeCounts = new Int32Array(8);

    // ---- integer scalars ----
    this.L = 0;
    this.lx0 = 1; this.lx1 = 0; this.ly0 = 1; this.ly1 = 0; // raw bbox of live cells; empty when lx0 > lx1
    this.dmax = 0; this.dRef = 0; this.e1 = 1; this.e2 = 2; this.e3 = 6; this.gaps = 0;
    this.cellCount = 0; this.foundersAlive = 0;
    this.birthsT = 0; this.deathsT = 0; this.fatesT = 0; this.flipsT = 0;
    this.totalBirths = 0; this.totalDeaths = 0; this.totalFates = 0; this.totalFlips = 0;
    this.eventsDropped = 0;

    // ---- public views ----
    this.type = this.typeA;
    this.morph = this.morphA;
    this.bands = { e1: 1, e2: 2, e3: 6 };
    this.prov = { bornTick: this.bornTick, founder: this.founder, fateTick: this.fateTick, fateFrom: this.fateFrom,
      typeSince: this.typeSince };

    this._init(P);
  }

  // Founders: the disk dx²+dy² ≤ seedRadius2 at the grid centre, sharing the total energy equally.
  _init(P) {
    const RS = this.RS, S = P.sources;
    seedRng(RS, this.seed);
    const c0 = GS >> 1, r2 = P.seedRadius2, rr = Math.floor(Math.sqrt(r2));
    let count = 0;
    for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) if (dx * dx + dy * dy <= r2) count++;
    const each = this.totalEnergy0 / count;
    let f = 0;
    for (let dy = -rr; dy <= rr; dy++) {
      for (let dx = -rr; dx <= rr; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const i = (c0 + dy) * GS + (c0 + dx);
        this.typeA[i] = STEM; this.energy[i] = each;
        this.morphA[0][i] = S.founderAct[0] + rng30(RS) * U30 * S.founderAct[1];
        this.maxAge[i] = Math.max(1, this.senBase + Math.floor((rng30(RS) * U30 - 0.5) * this.senSpread));
        this.bornTick[i] = 0; this.founder[i] = f++; this.typeSince[i] = 0;
      }
    }
    for (let r = 1; r <= S.founderAPLen; r++) this.morphA[3][(c0 - r) * GS + c0] += S.founderAPStep * r;
    for (let m = 0; m < 4; m++) tightBBox(this.morphA[m], this.bbA, m * 4);
    this.lx0 = c0 - rr; this.lx1 = c0 + rr; this.ly0 = c0 - rr; this.ly1 = c0 + rr;
    this.F[CX] = c0; this.F[CY] = c0;
    this.seedCount = count;
    this._endPass(false);
    this._publish();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // One tick
  _tick() {
    const tick = ++this.tick;
    const TA = this.typeA, TB = this.typeB;
    TB.set(TA);
    const F = this.F, RS = this.RS;
    // F[POOL] is not reset: _spreadPool empties it whenever a cell is alive, so it can only hold energy here after
    // an extinction, and then it is carried (still counted in totalEnergy) instead of being destroyed.
    this.birthsT = 0; this.deathsT = 0; this.fatesT = 0; this.flipsT = 0; F[RECYCLED] = 0;
    const energy = this.energy, age = this.age, maxAge = this.maxAge, pend = this.pend;
    const depth = this.depth, band = this.band, living = this.living, L = this.L;
    const bornTick = this.bornTick, founder = this.founder, fateTick = this.fateTick, fateFrom = this.fateFrom;
    const typeSince = this.typeSince;

    // 1. Diffusion of the four fields into morphB (the inhibitor in 2 stable sub-steps).
    const morphA = this.morphA, morphB = this.morphB, bbA = this.bbA, bbB = this.bbB, bbS = this.bbS;
    const coef = this.dcoef, dsub = this.dsub, scratch = this.scratch;
    for (let m = 0; m < 4; m++) {
      const sub = dsub[m], o = m * 4;
      if (sub === 1) {
        diffuse(morphA[m], morphB[m], coef, m, bbA, o, bbB, o);
      } else {
        let src = morphA[m], sbb = bbA, so = o;
        for (let k = 0; k < sub - 1; k++) {
          // ping-pong between scratch and morphB; the last sub-step always lands in morphB
          const toScratch = ((sub - 1 - k) & 1) === 1;
          const dst = toScratch ? scratch : morphB[m];
          const dbb = toScratch ? bbS : bbB, dof = toScratch ? 0 : o;
          diffuse(src, dst, coef, m, sbb, so, dbb, dof);
          src = dst; sbb = dbb; so = dof;
        }
        diffuse(src, morphB[m], coef, m, sbb, so, bbB, o);
      }
      unionLivingBBox(bbB, o, this.lx0, this.lx1, this.ly0, this.ly1);
    }
    const m0 = morphB[0], m1 = morphB[1], m2 = morphB[2], m3 = morphB[3];

    // 2. Gierer–Meinhardt reaction on live cells (raster order), the tissue-mean and per-depth-mean activator.
    const kin = this.kin;
    const K_RHO = kin[0], K_SAT = kin[1], K_EPS = kin[2], K_BASAL = kin[3], K_NOISE = kin[4];
    const K_PROD = kin[5], K_DECAY = kin[6], K_CAP = kin[7];
    const refDepth = this.refDepth, actByDepth = this.actByDepth, cntByDepth = this.cntByDepth;
    let sumA = 0;
    if (refDepth) { actByDepth.fill(0); cntByDepth.fill(0); }
    for (let k = 0; k < L; k++) {
      const i = living[k];
      const a = m0[i], b = m1[i], a2 = a * a;
      let na = a + K_RHO * a2 / ((b + K_EPS) * (1 + K_SAT * a2)) + K_BASAL + (rng30(RS) * U30 - 0.5) * K_NOISE;
      na = na < 0 ? 0 : na > K_CAP ? K_CAP : na;
      let nb = b + K_PROD * a2 - K_DECAY * b;
      nb = nb < 0 ? 0 : nb > K_CAP ? K_CAP : nb;
      m0[i] = na; m1[i] = nb;
      sumA += m0[i];
      if (refDepth) { const d = depth[i]; actByDepth[d] += m0[i]; cntByDepth[d]++; }
    }
    if (refDepth) for (let d = 1; d < 256; d++) if (cntByDepth[d] > 0) actByDepth[d] /= cntByDepth[d];
    const meanAct = L > 0 ? sumA / L : 0;
    F[MEAN_ACT] = meanAct;
    const muscleGate = refDepth ? this.gMuscle : this.gMuscle * meanAct;
    const vesselGate = refDepth ? this.gVessel : this.gVessel * meanAct;

    // 3. Energy sharing with the right and lower neighbours (in-place raster sweep over the old types).
    const SHARE = this.shareRate;
    for (let k = 0; k < L; k++) {
      const i = living[k], b = i << 2;
      const ri = NB[b];
      if (TA[ri] !== 0) { const f = (energy[i] - energy[ri]) * SHARE; energy[i] -= f; energy[ri] += f; }
      const di = NB[b + 2];
      if (TA[di] !== 0) { const f = (energy[i] - energy[di]) * SHARE; energy[i] -= f; energy[di] += f; }
    }

    // 4. Random update order.
    for (let k = L - 1; k > 0; k--) {
      const j = Math.floor(rng30(RS) * U30 * (k + 1));
      const tmp = living[k]; living[k] = living[j]; living[j] = tmp;
    }

    // 5. Positional sources from the (toroidal-safe) centroid of the old state.
    const src = this.src, midCol = this.midCol, apRow = this.apRow;
    const S_BIRTH_ACT = src[0], S_MID = src[1], S_AP = src[2], S_ECTO_MID = src[3], S_NEURAL_MID = src[4];
    const S_NEURAL_AP = src[5], S_MESO_AP = src[6], S_ENDO_ACT = src[7], MID_DENOM = src[8], AP_SCALE = src[9];
    const cx = F[CX], cy = F[CY];
    for (let x = 0; x < GS; x++) {
      let dx = x - cx;
      if (dx > GS / 2) dx -= GS; else if (dx <= -GS / 2) dx += GS;
      midCol[x] = expNeg(dx * dx / MID_DENOM) * S_MID;
    }
    for (let y = 0; y < GS; y++) {
      let dy = y - cy;
      if (dy > GS / 2) dy -= GS; else if (dy <= -GS / 2) dy += GS;
      apRow[y] = dy < 0 ? (-dy / AP_SCALE) * S_AP : 0;
    }

    // 6. Life cycle of every live cell, in random order, writing into typeB.
    const THR_STEM = this.thrStem, THR_DIFF = this.thrDiff, COOLDOWN = this.cooldown, DIFF_AGE = this.diffAge;
    const TIP_P = this.tipP, MARGIN = this.margin, PERSIST = this.persist, REVERT = this.revert;
    const G_MID = this.gMid, G_AP = this.gAP, SPEC_AGE = this.specAge;
    const e1 = this.e1, e2 = this.e2, e3 = this.e3;
    for (let k = 0; k < L; k++) {
      const i = living[k], b = i << 2, t = TA[i];
      const a0 = age[i];
      const na = a0 < 65535 ? a0 + 1 : 65535;
      age[i] = na;

      // Rule 2: die
      let cause = -1;
      if (na > maxAge[i]) cause = 0;
      else {
        const ln = (TA[NB[b]] !== 0 ? 1 : 0) + (TA[NB[b + 1]] !== 0 ? 1 : 0) + (TA[NB[b + 2]] !== 0 ? 1 : 0) + (TA[NB[b + 3]] !== 0 ? 1 : 0);
        if (ln === 0) cause = 1;
        else if (ln === 1 && rng30(RS) * U30 < TIP_P) cause = 2;
      }
      if (cause >= 0) { die(this, TB, i, t, cause, m1); continue; }

      // Rule 1: divide into a random free neighbour
      const e = energy[i];
      if (e > (t === STEM ? THR_STEM : THR_DIFF) && na > COOLDOWN) {
        const f0 = TB[NB[b]] === 0, f1 = TB[NB[b + 1]] === 0, f2 = TB[NB[b + 2]] === 0, f3 = TB[NB[b + 3]] === 0;
        const nf = (f0 ? 1 : 0) + (f1 ? 1 : 0) + (f2 ? 1 : 0) + (f3 ? 1 : 0);
        if (nf > 0) {
          let pick = nf > 1 ? Math.floor(rng30(RS) * U30 * nf) : 0, d = -1;
          if (f0) { if (pick === 0) d = 0; pick--; }
          if (d < 0 && f1) { if (pick === 0) d = 1; pick--; }
          if (d < 0 && f2) { if (pick === 0) d = 2; pick--; }
          if (d < 0 && f3) { if (pick === 0) d = 3; }
          const ni = NB[b + d];
          const half = e * 0.5;
          energy[i] = half; energy[ni] = e - half;
          TB[ni] = STEM; age[i] = 0; age[ni] = 0; maxAge[ni] = assignMaxAge(this, STEM);
          m0[ni] += S_BIRTH_ACT;
          bornTick[ni] = tick; founder[ni] = founder[i]; fateTick[ni] = NEVER; fateFrom[ni] = 0;
          typeSince[ni] = tick; pend[ni] = 0;
          this.birthsT++;
          pushEvent(this, EV_BIRTH, ni, i, d);
        }
      }

      // Signals: positional and type-specific deposits
      m2[i] += midCol[COL[i]];
      m3[i] += apRow[ROW[i]];
      if (t === ECTO) m2[i] += S_ECTO_MID;
      else if (t === NEURAL) { m2[i] += S_NEURAL_MID; m3[i] += S_NEURAL_AP; }
      else if (t === MESO || t === MUSCLE) m3[i] += S_MESO_AP;
      else if (t === ENDO) m0[i] += S_ENDO_ACT;

      // Rule 3: depth → fate, continuously, with hysteresis. A cell keeps its own band while its depth is within
      // ±MARGIN of it, and changes only after PERSIST consecutive ticks of disagreement.
      let bd = band[i];
      if (MARGIN !== 0) {
        const fb = FAM_BAND[t];
        if (fb !== bd) {
          const d = depth[i];
          if (fb >= bandOfDepth(d - MARGIN, e1, e2, e3) && fb <= bandOfDepth(d + MARGIN, e1, e2, e3)) bd = fb;
        }
      }
      if (t <= ENDO) {
        const target = bd === 1 ? (m2[i] > G_MID && m3[i] > G_AP ? NEURAL : ECTO) : RULE_FATE[bd];
        if (target !== t) {
          const p = pend[i] < 65535 ? pend[i] + 1 : 65535;
          pend[i] = p;
          if (a0 > DIFF_AGE && p >= PERSIST) {
            setFate(this, TB, i, t, target, bd);
            if (t === STEM) { maxAge[i] = assignMaxAge(this, target); age[i] = 0; }
            continue;
          }
        } else pend[i] = 0;
      } else if (REVERT > 0) {
        // terminal types keep their fate while in their own band; buried (or exposed) long enough, they revert
        const home = t === NEURAL ? 1 : 2;
        if (bd !== home) {
          const p = pend[i] < 65535 ? pend[i] + 1 : 65535;
          pend[i] = p;
          if (p >= REVERT) {
            setFate(this, TB, i, t, bd === 1 ? (m2[i] > G_MID && m3[i] > G_AP ? NEURAL : ECTO) : RULE_FATE[bd], bd);
            continue;
          }
        } else pend[i] = 0;
      }

      // Mesoderm specialisation by the activator pattern, relative to the mean activator at the same depth
      if (t === MESO && tick - typeSince[i] > SPEC_AGE) {
        const act = m0[i];
        const ref = refDepth ? actByDepth[depth[i]] : 1;
        if (act > muscleGate * ref) { setFate(this, TB, i, MESO, MUSCLE, bd); maxAge[i] = assignMaxAge(this, MUSCLE); age[i] = 0; }
        else if (act < vesselGate * ref) { setFate(this, TB, i, MESO, VESSEL, bd); maxAge[i] = assignMaxAge(this, VESSEL); age[i] = 0; }
      }
    }

    // 7. Energy that found no live cell within radius 2 is spread evenly over all live cells.
    if (F[POOL] !== 0) this._spreadPool(TB);

    // 8. Swap and derive the new state's depth, bands, living list and tallies.
    this.typeA = TB; this.typeB = TA;
    this.morphA = morphB; this.morphB = morphA;
    this.bbA = bbB; this.bbB = bbA;
    this._endPass(false);
    this.totalBirths += this.birthsT; this.totalDeaths += this.deathsT;
    this.totalFates += this.fatesT; this.totalFlips += this.flipsT;
    F[TOTAL_RECYCLED] += F[RECYCLED];
  }

  _spreadPool(T) {
    // rare (orphan deaths with no live cell within radius 2); scans the region that can hold live cells
    let x0 = this.lx0 - 1, x1 = this.lx1 + 1, y0 = this.ly0 - 1, y1 = this.ly1 + 1;
    if (x0 < 0 || x1 > GS - 1 || y0 < 0 || y1 > GS - 1) { x0 = 0; x1 = GS - 1; y0 = 0; y1 = GS - 1; }
    let n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (T[y * GS + x] !== 0) n++;
    if (n === 0) return; // extinction: the pool is carried (and still counted in totalEnergy)
    const each = this.F[POOL] / n, energy = this.energy;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (T[y * GS + x] !== 0) energy[y * GS + x] += each;
    this.F[POOL] = 0;
  }

  // End-of-tick pass over the region that can hold live cells (previous living bbox + 2): tallies, raster living
  // list, centroid, living bbox, exterior flood fill, exterior depth BFS, dRef hysteresis, bands.
  _endPass(restoring) {
    const T = this.typeA, F = this.F, energy = this.energy, bornTick = this.bornTick;
    const dist = this.dist, queue = this.queue, living = this.living, depth = this.depth, band = this.band;
    const typeCounts = this.typeCounts;
    let xa = this.lx0 - 2, xb = this.lx1 + 2, ya = this.ly0 - 2, yb = this.ly1 + 2;
    let full = false;
    if (this.lx0 > this.lx1) { xa = 1; xb = 0; ya = 1; yb = 0; }
    else if (xa < 0 || xb > GS - 1 || ya < 0 || yb > GS - 1) { full = true; xa = 0; xb = GS - 1; ya = 0; yb = GS - 1; }

    // (a) tallies and scratch init
    typeCounts.fill(0);
    let n = 0, sum = 0, comp = 0, fa = 0;
    let bx0 = GS, bx1 = -1, by0 = GS, by1 = -1;
    let sx = 0, sy = 0;
    const rx = Math.round(F[CX]) % GS, ry = Math.round(F[CY]) % GS;
    for (let y = ya; y <= yb; y++) {
      const row = y * GS;
      for (let x = xa; x <= xb; x++) {
        const i = row + x, c = T[i];
        if (c === 0) { dist[i] = 254; continue; }
        dist[i] = 255;
        typeCounts[c]++;
        living[n++] = i;
        const e = energy[i], s2 = sum + e;           // Neumaier compensated sum
        comp += Math.abs(sum) >= Math.abs(e) ? (sum - s2) + e : (e - s2) + sum;
        sum = s2;
        if (bornTick[i] === 0) fa++;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        by1 = y;
        if (full) {
          let dx = x - rx, dy = y - ry;
          if (dx > GS / 2) dx -= GS; else if (dx <= -GS / 2) dx += GS;
          if (dy > GS / 2) dy -= GS; else if (dy <= -GS / 2) dy += GS;
          sx += dx; sy += dy;
        } else { sx += x; sy += y; }
      }
    }
    this.L = n; this.cellCount = n; this.foundersAlive = fa;
    F[TOTAL_EN] = sum + comp + F[POOL];
    this.lx0 = bx0; this.lx1 = bx1; this.ly0 = by0; this.ly1 = by1;
    if (!restoring && n > 0) {
      if (full) {
        let x = rx + sx / n, y = ry + sy / n;
        if (x < 0) x += GS; else if (x >= GS) x -= GS;
        if (y < 0) y += GS; else if (y >= GS) y -= GS;
        F[CX] = x; F[CY] = y;
      } else { F[CX] = sx / n; F[CY] = sy / n; }
    }
    if (xa > xb) { this.dmax = 0; this.gaps = 0; if (!restoring) this._updateBands(0); else this._bandEdges(); return; }

    // (b) exterior: the empty region connected to the frame of the region (normal case) or the largest empty
    //     component (fallback when the organism nears the torus seam)
    let qt = 0;
    if (!full) {
      for (let x = xa; x <= xb; x++) {
        const top = ya * GS + x, bot = yb * GS + x;
        dist[top] = 0; queue[qt++] = top;
        dist[bot] = 0; queue[qt++] = bot;
      }
      for (let y = ya + 1; y < yb; y++) {
        const l = y * GS + xa, r = y * GS + xb;
        dist[l] = 0; queue[qt++] = l;
        dist[r] = 0; queue[qt++] = r;
      }
      floodExterior(dist, queue, qt);
    } else {
      largestEmptyComponentAsExterior(dist, queue);
    }

    // (c) depth BFS from the live cells that touch the exterior, through tissue and interior gaps
    qt = 0;
    for (let k = 0; k < n; k++) {
      const i = living[k], b = i << 2;
      if (dist[NB[b]] === 0 || dist[NB[b + 1]] === 0 || dist[NB[b + 2]] === 0 || dist[NB[b + 3]] === 0) {
        dist[i] = 1; queue[qt++] = i;
      }
    }
    const OCT = this.octagonal;
    let head = 0;
    while (head < qt) {
      const c = queue[head++], b = c << 2, dc = dist[c];
      const nd = dc < 253 ? dc + 1 : 253;
      let j = NB[b];     if (dist[j] >= 254) { dist[j] = nd; queue[qt++] = j; }
      j = NB[b + 1];     if (dist[j] >= 254) { dist[j] = nd; queue[qt++] = j; }
      j = NB[b + 2];     if (dist[j] >= 254) { dist[j] = nd; queue[qt++] = j; }
      j = NB[b + 3];     if (dist[j] >= 254) { dist[j] = nd; queue[qt++] = j; }
      if (OCT && (dc & 1) === 1) {   // odd rings also step diagonally
        j = NBD[b];      if (dist[j] >= 254) { dist[j] = nd; queue[qt++] = j; }
        j = NBD[b + 1];  if (dist[j] >= 254) { dist[j] = nd; queue[qt++] = j; }
        j = NBD[b + 2];  if (dist[j] >= 254) { dist[j] = nd; queue[qt++] = j; }
        j = NBD[b + 3];  if (dist[j] >= 254) { dist[j] = nd; queue[qt++] = j; }
      }
    }
    let dm = 0;
    for (let k = 0; k < n; k++) { const d = dist[living[k]]; if (d > dm) dm = d; }
    this.dmax = dm;
    if (!restoring) this._updateBands(dm); else this._bandEdges();
    const e1 = this.e1, e2 = this.e2, e3 = this.e3;

    // (d) write depth and band for the whole region
    let g = 0;
    for (let y = ya; y <= yb; y++) {
      const row = y * GS;
      for (let x = xa; x <= xb; x++) {
        const i = row + x, d = dist[i];
        if (T[i] !== 0) {
          depth[i] = d;
          band[i] = d <= e1 ? 1 : d <= e2 ? 2 : d < e3 ? 3 : 4;
        } else {
          band[i] = 0;
          if (d === 0) depth[i] = 0; else { depth[i] = 255; g++; }
        }
      }
    }
    this.gaps = g;
  }

  // dRef follows dmax through a deadband so the band edges do not flicker when the deepest cell dies or is born.
  _updateBands(dm) {
    const db = this.deadband;
    if (this.tick === 0 && this.dRef === 0) this.dRef = dm;
    else if (dm > this.dRef + db) this.dRef = dm - db;
    else if (dm < this.dRef - db) this.dRef = dm + db;
    this._bandEdges();
  }
  _bandEdges() {
    const bf = this.bandFrac, bm = this.bandMin, d = this.dRef;
    const a = Math.round(bf[0] * d), b = Math.round(bf[1] * d), c = Math.ceil(bf[2] * d);
    this.e1 = a > bm[0] ? a : bm[0];
    this.e2 = b > bm[1] ? b : bm[1];
    this.e3 = c > bm[2] ? c : bm[2];
  }

  _publish() {
    this.type = this.typeA; this.morph = this.morphA;
    this.bands.e1 = this.e1; this.bands.e2 = this.e2; this.bands.e3 = this.e3;
  }

  // The band Rule 3 applies to cell i of type t: its exact band, unless its own band is within ±margin depth.
  _ruleBand(i, t) {
    const bd = this.band[i], fb = FAM_BAND[t];
    if (this.margin === 0 || fb === bd) return bd;
    const d = this.depth[i], e1 = this.e1, e2 = this.e2, e3 = this.e3;
    return (fb >= bandOfDepth(d - this.margin, e1, e2, e3) && fb <= bandOfDepth(d + this.margin, e1, e2, e3)) ? fb : bd;
  }
  _ruleFate(i, bd) {
    if (bd === 1) return (this.morphA[2][i] > this.gMid && this.morphA[3][i] > this.gAP) ? NEURAL : ECTO;
    return RULE_FATE[bd];
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Public API

  // Advance n ticks. Arrays may be swapped (ping-pong): re-read sim.type / sim.morph after every step.
  step(n = 1) {
    for (let k = 0; k < n; k++) this._tick();
    this._publish();
  }

  // Copies pending events into `out` (EV_WORDS ints each) and returns how many were copied. Events that do not fit
  // stay queued for the next call. Afterwards `sim.eventsDropped` is the number lost to ring overflow since the
  // previous drain.
  drainEvents(out) {
    const cap = out.length >> 2, have = this.evCount, E = this.evBuf; // EV_WORDS = 4
    const n = have < cap ? have : cap, w = n << 2;
    for (let j = 0; j < w; j++) out[j] = E[j];
    if (n < have) E.copyWithin(0, w, have << 2);
    this.evCount = have - n;
    this.eventsDropped = this.evDropped; this.evDropped = 0;
    return n;
  }

  stats() {
    const F = this.F, cx = F[CX], cy = F[CY], living = this.living;
    let rMax2 = 0;
    for (let k = 0; k < this.L; k++) {
      const i = living[k];
      let dx = COL[i] - cx, dy = ROW[i] - cy;
      if (dx > GS / 2) dx -= GS; else if (dx <= -GS / 2) dx += GS;
      if (dy > GS / 2) dy -= GS; else if (dy <= -GS / 2) dy += GS;
      const d2 = dx * dx + dy * dy;
      if (d2 > rMax2) rMax2 = d2;
    }
    return {
      tick: this.tick, cellCount: this.cellCount, typeCounts: new Int32Array(this.typeCounts),
      totalEnergy: F[TOTAL_EN], energyLost: 0, // no code path destroys energy (orphans → radius 2 → global pool)
      birthsThisTick: this.birthsT, deathsThisTick: this.deathsT, fatesThisTick: this.fatesT,
      totalBirths: this.totalBirths, totalDeaths: this.totalDeaths, totalFates: this.totalFates,
      cx, cy, rMax: Math.sqrt(rMax2), dmax: this.dmax, dRef: this.dRef,
      bands: { e1: this.e1, e2: this.e2, e3: this.e3 }, gaps: this.gaps, foundersAlive: this.foundersAlive,
      meanAct: F[MEAN_ACT], recycledThisTick: F[RECYCLED], totalRecycled: F[TOTAL_RECYCLED],
      flipFlopsThisTick: this.flipsT, totalFlipFlops: this.totalFlips,
    };
  }

  // CellDetail for the inspector, or null for an empty cell. `band` is the band at the cell's current depth;
  // `ruleBand` is the band Rule 3 applies (its own band while within the ±depthMargin hysteresis); `ruleFate` is
  // that band's fate; `pending` counts consecutive ticks of disagreement.
  readCell(idx) {
    if (!(idx >= 0 && idx < N) || this.typeA[idx] === 0) return null;
    const t = this.typeA[idx], m = this.morphA, rb = this._ruleBand(idx, t);
    const threshold = t === STEM ? this.thrStem : this.thrDiff;
    const ft = this.fateTick[idx];
    return {
      idx, x: COL[idx], y: ROW[idx], tick: this.tick, type: t, energy: this.energy[idx], threshold,
      age: this.age[idx], maxAge: this.maxAge[idx], depth: this.depth[idx], band: this.band[idx], ruleBand: rb,
      ruleFate: this._ruleFate(idx, rb),
      ready: this.energy[idx] > threshold && this.age[idx] + 1 > this.cooldown,
      act: m[0][idx], inh: m[1][idx], mid: m[2][idx], ap: m[3][idx],
      bornTick: this.bornTick[idx], founder: this.founder[idx] === 255 ? null : this.founder[idx],
      fateTick: ft === NEVER ? null : ft, fateFrom: ft === NEVER ? null : this.fateFrom[idx],
      typeSince: this.typeSince[idx], pending: this.pend[idx],
    };
  }

  getRngState(out = new Uint32Array(4)) {
    const RS = this.RS;
    out[0] = RS[0] >>> 0; out[1] = RS[1] >>> 0; out[2] = RS[2] >>> 0; out[3] = RS[3] >>> 0;
    return out;
  }

  // Transferable snapshot: every buffer is a fresh ArrayBuffer (≈1.8 MB in total).
  snapshot() {
    const F = this.F, cp = (a) => a.slice().buffer;
    return {
      kind: SNAPSHOT_KIND, version: ENGINE_VERSION, seed: this.seed, tick: this.tick, rng: this.getRngState(),
      meta: {
        cx: F[CX], cy: F[CY], dRef: this.dRef, meanAct: F[MEAN_ACT], pool: F[POOL],
        birthsT: this.birthsT, deathsT: this.deathsT, fatesT: this.fatesT, flipsT: this.flipsT, recycledT: F[RECYCLED],
        totalBirths: this.totalBirths, totalDeaths: this.totalDeaths, totalFates: this.totalFates,
        totalFlips: this.totalFlips, totalRecycled: F[TOTAL_RECYCLED],
      },
      buffers: {
        type: cp(this.typeA), energy: cp(this.energy), age: cp(this.age), maxAge: cp(this.maxAge),
        morph0: cp(this.morphA[0]), morph1: cp(this.morphA[1]), morph2: cp(this.morphA[2]), morph3: cp(this.morphA[3]),
        pend: cp(this.pend), bornTick: cp(this.bornTick), founder: cp(this.founder), fateTick: cp(this.fateTick),
        fateFrom: cp(this.fateFrom), typeSince: cp(this.typeSince),
      },
    };
  }

  // Exact: restore(snapshot(t)) followed by step(k) is bit-identical to an uninterrupted run (same params).
  restore(snap) {
    if (!snap || snap.version !== ENGINE_VERSION) throw new Error('snapshot version mismatch');
    const B = snap.buffers, F = this.F, M = snap.meta;
    this.typeA.set(new Uint8Array(B.type)); this.typeB.fill(0);
    this.energy.set(new Float64Array(B.energy));
    this.age.set(new Uint16Array(B.age)); this.maxAge.set(new Uint16Array(B.maxAge));
    for (let m = 0; m < 4; m++) { this.morphA[m].set(new Float32Array(B['morph' + m])); this.morphB[m].fill(0); }
    this.scratch.fill(0);
    this.pend.set(new Uint16Array(B.pend)); this.bornTick.set(new Uint32Array(B.bornTick));
    this.founder.set(new Uint8Array(B.founder)); this.fateTick.set(new Uint32Array(B.fateTick));
    this.fateFrom.set(new Uint8Array(B.fateFrom)); this.typeSince.set(new Uint32Array(B.typeSince));
    for (let m = 0; m < 4; m++) { tightBBox(this.morphA[m], this.bbA, m * 4); this.bbB[m * 4] = 1; this.bbB[m * 4 + 1] = 0; }
    this.bbS[0] = 1; this.bbS[1] = 0;
    this.depth.fill(0); this.band.fill(0); this.dist.fill(0);
    for (let k = 0; k < 4; k++) this.RS[k] = snap.rng[k] | 0;
    this.tick = snap.tick; this.seed = snap.seed >>> 0;
    F[CX] = M.cx; F[CY] = M.cy; F[MEAN_ACT] = M.meanAct; F[POOL] = M.pool; F[RECYCLED] = M.recycledT;
    F[TOTAL_RECYCLED] = M.totalRecycled; this.dRef = M.dRef;
    this.birthsT = M.birthsT; this.deathsT = M.deathsT; this.fatesT = M.fatesT; this.flipsT = M.flipsT;
    this.totalBirths = M.totalBirths; this.totalDeaths = M.totalDeaths; this.totalFates = M.totalFates;
    this.totalFlips = M.totalFlips;
    // living bbox of the restored state (full scan), then the regular end pass without touching cx/cy/dRef
    let x0 = GS, x1 = -1, y0 = GS, y1 = -1;
    for (let i = 0; i < N; i++) {
      if (this.typeA[i] === 0) continue;
      const x = COL[i], y = ROW[i];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 < 0) { this.lx0 = 1; this.lx1 = 0; this.ly0 = 1; this.ly1 = 0; }
    else { this.lx0 = x0; this.lx1 = x1; this.ly0 = y0; this.ly1 = y1; }
    this.evCount = 0; this.evDropped = 0; this.eventsDropped = 0;
    this._endPass(true);
    this._publish();
  }
}

// Public entry point. Methods are bound, so `const { step } = sim` also works.
export function createSim({ seed = 1, params = {} } = {}) {
  const sim = new Sim(seed >>> 0, mergeParams(params));
  for (const k of ['step', 'drainEvents', 'stats', 'readCell', 'snapshot', 'restore', 'getRngState']) sim[k] = sim[k].bind(sim);
  return sim;
}

// FNV-1a (32-bit) over type, energy bits, age and the PRNG state: a cheap fingerprint for determinism tests.
export function hashState(sim) {
  let h = 0x811C9DC5;
  const eat = (u8) => { for (let k = 0; k < u8.length; k++) h = Math.imul(h ^ u8[k], 16777619); };
  eat(sim.type);
  eat(new Uint8Array(sim.energy.buffer, sim.energy.byteOffset, sim.energy.byteLength));
  eat(new Uint8Array(sim.age.buffer, sim.age.byteOffset, sim.age.byteLength));
  eat(new Uint8Array(sim.getRngState().buffer));
  return (h >>> 0).toString(16).padStart(8, '0');
}
