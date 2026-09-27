// dev/engine-v09-adapter.js: the v0.9 physics from classic.html behind the v1.0 createSim() API (ADDENDUM §A.2).
//
// Dev and legacy use only. The worker loads it with INIT { engine: 'v09' }, so the pipeline can run before
// src/engine.js lands and the old rules can be compared with the new ones. The rules are classic.html's simStep()
// (same order, thresholds, gates and float32 energy). Four changes do not touch the rules:
//   • a seeded PRNG (sfc32 via splitmix32) replaces Math.random, so a seed replays and snapshots resume exactly;
//   • buffers are preallocated and ping-ponged, with neighbour tables in place of modulo (no per-tick allocation);
//   • births, deaths and fate changes are recorded as shared.js events, with per-cell provenance;
//   • `depth` is the exterior depth of the v1 contract, computed lazily. v0.9's own rule depth (the distance to the
//     nearest empty cell of ANY kind, gaps included) drives the rules and `band`, and is exposed as `ruleDepth`.
// The artifacts found by the audit are kept on purpose: orphan deaths destroy energy (stats().energyLost counts it),
// the inhibitor diffuses unstably (r = 0.325), and interior gaps count as surfaces. This is the old engine, warts
// and all.

import { N, EV, EV_WORDS } from '../src/shared.js';

export const ENGINE_VERSION = '0.9.0-adapter';

const GS = 200;
const EMPTY = 0, STEM = 1, ECTO = 2, MESO = 3, ENDO = 4, NERVE = 5, MUSCLE = 6, VESSEL = 7;

// v0.9 constants (classic.html)
const TOTAL_E = 250000;
const DIV_THRESH = 30;
const DIFF_DIV_MULT = 1.4;
const DIV_COOLDOWN = 14;
const SENESCENCE = 500;
const SEN_SPREAD = 150;
const SHARE_RATE = 0.05;
const M_DIFF = 0.13;
const M_DECAY = 0.96;
const NOISE = 0.02;
const DIFF_AGE = 12;
const RATES = [M_DIFF, M_DIFF * 2.5, M_DIFF * 1.8, M_DIFF * 1.6];
const LIFE_MULT = [1, 0.6, 1.3, 0.9, 1.4, 2.5, 1.6, 1.8]; // assignMaxAge() factors by type
const THR_DIFF = DIV_THRESH * DIFF_DIV_MULT;
const NEVER = 0xFFFFFFFF;
const EVENT_CAP = 16384;

const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };

export const PARAMS = deepFreeze({
  legacy: 'v0.9',
  totalEnergy: TOTAL_E, divThreshStem: DIV_THRESH, divThreshDiff: THR_DIFF, divCooldown: DIV_COOLDOWN,
  diffAge: DIFF_AGE, shareRate: SHARE_RATE,
  senescence: { base: SENESCENCE, spread: SEN_SPREAD, factor: LIFE_MULT },
  // v0.9 bands are fixed, not relative: rule depth 1 → ecto, 2 → meso, 3..5 → endo, ≥ 6 → stem.
  bandFrac: { ecto: 0, meso: 0, endo: 0 }, bandMin: { ecto: 1, meso: 2, endo: 6 },
  hysteresis: { dmaxDeadband: 0, depthMargin: 0, persist: 0, terminalRevert: 0, flipWindow: 50 },
  gates: {
    neuralMid: 0.18, neuralAP: 0.18, mesoSpecializeAge: 40,
    // v0.9's absolute gates. muscleRel/vesselRel keep the v1 key names defined; v0.9 does not use them.
    muscleAct: 0.25, muscleInh: 0.12, vesselAct: 0.08, vesselInh: 0.18, stemDeathInh: 1.8,
    muscleRel: 1.2, vesselRel: 0.8,
  },
  diffusion: { rates: RATES, decay: M_DECAY, substeps: [1, 1, 1, 1] },
  kinetics: { model: 'v0.9', rate: 0.02, basal: 0.04, noise: NOISE, cap: 8 },
});

// Display domains from this adapter (p99 of live cells, seed 1, T1000..T5000: act 0.11, inh 7.84, mid 0.28, A–P 0.37).
// The activator domain is kept wide enough to show the muscle gate, which v0.9 never reaches.
export const FIELD_INFO = deepFreeze([
  { key: 'activator', label: 'Activator', channel: 0, domain: [0, 0.3], scale: 'linear',
    gates: [{ v: 0.25, label: 'Muscle (act > 0.25)' }, { v: 0.08, label: 'Vessel (act < 0.08)' }] },
  { key: 'inhibitor', label: 'Inhibitor', channel: 1, domain: [0, 8], scale: 'sqrt',
    gates: [{ v: 1.8, label: 'Stem death (> 1.8)' }] },
  { key: 'midline', label: 'Midline', channel: 2, domain: [0, 0.4], scale: 'linear', gates: [{ v: 0.18, label: 'Neural gate' }] },
  { key: 'ap', label: 'A–P', channel: 3, domain: [0, 0.5], scale: 'linear', gates: [{ v: 0.18, label: 'Neural gate' }] },
]);

// NB[4i + d] = toroidal neighbour of i in direction d (shared.js DX/DY order: +x, −x, +y, −y).
const NB = new Int32Array(4 * N);
for (let y = 0; y < GS; y++) {
  for (let x = 0; x < GS; x++) {
    const i = y * GS + x;
    NB[4 * i] = y * GS + ((x + 1) % GS);
    NB[4 * i + 1] = y * GS + ((x + GS - 1) % GS);
    NB[4 * i + 2] = ((y + 1) % GS) * GS + x;
    NB[4 * i + 3] = ((y + GS - 1) % GS) * GS + x;
  }
}

const bandOfRuleDepth = (d) => (d <= 1 ? 1 : d === 2 ? 2 : d <= 5 ? 3 : 4);

export function createSim({ seed = 1 } = {}) {
  seed = seed >>> 0;

  // ---- state (ping-pong: cur is the published state, nxt is written during a tick) ----
  let tA = new Uint8Array(N), tB = new Uint8Array(N);
  let eA = new Float32Array(N), eB = new Float32Array(N);
  let aA = new Uint16Array(N), aB = new Uint16Array(N);
  let mA = new Uint16Array(N), mB = new Uint16Array(N);
  let morA = [0, 1, 2, 3].map(() => new Float32Array(N));
  let morB = [0, 1, 2, 3].map(() => new Float32Array(N));
  const prov = {
    bornTick: new Uint32Array(N), founder: new Uint8Array(N).fill(255),
    fateTick: new Uint32Array(N).fill(NEVER), fateFrom: new Uint8Array(N), typeSince: new Uint32Array(N),
  };

  // ---- derived / scratch ----
  const ruleDepth = new Uint8Array(N);   // v0.9 depth (nearest empty, gaps included) for the current state
  const band = new Uint8Array(N);        // bandOfRuleDepth(ruleDepth) for live cells, 0 for empty
  const ext = new Uint8Array(N);         // exterior depth (v1 contract), computed lazily
  let extTick = -1, dmax = 0, gaps = 0;
  const queue = new Int32Array(N);
  const living = new Int32Array(N);
  const order = new Int8Array(4);
  const evBuf = new Int32Array(EVENT_CAP * EV_WORDS);
  let evCount = 0, evDropped = 0;

  // ---- scalars ----
  let tick = 0, cellCount = 0;
  let birthsT = 0, deathsT = 0, fatesT = 0, totalBirths = 0, totalDeaths = 0, totalFates = 0;
  let energyLost = 0;                     // orphan deaths destroy energy in v0.9
  const typeCounts = new Int32Array(8);

  // ---- PRNG: sfc32 seeded through splitmix32 ----
  const RS = new Int32Array(4);
  function rand() {
    const a = RS[0], b = RS[1], c = RS[2], d = (RS[3] + 1) | 0;
    const t = (((a + b) | 0) + d) | 0;
    RS[0] = b ^ (b >>> 9);
    RS[1] = (c + (c << 3)) | 0;
    RS[2] = (((c << 21) | (c >>> 11)) + t) | 0;
    RS[3] = d;
    return (t >>> 0) / 4294967296;
  }
  function seedRng(s) {
    let z = s | 0;
    for (let k = 0; k < 4; k++) {
      z = (z + 0x9E3779B9) | 0;
      let t = z ^ (z >>> 16); t = Math.imul(t, 0x21F0AAAD);
      t ^= t >>> 15; t = Math.imul(t, 0x735A2D97);
      RS[k] = t ^ (t >>> 15);
    }
    for (let k = 0; k < 12; k++) rand();
  }

  const assignMaxAge = (type) => Math.floor(SENESCENCE * LIFE_MULT[type] + (rand() - 0.5) * SEN_SPREAD);

  function pushEvent(kind, idx, a, b) {
    if (evCount >= EVENT_CAP) { evDropped++; return; }
    const o = evCount * EV_WORDS;
    evBuf[o] = kind | (idx << 8); evBuf[o + 1] = tick; evBuf[o + 2] = a; evBuf[o + 3] = b;
    evCount++;
  }

  // v0.9 computeDepth(): 4-neighbour BFS distance to the nearest empty cell, for live cells. Also band + counts.
  function computeRuleDepth() {
    const t = tA;
    let head = 0, tail = 0;
    cellCount = 0; typeCounts.fill(0);
    for (let i = 0; i < N; i++) {
      const ty = t[i];
      if (ty === EMPTY) { ruleDepth[i] = 0; continue; }
      cellCount++; typeCounts[ty]++;
      const b = 4 * i;
      if (t[NB[b]] === EMPTY || t[NB[b + 1]] === EMPTY || t[NB[b + 2]] === EMPTY || t[NB[b + 3]] === EMPTY) {
        ruleDepth[i] = 1; queue[tail++] = i;
      } else ruleDepth[i] = 255;
    }
    while (head < tail) {
      const i = queue[head++], nd = ruleDepth[i] + 1, b = 4 * i;
      for (let d = 0; d < 4; d++) {
        const j = NB[b + d];
        if (ruleDepth[j] === 255) { ruleDepth[j] = nd > 254 ? 254 : nd; queue[tail++] = j; }
      }
    }
    for (let i = 0; i < N; i++) band[i] = t[i] === EMPTY ? 0 : bandOfRuleDepth(ruleDepth[i]);
  }

  // Exterior depth (v1 contract): flood the empty region that holds the grid corner, then BFS inward through
  // everything else. Live 1..254; empty 0 = exterior, 255 = interior gap. Lazy: computed when first read in a tick.
  function ensureExt() {
    if (extTick === tick) return;
    extTick = tick;
    const t = tA;
    ext.fill(255);
    let seedIdx = 0;
    while (seedIdx < N && t[seedIdx] !== EMPTY) seedIdx++;
    let head = 0, tail = 0;
    if (seedIdx < N) { ext[seedIdx] = 0; queue[tail++] = seedIdx; }
    while (head < tail) {
      const i = queue[head++], b = 4 * i;
      for (let d = 0; d < 4; d++) {
        const j = NB[b + d];
        if (ext[j] === 255 && t[j] === EMPTY) { ext[j] = 0; queue[tail++] = j; }
      }
    }
    // BFS from the exterior into live cells and gaps (gaps pass the wave on but keep 255).
    const dist = ruleDepthScratch;
    head = 0; tail = 0;
    for (let i = 0; i < N; i++) {
      dist[i] = 0;
      if (ext[i] !== 255) continue;
      const b = 4 * i;
      if (ext[NB[b]] === 0 || ext[NB[b + 1]] === 0 || ext[NB[b + 2]] === 0 || ext[NB[b + 3]] === 0) { dist[i] = 1; queue[tail++] = i; }
    }
    dmax = 0; gaps = 0;
    while (head < tail) {
      const i = queue[head++], nd = dist[i] + 1, b = 4 * i;
      for (let d = 0; d < 4; d++) {
        const j = NB[b + d];
        if (ext[j] === 255 && dist[j] === 0) { dist[j] = nd > 254 ? 254 : nd; queue[tail++] = j; }
      }
    }
    for (let i = 0; i < N; i++) {
      if (t[i] === EMPTY) { if (ext[i] === 255) gaps++; continue; }
      const d = dist[i] || 254;
      ext[i] = d;
      if (d > dmax) dmax = d;
    }
  }
  const ruleDepthScratch = new Uint8Array(N);

  function init() {
    tA.fill(0); eA.fill(0); aA.fill(0); mA.fill(0);
    for (const m of morA) m.fill(0);
    prov.bornTick.fill(0); prov.founder.fill(255); prov.fateTick.fill(NEVER); prov.fateFrom.fill(0); prov.typeSince.fill(0);
    seedRng(seed);
    const cx = GS >> 1, cy = GS >> 1;
    let count = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= 10) count++;
    const se = TOTAL_E / count;
    let f = 0;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx + dy * dy > 10) continue;
        const i = (cy + dy) * GS + (cx + dx);
        tA[i] = STEM; eA[i] = se;
        morA[0][i] = 0.3 + rand() * 0.3;
        mA[i] = SENESCENCE + Math.floor((rand() - 0.5) * SEN_SPREAD);
        prov.founder[i] = f++;
      }
    }
    for (let r = 1; r <= 6; r++) morA[3][(cy - r) * GS + cx] += 0.08 * r;
    tick = 0; evCount = 0; evDropped = 0;
    birthsT = deathsT = fatesT = totalBirths = totalDeaths = totalFates = 0; energyLost = 0;
    sim.seedCount = count;
    computeRuleDepth();
    extTick = -1;
    publish();
  }

  // One v0.9 tick: classic.html simStep(), step for step.
  function stepOnce() {
    const ct = tA, ce = eA, ca = aA;
    const nt = tB, ne = eB, na = aB, nma = mB;
    nt.set(ct); ne.set(eA); na.set(aA); nma.set(mA);
    tick++;
    birthsT = 0; deathsT = 0; fatesT = 0;

    // 1. Diffusion of the four fields over the whole grid (explicit; the inhibitor's r = 0.325 is unstable).
    for (let m = 0; m < 4; m++) {
      const src = morA[m], dst = morB[m], r = RATES[m];
      for (let i = 0, b = 0; i < N; i++, b += 4) {
        const s = src[i];
        dst[i] = (s + r * (src[NB[b + 1]] + src[NB[b]] + src[NB[b + 3]] + src[NB[b + 2]] - 4 * s)) * M_DECAY;
        if (dst[i] < 0.0003) dst[i] = 0;
        if (dst[i] > 8) dst[i] = 8;
      }
    }
    const m0 = morB[0], m1 = morB[1], m2 = morB[2], m3 = morB[3];

    // 2. Activator–inhibitor reaction on live cells (raster order).
    for (let i = 0; i < N; i++) {
      if (ct[i] === EMPTY) continue;
      const a = m0[i], b = m1[i];
      const v = a + 0.02 * ((a * a) / (1 + b) - a + 0.04) + (rand() - 0.5) * NOISE;
      m0[i] = v > 0 ? v : 0;
      const w = b + 0.02 * (a * a - b);
      m1[i] = w > 0 ? w : 0;
    }

    // 3. Energy sharing with the right and lower neighbours (in place, old types).
    for (let i = 0; i < N; i++) {
      if (ct[i] === EMPTY) continue;
      const ri = NB[4 * i];
      if (ct[ri] !== EMPTY) { const f = (ne[i] - ne[ri]) * SHARE_RATE; ne[i] -= f; ne[ri] += f; }
      const di = NB[4 * i + 2];
      if (ct[di] !== EMPTY) { const f = (ne[i] - ne[di]) * SHARE_RATE; ne[i] -= f; ne[di] += f; }
    }

    // 4. Living cells in raster order, shuffled (Fisher–Yates); plain (non-toroidal) centroid as in v0.9.
    let L = 0, sumX = 0, sumY = 0;
    for (let i = 0; i < N; i++) if (ct[i] !== EMPTY) { living[L++] = i; sumX += i % GS; sumY += (i / GS) | 0; }
    for (let k = L - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      const tmp = living[k]; living[k] = living[j]; living[j] = tmp;
    }
    const centX = L > 0 ? sumX / L : GS / 2, centY = L > 0 ? sumY / L : GS / 2;

    // 5. Per cell, in shuffled order: age, die, divide, deposit signals, specify, specialise.
    for (let k = 0; k < L; k++) {
      const i = living[k], x = i % GS, y = (i / GS) | 0, b4 = 4 * i, t0 = ct[i];
      na[i] = ca[i] + 1;

      let die = na[i] > nma[i], cause = 0;
      if (t0 === STEM && m1[i] > 1.8 && rand() < 0.01) { if (!die) cause = 3; die = true; }
      if (!die) {
        let ln = 0;
        for (let d = 0; d < 4; d++) if (ct[NB[b4 + d]] !== EMPTY) ln++;
        if (ln === 0) { die = true; cause = 1; } else if (ln === 1 && rand() < 0.08) { die = true; cause = 2; }
      }

      if (die) {
        const recycleE = ne[i];
        let cnt = 0, mask = 0;
        for (let d = 0; d < 4; d++) if (nt[NB[b4 + d]] !== EMPTY) { cnt++; mask |= 1 << d; }
        if (cnt > 0) {
          const each = recycleE / cnt;
          for (let d = 0; d < 4; d++) if (mask & (1 << d)) ne[NB[b4 + d]] += each;
        } else energyLost += recycleE;            // the v0.9 orphan sink
        ne[i] = 0; nt[i] = EMPTY; na[i] = 0; nma[i] = 0; m1[i] += 0.06; deathsT++;
        pushEvent(EV.DEATH, i, t0 | (mask << 4) | (cause << 8), cnt > 0 ? Math.round(recycleE * 1000) : 0);
        continue;
      }

      const myThresh = t0 === STEM ? DIV_THRESH : THR_DIFF;
      if (ne[i] > myThresh && na[i] > DIV_COOLDOWN) {
        let dir = -1;
        if (m3[i] > 0.06 && rand() < 0.3) {
          if (nt[NB[b4 + 3]] === EMPTY) dir = 3;           // anterior (y − 1)
        }
        if (dir < 0) {
          order[0] = 0; order[1] = 1; order[2] = 2; order[3] = 3;
          for (let d = 3; d > 0; d--) { const j = Math.floor(rand() * (d + 1)); const tmp = order[d]; order[d] = order[j]; order[j] = tmp; }
          for (let q = 0; q < 4; q++) if (nt[NB[b4 + order[q]]] === EMPTY) { dir = order[q]; break; }
        }
        if (dir >= 0) {
          const ni = NB[b4 + dir];
          const half = ne[i] * 0.5; ne[i] = half; ne[ni] = half;
          nt[ni] = STEM; na[i] = 0; na[ni] = 0;
          nma[ni] = assignMaxAge(STEM); m0[ni] += 0.1;
          birthsT++;
          prov.bornTick[ni] = tick; prov.founder[ni] = prov.founder[i]; prov.fateTick[ni] = NEVER;
          prov.fateFrom[ni] = 0; prov.typeSince[ni] = tick;
          pushEvent(EV.BIRTH, ni, i, dir);
        }
      }

      const dxC = x - centX;
      m2[i] += Math.exp(-(dxC * dxC) / (2 * 14 * 14)) * 0.01;
      const apFactor = Math.max(0, (centY - y) / (GS * 0.1));
      m3[i] += apFactor * 0.01;
      if (t0 === ECTO) m2[i] += 0.002;
      if (t0 === NERVE) { m2[i] += 0.012; m3[i] += 0.008; }
      if (t0 === MESO || t0 === MUSCLE) m3[i] += 0.004;
      if (t0 === ENDO) m0[i] += 0.006;

      if (t0 === STEM && ca[i] > DIFF_AGE) {
        const d2 = ruleDepth[i];
        if (d2 <= 1) nt[i] = m2[i] > 0.18 && m3[i] > 0.18 ? NERVE : ECTO;
        else if (d2 === 2) nt[i] = MESO;
        else if (d2 >= 3 && d2 <= 5) nt[i] = ENDO;
        if (nt[i] !== STEM && nt[i] !== t0) {
          nma[i] = assignMaxAge(nt[i]); na[i] = 0;
          fate(i, t0, nt[i], d2);
        }
      }

      if (t0 === MESO && ca[i] > 40) {
        const act = m0[i], inh = m1[i];
        let to = 0;
        if (act > 0.25 && inh > 0.12) to = MUSCLE;
        else if (act < 0.08 && inh > 0.18) to = VESSEL;
        if (to) { nt[i] = to; nma[i] = assignMaxAge(to); na[i] = 0; fate(i, t0, to, ruleDepth[i]); }
      }
    }

    // 6. Swap buffers; rule depth and band for the new state (reused by the next tick: no double BFS).
    let s;
    s = tA; tA = tB; tB = s;
    s = eA; eA = eB; eB = s;
    s = aA; aA = aB; aB = s;
    s = mA; mA = mB; mB = s;
    s = morA; morA = morB; morB = s;
    totalBirths += birthsT; totalDeaths += deathsT; totalFates += fatesT;
    computeRuleDepth();
  }

  function fate(i, from, to, d) {
    fatesT++;
    prov.fateTick[i] = tick; prov.fateFrom[i] = from; prov.typeSince[i] = tick;
    pushEvent(EV.FATE, i, from | (to << 4) | ((d > 255 ? 255 : d) << 12), bandOfRuleDepth(d));
  }

  function publish() {
    sim.tick = tick; sim.type = tA; sim.energy = eA; sim.age = aA; sim.maxAge = mA; sim.morph = morA;
    sim.band = band; sim.ruleDepth = ruleDepth;
  }

  function step(n = 1) {
    for (let k = 0; k < n; k++) stepOnce();
    publish();
  }

  function drainEvents(out) {
    const cap = Math.floor(out.length / EV_WORDS);
    const n = evCount < cap ? evCount : cap, w = n * EV_WORDS;
    for (let j = 0; j < w; j++) out[j] = evBuf[j];
    if (n < evCount) evBuf.copyWithin(0, w, evCount * EV_WORDS);
    evCount -= n;
    sim.eventsDropped = evDropped; evDropped = 0;
    return n;
  }

  function stats() {
    ensureExt();
    const t = tA;
    let total = 0, comp = 0, sx = 0, sy = 0, cxs = 0, cys = 0, sxs = 0, sys = 0, founders = 0, sumAct = 0;
    for (let i = 0; i < N; i++) {
      if (t[i] === EMPTY) continue;
      const e = eA[i], u = total + e;
      comp += Math.abs(total) >= Math.abs(e) ? total - u + e : e - u + total;
      total = u;
      const x = i % GS, y = (i / GS) | 0, ax = (2 * Math.PI * x) / GS, ay = (2 * Math.PI * y) / GS;
      cxs += Math.cos(ax); sxs += Math.sin(ax); cys += Math.cos(ay); sys += Math.sin(ay);
      if (prov.bornTick[i] === 0) founders++;
      sumAct += morA[0][i];
      sx += x; sy += y;
    }
    total += comp;
    const wrap = (a) => ((a % GS) + GS) % GS;
    const cx = cellCount ? wrap((Math.atan2(sxs, cxs) * GS) / (2 * Math.PI)) : GS / 2;
    const cy = cellCount ? wrap((Math.atan2(sys, cys) * GS) / (2 * Math.PI)) : GS / 2;
    let r2 = 0;
    for (let i = 0; i < N; i++) {
      if (t[i] === EMPTY) continue;
      let dx = (i % GS) - cx, dy = ((i / GS) | 0) - cy;
      if (dx > GS / 2) dx -= GS; else if (dx < -GS / 2) dx += GS;
      if (dy > GS / 2) dy -= GS; else if (dy < -GS / 2) dy += GS;
      const q = dx * dx + dy * dy;
      if (q > r2) r2 = q;
    }
    return {
      tick, cellCount, typeCounts: new Int32Array(typeCounts), totalEnergy: total, energyLost,
      birthsThisTick: birthsT, deathsThisTick: deathsT, fatesThisTick: fatesT, totalBirths, totalDeaths, totalFates,
      cx, cy, rMax: Math.sqrt(r2), dmax, bands: { e1: 1, e2: 2, e3: 6 }, gaps, foundersAlive: founders,
      meanAct: cellCount ? sumAct / cellCount : 0,
    };
  }

  function readCell(idx) {
    if (!(idx >= 0 && idx < N) || tA[idx] === EMPTY) return null;
    ensureExt();
    const ty = tA[idx], bd = band[idx], thr = ty === STEM ? DIV_THRESH : THR_DIFF;
    const mid = morA[2][idx], ap = morA[3][idx];
    const ruleFate = bd === 1 ? (mid > 0.18 && ap > 0.18 ? NERVE : ECTO) : bd === 2 ? MESO : bd === 3 ? ENDO : STEM;
    const never = prov.fateTick[idx] === NEVER;
    return {
      idx, x: idx % GS, y: (idx / GS) | 0, tick, type: ty, energy: eA[idx], threshold: thr,
      age: aA[idx], maxAge: mA[idx], depth: ext[idx], band: bd, ruleFate,
      ready: eA[idx] > thr && aA[idx] + 1 > DIV_COOLDOWN,
      act: morA[0][idx], inh: morA[1][idx], mid, ap,
      bornTick: prov.bornTick[idx], founder: prov.founder[idx] === 255 ? null : prov.founder[idx],
      fateTick: never ? null : prov.fateTick[idx], fateFrom: never ? null : prov.fateFrom[idx],
      typeSince: prov.typeSince[idx], ruleDepth: ruleDepth[idx],
    };
  }

  function getRngState(out = new Uint32Array(4)) {
    for (let k = 0; k < 4; k++) out[k] = RS[k] >>> 0;
    return out;
  }

  const copyBuf = (a) => a.slice().buffer;
  function snapshot() {
    return {
      kind: 'embryo-engine-v09-snapshot', version: ENGINE_VERSION, seed, tick, rng: getRngState(),
      meta: { birthsT, deathsT, fatesT, totalBirths, totalDeaths, totalFates, energyLost },
      buffers: {
        type: copyBuf(tA), energy: copyBuf(eA), age: copyBuf(aA), maxAge: copyBuf(mA),
        morph0: copyBuf(morA[0]), morph1: copyBuf(morA[1]), morph2: copyBuf(morA[2]), morph3: copyBuf(morA[3]),
        bornTick: copyBuf(prov.bornTick), founder: copyBuf(prov.founder), fateTick: copyBuf(prov.fateTick),
        fateFrom: copyBuf(prov.fateFrom), typeSince: copyBuf(prov.typeSince),
      },
    };
  }

  function restore(snap) {
    if (!snap || snap.version !== ENGINE_VERSION) throw new Error('snapshot version mismatch');
    const B = snap.buffers;
    tA.set(new Uint8Array(B.type)); eA.set(new Float32Array(B.energy));
    aA.set(new Uint16Array(B.age)); mA.set(new Uint16Array(B.maxAge));
    for (let m = 0; m < 4; m++) morA[m].set(new Float32Array(B['morph' + m]));
    prov.bornTick.set(new Uint32Array(B.bornTick)); prov.founder.set(new Uint8Array(B.founder));
    prov.fateTick.set(new Uint32Array(B.fateTick)); prov.fateFrom.set(new Uint8Array(B.fateFrom));
    prov.typeSince.set(new Uint32Array(B.typeSince));
    for (let k = 0; k < 4; k++) RS[k] = snap.rng[k] | 0;
    tick = snap.tick;
    const M = snap.meta;
    birthsT = M.birthsT; deathsT = M.deathsT; fatesT = M.fatesT;
    totalBirths = M.totalBirths; totalDeaths = M.totalDeaths; totalFates = M.totalFates; energyLost = M.energyLost;
    evCount = 0; evDropped = 0; sim.eventsDropped = 0;
    computeRuleDepth();
    extTick = -1;
    publish();
  }

  const sim = {
    tick: 0, seed, seedCount: 37,
    type: tA, energy: eA, age: aA, maxAge: mA, morph: morA, band, ruleDepth,
    get depth() { ensureExt(); return ext; },
    get dmax() { ensureExt(); return dmax; },
    bands: { e1: 1, e2: 2, e3: 6 }, prov, eventsDropped: 0, params: PARAMS,
    step, drainEvents, stats, snapshot, restore, readCell, getRngState,
  };
  init();
  return sim;
}

// FNV-1a (32-bit) over type, energy bits, age and the PRNG state.
export function hashState(sim) {
  let h = 0x811C9DC5;
  const eat = (a) => { const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let k = 0; k < u8.length; k++) h = Math.imul(h ^ u8[k], 16777619); };
  eat(sim.type); eat(sim.energy); eat(sim.age); eat(sim.getRngState());
  return (h >>> 0).toString(16).padStart(8, '0');
}
