// test/engine.test.mjs — acceptance tests for engine v1.0 (ADDENDUM §A.3). Run: node --test test/
//
// The long runs (5 seeds × 20K ticks: conservation, inhibitor stability, flip-flops, biology at T5000) execute in
// parallel worker threads started by this same file; everything else runs on the main thread meanwhile.

import { isMainThread, Worker, workerData, parentPort } from 'node:worker_threads';
import { createSim, hashState, PARAMS, FIELD_INFO, ENGINE_VERSION } from '../src/engine.js';
import { GRID, EV, EV_WORDS, TYPE, FAMILY_OF_TYPE, RULE_FATE_OF_BAND } from '../src/shared.js';

const GS = GRID, N = GS * GS;
const LONG_SEEDS = [1, 2, 3, 4, 5];
const LONG_T = 20000;
const GOLDEN = { seed: 1, tick: 5000, hash: '472c912f' }; // documented in docs/engine-v1.md; update when rules change

const nb4 = (i) => {
  const x = i % GS, y = (i / GS) | 0;
  return [y * GS + (x + 1) % GS, y * GS + (x + GS - 1) % GS, ((y + 1) % GS) * GS + x, ((y + GS - 1) % GS) * GS + x];
};
const nbDiag = (i) => {
  const x = i % GS, y = (i / GS) | 0, xp = (x + 1) % GS, xm = (x + GS - 1) % GS, yp = (y + 1) % GS, ym = (y + GS - 1) % GS;
  return [yp * GS + xp, ym * GS + xp, yp * GS + xm, ym * GS + xm];
};
const minImage = (d) => (d > GS / 2 ? d - GS : d <= -GS / 2 ? d + GS : d);

// Mean same-type 4-neighbour fraction of the cells of type t (1 = solid blocks, ~0 = salt and pepper).
function clustering(T, t) {
  let sum = 0, n = 0;
  for (let i = 0; i < N; i++) {
    if (T[i] !== t) continue;
    let live = 0, same = 0;
    for (const j of nb4(i)) if (T[j]) { live++; if (T[j] === t) same++; }
    if (live) { sum += same / live; n++; }
  }
  return n ? sum / n : 0;
}

// Parity (checkerboard) index of a field over the whole grid: 1 = pure checkerboard, 0 = none.
function checkerIndex(f) {
  let num = 0, den = 0;
  for (let i = 0; i < N; i++) { const x = i % GS, y = (i / GS) | 0; num += ((x + y) & 1 ? -1 : 1) * f[i]; den += Math.abs(f[i]); }
  return den ? Math.abs(num / den) : 0;
}

function biology(sim) {
  const s = sim.stats(), T = sim.type, D = sim.depth;
  const fam = [[0, 0], [0, 0], [0, 0], [0, 0]]; // ecto (ECTO only), meso family, endo, stem: [n, sumDepth]
  let ny = 0, nn = 0;
  for (let i = 0; i < N; i++) {
    const t = T[i];
    if (!t) continue;
    const f = t === TYPE.ECTO ? 0 : (t === TYPE.MESO || t === TYPE.MUSCLE || t === TYPE.VESSEL) ? 1 : t === TYPE.ENDO ? 2 : t === TYPE.STEM ? 3 : -1;
    if (f >= 0) { fam[f][0]++; fam[f][1] += D[i]; }
    if (t === TYPE.NEURAL) { ny += minImage(((i / GS) | 0) - s.cy); nn++; }
  }
  return {
    typeCounts: Array.from(s.typeCounts), cellCount: s.cellCount,
    famDepth: fam.map(([n, d]) => (n ? d / n : NaN)),
    neuralDy: nn ? ny / nn : NaN, // mean y offset of neural cells from the body centroid; anterior = negative y
    muscleClustering: clustering(T, TYPE.MUSCLE),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Worker: one long run (conservation, events-vs-stats, inhibitor stability, flip-flops, biology at T5000)
function longRun({ seed, ticks, wantSnapshot }) {
  const sim = createSim({ seed });
  const ev = new Int32Array(EV_WORDS * 16384);
  const out = { seed, maxRelDrift: 0, maxLost: 0, emptyEnergy: 0, maxChecker: 0, maxInhJump: 0, flipMax: 0,
    eventMismatch: 0, eventsDropped: 0, checkpoints: [], bio5000: null, snapshot: null };
  let flipWin = 0;
  const prevInh = new Float32Array(N);
  for (let t = 1; t <= ticks; t++) {
    const sampleJump = t > 200 && t % 1000 === 0;
    if (sampleJump) prevInh.set(sim.morph[1]);
    sim.step(1);
    const n = sim.drainEvents(ev);
    out.eventsDropped += sim.eventsDropped;
    const s = sim.stats();
    const rel = Math.abs(s.totalEnergy - PARAMS.totalEnergy) / PARAMS.totalEnergy;
    if (rel > out.maxRelDrift) out.maxRelDrift = rel;
    if (s.energyLost > out.maxLost) out.maxLost = s.energyLost;
    let b = 0, d = 0, f = 0;
    for (let k = 0; k < n; k++) { const kind = ev[k * EV_WORDS] & 255; if (kind === EV.BIRTH) b++; else if (kind === EV.DEATH) d++; else if (kind === EV.FATE) f++; }
    if (b !== s.birthsThisTick || d !== s.deathsThisTick || f !== s.fatesThisTick) out.eventMismatch++;
    flipWin += s.flipFlopsThisTick;
    if (t % 100 === 0) { out.flipMax = Math.max(out.flipMax, (100 * flipWin) / Math.max(1, s.cellCount)); flipWin = 0; }
    if (sampleJump) {
      const inh = sim.morph[1];
      for (let i = 0; i < N; i++) { const j = Math.abs(inh[i] - prevInh[i]); if (j > out.maxInhJump) out.maxInhJump = j; }
    }
    if (t % 500 === 0) {
      const ci = checkerIndex(sim.morph[1]);
      if (t > 200 && ci > out.maxChecker) out.maxChecker = ci;
      // independent energy sum (plain) + no energy stranded in empty cells
      let plain = 0;
      for (let i = 0; i < N; i++) { plain += sim.energy[i]; if (!sim.type[i] && sim.energy[i] !== 0) out.emptyEnergy++; }
      out.checkpoints.push({ t, cells: s.cellCount, total: s.totalEnergy, plain, checker: ci, checkerAct: checkerIndex(sim.morph[0]) });
    }
    if (t === 5000) out.bio5000 = biology(sim);
  }
  if (wantSnapshot) out.snapshot = sim.snapshot();
  return out;
}

if (!isMainThread) {
  const res = longRun(workerData);
  const transfer = res.snapshot ? Object.values(res.snapshot.buffers) : [];
  parentPort.postMessage(res, transfer);
} else {
  await mainTests();
}

async function mainTests() {
  const { test } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const v8 = await import('node:v8');
  const vm = await import('node:vm');
  const inspector = await import('node:inspector/promises');

  // Start the long runs first so they overlap with the main-thread tests.
  const long = Promise.all(LONG_SEEDS.map((seed) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { seed, ticks: LONG_T, wantSnapshot: seed === 1 } });
    w.once('message', resolve); w.once('error', reject);
  })));

  test('exports: version, frozen PARAMS, FIELD_INFO for 4 channels', () => {
    assert.equal(ENGINE_VERSION, '1.0.0');
    assert.ok(Object.isFrozen(PARAMS) && Object.isFrozen(PARAMS.gates));
    assert.equal(FIELD_INFO.length, 4);
    FIELD_INFO.forEach((f, c) => { assert.equal(f.channel, c); assert.ok(f.domain[1] > 0); });
    const sim = createSim();
    assert.equal(sim.seedCount, 37);
    assert.equal(sim.stats().cellCount, 37);
  });

  // §A.3.1
  test('1 · determinism: same seed → same hash at T5000, different seeds differ', () => {
    const run = (seed) => { const s = createSim({ seed }); s.step(5000); return hashState(s); };
    const a = run(7), b = run(7), c = run(8);
    assert.equal(a, b);
    assert.notEqual(a, c);
    const g = createSim({ seed: GOLDEN.seed }); g.step(GOLDEN.tick);
    assert.equal(hashState(g), GOLDEN.hash, 'golden hash changed: the rules or the PRNG changed (update the docs)');
  });

  // §A.3.2
  test('2 · snapshot round-trip is bit-identical (restore(snapshot(t)) + step(k))', () => {
    const a = createSim({ seed: 3 });
    const evA = new Int32Array(EV_WORDS * 16384), evB = new Int32Array(EV_WORDS * 16384);
    a.step(3000); a.drainEvents(evA);
    const snap = a.snapshot();
    const moved = structuredClone(snap, { transfer: Object.values(snap.buffers) }); // must be transferable
    const b = createSim({ seed: 99 });
    b.step(123); // dirty the target first
    b.restore(moved);
    assert.equal(b.seed, 3);
    assert.equal(hashState(b), hashState(a));
    let sumA = 0, sumB = 0;
    for (let t = 0; t < 500; t++) {
      a.step(1); b.step(1);
      const na = a.drainEvents(evA), nb = b.drainEvents(evB);
      assert.equal(na, nb);
      for (let k = 0; k < na * EV_WORDS; k++) { sumA = (sumA * 31 + evA[k]) | 0; sumB = (sumB * 31 + evB[k]) | 0; }
    }
    assert.equal(sumA, sumB, 'event streams differ after restore');
    assert.equal(hashState(b), hashState(a));
    const sa = a.snapshot(), sb = b.snapshot();
    for (const k of Object.keys(sa.buffers)) assert.deepEqual(new Uint8Array(sb.buffers[k]), new Uint8Array(sa.buffers[k]), k);
    assert.deepEqual(sb.meta, sa.meta);
    assert.deepEqual(b.depth, a.depth); assert.deepEqual(b.band, a.band);
    assert.deepEqual(b.stats(), a.stats());
  });

  // §A.3.6
  test('6 · depth equals a naive exterior-BFS reference on 100+ states (both metrics, seam fallback)', () => {
    // Naive reference: flood the 4-connected empty region containing `seedCell`; then BFS level by level through
    // all other cells, stepping diagonally from odd levels when octagonal.
    const reference = (T, seedCell, octagonal) => {
      const d = new Int32Array(N).fill(-1);
      let frontier = [seedCell]; d[seedCell] = 0;
      for (let q = 0; q < frontier.length; q++) for (const j of nb4(frontier[q])) if (d[j] < 0 && !T[j]) { d[j] = 0; frontier.push(j); }
      let level = 0;
      while (frontier.length) {
        const next = [];
        for (const c of frontier) {
          const js = octagonal && (level & 1) ? [...nb4(c), ...nbDiag(c)] : nb4(c);
          for (const j of js) if (d[j] < 0) { d[j] = level + 1; next.push(j); }
        }
        frontier = next; level++;
      }
      return d;
    };
    const check = (sim, seedCell, octagonal, label) => {
      const T = sim.type, ref = reference(T, seedCell, octagonal), st = sim.stats();
      let dmax = 0, gaps = 0;
      for (let i = 0; i < N; i++) {
        if (T[i]) {
          if (sim.depth[i] !== ref[i]) assert.fail(`${label}: depth at ${i} is ${sim.depth[i]}, reference ${ref[i]}`);
          const r = ref[i], bd = r <= st.bands.e1 ? 1 : r <= st.bands.e2 ? 2 : r < st.bands.e3 ? 3 : 4;
          if (sim.band[i] !== bd) assert.fail(`${label}: band at ${i}`);
          if (r > dmax) dmax = r;
        } else {
          const want = ref[i] === 0 ? 0 : 255;
          if (want === 255) gaps++;
          if (sim.depth[i] !== want || sim.band[i] !== 0) assert.fail(`${label}: empty cell ${i} depth ${sim.depth[i]}, want ${want}`);
        }
      }
      assert.equal(st.dmax, dmax, `${label}: dmax`);
      assert.equal(st.gaps, gaps, `${label}: gaps`);
    };
    let states = 0;
    // (a) 60 states along a normal run (octagonal, the default)
    const sim = createSim({ seed: 5 });
    for (let k = 0; k < 60; k++) { sim.step(k < 10 ? 7 : 83); check(sim, 0, true, `run T${sim.tick}`); states++; }
    // (b) 10 states with the manhattan metric
    const man = createSim({ seed: 6, params: { depthMetric: 'manhattan' } });
    for (let k = 0; k < 10; k++) { man.step(250); check(man, 0, false, `manhattan T${man.tick}`); states++; }
    // (c) 40 perturbed states: random holes, sealed pockets, a live island inside a gap, a diagonal-only pocket,
    //     an open channel to the exterior; half of them rolled across the torus seam (fallback exterior path)
    let rng = 12345;
    const rnd = (n) => { rng = (Math.imul(rng, 1103515245) + 12345) | 0; return ((rng >>> 8) % n + n) % n; };
    const base = createSim({ seed: 7 }); base.step(2500);
    const snap0 = base.snapshot();
    const target = createSim({ seed: 1 });
    for (let k = 0; k < 40; k++) {
      const T = new Uint8Array(snap0.buffers.type.slice(0)), E = new Float64Array(snap0.buffers.energy.slice(0));
      const st = base.stats(), cx = Math.round(st.cx), cy = Math.round(st.cy);
      const kill = (x, y) => { const i = ((y + GS) % GS) * GS + (x + GS) % GS; T[i] = 0; E[i] = 0; };
      const live = (x, y) => { const i = ((y + GS) % GS) * GS + (x + GS) % GS; T[i] = TYPE.ENDO; E[i] = 40; };
      for (let h = 0; h < 30 + rnd(200); h++) kill(cx + rnd(50) - 25, cy + rnd(50) - 25);          // random holes
      const px = cx + rnd(20) - 10, py = cy + rnd(20) - 10;                                    // ring gap + island
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const r = Math.max(Math.abs(dx), Math.abs(dy)); if (r === 2 || r === 3) kill(px + dx, py + dy); }
      live(px, py);
      if (k % 3 === 0) for (let x = cx; x < cx + 45; x++) kill(x, cy + 3);                     // open channel
      if (k % 4 === 1) { kill(cx - 30, cy - 5); kill(cx - 29, cy - 4); }                     // diagonal-only pair
      let roll = 0;
      if (k % 2 === 1) roll = 100;                                                             // across the seam
      const T2 = new Uint8Array(N), E2 = new Float64Array(N);
      for (let i = 0; i < N; i++) { const x = i % GS, y = (i / GS) | 0, j = ((y + roll) % GS) * GS + (x + roll) % GS; T2[j] = T[i]; E2[j] = E[i]; }
      const s2 = { ...snap0, buffers: { ...snap0.buffers, type: T2.buffer, energy: E2.buffer } };
      target.restore(s2);
      const seedCell = ((cy + 100 + roll) % GS) * GS + (cx + 100 + roll) % GS; // antipode of the organism: exterior
      assert.equal(T2[seedCell], 0);
      check(target, seedCell, true, `perturbed #${k}${roll ? ' (rolled)' : ''}`);
      states++;
    }
    assert.ok(states >= 100, `${states} states`);
  });

  // §A.3.7
  test('7 · events: counts equal stats deltas; DEATH energy equals the dying cell’s energy (replayed)', () => {
    const sim = createSim({ seed: 4 });
    sim.step(1500);
    const ev = new Int32Array(EV_WORDS * 16384);
    sim.drainEvents(ev);
    let totB = sim.stats().totalBirths, totD = sim.stats().totalDeaths, totF = sim.stats().totalFates;
    let deathsChecked = 0, worst = 0, maskZero = 0;
    const share = PARAMS.shareRate;
    for (let t = 0; t < 1500; t++) {
      const TA = sim.type.slice(), E = sim.energy.slice();
      // replicate the sharing sweep exactly (raster order, right then down neighbour, old types)
      for (let i = 0; i < N; i++) {
        if (!TA[i]) continue;
        const x = i % GS, y = (i / GS) | 0, ri = y * GS + (x + 1) % GS, di = ((y + 1) % GS) * GS + x;
        if (TA[ri]) { const f = (E[i] - E[ri]) * share; E[i] -= f; E[ri] += f; }
        if (TA[di]) { const f = (E[i] - E[di]) * share; E[i] -= f; E[di] += f; }
      }
      sim.step(1);
      const n = sim.drainEvents(ev), s = sim.stats();
      assert.equal(sim.eventsDropped, 0);
      let b = 0, d = 0, f = 0, rec = 0;
      const diedNow = new Set();
      for (let k = 0; k < n; k++) {
        const w0 = ev[k * 4], kind = w0 & 255, idx = w0 >> 8, a = ev[k * 4 + 2], bb = ev[k * 4 + 3];
        assert.equal(ev[k * 4 + 1], s.tick, 'event tick');
        if (kind === EV.BIRTH) {
          b++;
          assert.equal(nb4(a)[bb], idx, 'daughter = parent + dir');
          assert.ok(TA[idx] === 0 || diedNow.has(idx), 'born into an empty cell');
        } else if (kind === EV.DEATH) {
          d++;
          const deadType = a & 15, mask = (a >> 4) & 15, cause = (a >> 8) & 15;
          assert.equal(deadType, TA[idx]); assert.ok(cause <= 2, 'causes: age, isolated, tip');
          const e = E[idx];
          worst = Math.max(worst, Math.abs(bb / 1000 - e));
          deathsChecked++; rec += e; diedNow.add(idx);
          E[idx] = 0;
          if (mask) {
            const js = nb4(idx), kk = (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
            for (let q = 0; q < 4; q++) if (mask & (1 << q)) E[js[q]] += e / kk;
          } else maskZero++;
        } else if (kind === EV.FATE) {
          f++;
          const from = a & 15, to = (a >> 4) & 15;
          assert.ok(from >= 1 && from <= 7 && to >= 1 && to <= 7 && from !== to, 'fate from/to');
          assert.ok(bb >= 1 && bb <= 4, 'fate band');
        }
      }
      assert.equal(b, s.birthsThisTick); assert.equal(d, s.deathsThisTick); assert.equal(f, s.fatesThisTick);
      totB += b; totD += d; totF += f;
      assert.equal(s.totalBirths, totB); assert.equal(s.totalDeaths, totD); assert.equal(s.totalFates, totF);
      assert.ok(Math.abs(rec - s.recycledThisTick) < 1e-6 * Math.max(1, rec), 'recycled energy per tick');
    }
    assert.ok(deathsChecked > 500, `${deathsChecked} deaths checked`);
    assert.ok(worst <= 0.0005 + 1e-9, `DEATH energy off by ${worst}`);
    assert.ok(maskZero < 3, 'orphan deaths are rare');
  });

  test('7b · orphan deaths: energy goes to live cells at distance 2, else to the global pool (exact)', () => {
    const make = (cells) => {
      const sim = createSim({ seed: 1 });
      const snap = sim.snapshot();
      const T = new Uint8Array(N), E = new Float64Array(N), A = new Uint16Array(N), M = new Uint16Array(N);
      for (const [x, y, e] of cells) { const i = y * GS + x; T[i] = TYPE.ENDO; E[i] = e; A[i] = 1; M[i] = 5000; }
      sim.restore({ ...snap, buffers: { ...snap.buffers, type: T.buffer, energy: E.buffer, age: A.buffer, maxAge: M.buffer } });
      return sim;
    };
    // a 2×2 block at x 102..103, y 100..101 (below the division threshold, 2 neighbours each) + an isolated cell
    const block = [[102, 100, 20], [103, 100, 20], [102, 101, 20], [103, 101, 20]];
    const ev = new Int32Array(EV_WORDS * 64);
    // (i) isolated cell at (100,100): Manhattan distance 2 to exactly one block cell, (102,100)
    let sim = make([...block, [100, 100, 10]]);
    sim.step(1);
    let n = sim.drainEvents(ev), deaths = [];
    for (let k = 0; k < n; k++) if ((ev[k * 4] & 255) === EV.DEATH) deaths.push(k);
    assert.equal(deaths.length, 1);
    const k0 = deaths[0] * 4;
    assert.equal(ev[k0] >> 8, 100 * GS + 100);
    assert.equal((ev[k0 + 2] >> 4) & 15, 0, 'no 4-neighbour received');
    assert.equal((ev[k0 + 2] >> 8) & 15, 1, 'cause: isolated');
    assert.equal(ev[k0 + 3], 10000);
    assert.equal(sim.energy[100 * GS + 102], 30);
    assert.equal(sim.energy[100 * GS + 103], 20);
    assert.equal(sim.stats().totalEnergy, 90);
    // (ii) isolated cell far from everything: the pool is spread evenly over the 4 block cells
    sim = make([...block, [60, 60, 10]]);
    sim.step(1);
    for (const [x, y] of block) assert.equal(sim.energy[y * GS + x], 22.5);
    assert.equal(sim.stats().totalEnergy, 90);
    assert.equal(sim.stats().energyLost, 0);
  });

  test('7c · extinction: the pooled energy is carried, not destroyed, and survives snapshot/restore', () => {
    // every founder dies of old age at T9 (senescence base 8, no spread), before any can divide
    const params = { senescence: { base: 8, spread: 0, factor: [0, 1, 1, 1, 1, 1, 1, 1] } };
    const sim = createSim({ seed: 1, params });
    sim.step(9);
    assert.equal(sim.stats().cellCount, 0, 'extinct at T9');
    const E0 = PARAMS.totalEnergy;
    for (let t = 9; t <= 30; t++) {
      const s = sim.stats();
      assert.ok(Math.abs(s.totalEnergy - E0) < 1e-6, `T${s.tick}: total ${s.totalEnergy}`);
      assert.equal(s.energyLost, 0);
      sim.step(1);
    }
    const copy = createSim({ seed: 2, params });
    copy.restore(sim.snapshot());
    copy.step(5);
    assert.ok(Math.abs(copy.stats().totalEnergy - E0) < 1e-6, 'pool restored from the snapshot');
  });

  // §A.3.3, §A.3.4, flip-flops and §A.3.8 from the 5 long runs
  test('3 · conservation: |total − 250000| < 1e-6 relative for 20K ticks on 5 seeds; energyLost 0', async (t) => {
    const runs = await long;
    t.diagnostic(`max relative drift per seed: ${runs.map((r) => r.maxRelDrift.toExponential(1)).join(', ')}`);
    for (const r of runs) {
      assert.ok(r.maxRelDrift < 1e-6, `seed ${r.seed}: drift ${r.maxRelDrift}`);
      assert.equal(r.maxLost, 0);
      assert.equal(r.emptyEnergy, 0, 'energy stranded in empty cells');
      for (const c of r.checkpoints) assert.ok(Math.abs(c.plain - PARAMS.totalEnergy) / PARAMS.totalEnergy < 1e-6, 'independent sum');
      assert.equal(r.eventMismatch, 0, 'event counts vs stats');
      assert.equal(r.eventsDropped, 0);
    }
  });

  test('4 · inhibitor stable: no parity checkerboard (index < 0.05), per-tick change < 0.5 after T200', async (t) => {
    const runs = await long;
    t.diagnostic(`max checker index: ${runs.map((r) => r.maxChecker.toExponential(1)).join(', ')}; max per-tick jump: ${runs.map((r) => r.maxInhJump.toFixed(4)).join(', ')}`);
    for (const r of runs) {
      assert.ok(r.maxChecker < 0.05, `seed ${r.seed}: checker ${r.maxChecker}`);
      assert.ok(r.maxInhJump < 0.5, `seed ${r.seed}: jump ${r.maxInhJump}`);
    }
  });

  test('hysteresis: flip-flops (fate undone within 50 ticks) < 1% of live cells per 100 ticks', async (t) => {
    const runs = await long;
    t.diagnostic(`worst 100-tick window per seed (% of live cells): ${runs.map((r) => r.flipMax.toFixed(3)).join(', ')}`);
    for (const r of runs) assert.ok(r.flipMax < 1, `seed ${r.seed}: ${r.flipMax.toFixed(3)}%`);
  });

  test('8 · biology at T5000 (5 seeds): 7 types, concentric order, anterior neural plate, muscle blocks', async (t) => {
    const runs = await long;
    for (const { seed, bio5000: b } of runs) t.diagnostic(`seed ${seed}: depth ecto/meso/endo/stem ${b.famDepth.map((v) => v.toFixed(1)).join('/')}, neural Δy ${b.neuralDy.toFixed(1)}, muscle clustering ${b.muscleClustering.toFixed(2)}`);
    for (const { seed, bio5000: b } of runs) {
      for (let t = 1; t <= 7; t++) assert.ok(b.typeCounts[t] > 0, `seed ${seed}: type ${t} missing`);
      const [ecto, meso, endo, stem] = b.famDepth;
      assert.ok(ecto < meso && meso < endo && endo < stem, `seed ${seed}: depth order ${b.famDepth.map((v) => v.toFixed(1))}`);
      assert.ok(b.neuralDy < 0, `seed ${seed}: neural centroid not anterior (${b.neuralDy})`);
      assert.ok(b.muscleClustering > 0.4, `seed ${seed}: muscle clustering ${b.muscleClustering.toFixed(2)}`);
    }
  });

  // §A.3.5 (after the workers finish, so the timing runs on a quiet machine)
  test('5 · performance: ≤ 1.0 ms/tick at ~7K cells, zero per-tick allocation, flat heap', async (t) => {
    const runs = await long;
    const snap = runs.find((r) => r.seed === 1).snapshot;
    const sim = createSim({ seed: 1 });
    sim.restore(snap);
    const ev = new Int32Array(EV_WORDS * 4096);
    for (let k = 0; k < 1000; k++) { sim.step(1); sim.drainEvents(ev); }
    const cells = sim.stats().cellCount;
    assert.ok(cells > 6500, `${cells} cells`);
    let best = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      const t0 = performance.now();
      for (let k = 0; k < 1000; k++) { sim.step(1); sim.drainEvents(ev); }
      best = Math.min(best, (performance.now() - t0) / 1000);
    }
    t.diagnostic(`${best.toFixed(3)} ms/tick at ${cells} cells`);
    assert.ok(best <= 1.0, `${best.toFixed(3)} ms/tick at ${cells} cells`);

    // allocation: sample every allocation (incl. collected garbage) during 2000 ticks; none may come from engine.js
    const session = new inspector.Session(); session.connect();
    await session.post('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let k = 0; k < 2000; k++) { sim.step(1); sim.drainEvents(ev); }
    const { profile } = await session.post('HeapProfiler.stopSampling');
    session.disconnect();
    let engineBytes = 0;
    (function walk(node) { if (node.callFrame.url.endsWith('/src/engine.js')) engineBytes += node.selfSize; node.children.forEach(walk); })(profile.head);
    t.diagnostic(`sampled allocations attributed to engine.js over 2000 ticks: ${engineBytes} B`);
    assert.ok(engineBytes < 2048, `engine.js allocated ~${engineBytes} bytes over 2000 ticks`);

    // heap flat over 5K ticks
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    gc(); const h0 = process.memoryUsage().heapUsed;
    for (let k = 0; k < 5000; k++) { sim.step(1); sim.drainEvents(ev); }
    gc(); const h1 = process.memoryUsage().heapUsed;
    t.diagnostic(`heap change over 5000 ticks: ${((h1 - h0) / 1024).toFixed(1)} KB`);
    assert.ok(Math.abs(h1 - h0) < 1024 * 1024, `heap moved ${((h1 - h0) / 1024).toFixed(0)} KB`);
  });

  test('readCell: CellDetail fields and rule fate', () => {
    const sim = createSim({ seed: 2 });
    sim.step(2000);
    assert.equal(sim.readCell(0), null);
    let seen = 0;
    for (let i = 0; i < N && seen < 200; i++) {
      const c = sim.readCell(i);
      if (!c) continue;
      seen++;
      assert.equal(c.type, sim.type[i]); assert.equal(c.depth, sim.depth[i]); assert.equal(c.band, sim.band[i]);
      assert.ok(c.ruleBand >= 1 && c.ruleBand <= 4);
      if (c.ruleBand !== 1) assert.equal(c.ruleFate, RULE_FATE_OF_BAND[c.ruleBand]);
      assert.ok(FAMILY_OF_TYPE[c.type] >= 0);
      assert.equal(c.threshold, c.type === TYPE.STEM ? PARAMS.divThreshStem : PARAMS.divThreshDiff);
      for (const k of ['energy', 'age', 'maxAge', 'act', 'inh', 'mid', 'ap', 'bornTick', 'typeSince']) assert.equal(typeof c[k], 'number', k);
    }
    assert.equal(seen, 200);
  });
}
