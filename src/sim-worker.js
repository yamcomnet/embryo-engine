// src/sim-worker.js: the simulation thread (module worker; never imports three).
//
// Owns the engine and everything derived from it, so the main thread only copies textures and draws:
//   • tick pacing at the target ticks/second (SPEEDS; 0 = as fast as possible), in ≤ 10 ms slices;
//   • events drained every tick into per-cell bookkeeping (evTick/evKind/evDir/evPrevType) and a per-frame list;
//   • frame packing into a pool of 3 transferable buffer sets, published only with a credit (main acks each frame);
//   • stats (ADDENDUM §B.2), with window stats over W = 200 ticks kept incrementally from events;
//   • milestones (shared.js MILESTONES) with 128×128 thumbs and snapshots; keyframes every 1000 ticks, thinned;
//   • viewing a snapshot, going back to live, resuming from a snapshot (deterministic), fast-forward, inspect.
// Protocol: SPEC §3.3 as amended by ADDENDUM §B. Engine choice comes from INIT { engine: 'v1' | 'v09' | 'mock' }.
//
// Extensions to the protocol (optional, backwards compatible):
//   • control messages may carry `seq`; frames echo the last one handled as `ctl`, so main can tell a frame
//     published before its last command from one published after it.
//   • `progress` carries `done: true` on the last message of a fast-forward, and `cancelled: true` when a run or
//     step control stopped it short of its target. Viewing a snapshot (or going back to live) does not stop it: the
//     jump carries on in the background and the viewed snapshot is published on its own.
//   • INIT may carry `mockCells` (mock engine) and `publishHz` (frame rate cap, default 60).
//   • dev-only requests: { type: 'hash' } → { type: 'hash', tick, hash, viewing }, { type: 'perf' } → { type: 'perf', ... }.

import {
  GRID, N, TYPE, EV, EV_WORDS, MAX_EVENTS_PER_FRAME, MSG, MILESTONES, SPEEDS, DEFAULT_SPEED_INDEX,
  FAMILY_OF_TYPE, E_LOG_SCALE,
} from './shared.js';
// The real engine loads with the worker itself (in parallel with shared.js), not one round trip later.
import * as engineV1 from './engine.js';

const ENGINES = {
  v1: async () => engineV1,
  v09: () => import('../dev/engine-v09-adapter.js'),
  mock: () => import('../dev/mock-frames.js'),
};

// ─── constants ──────────────────────────────────────────────────────────────────────────────────────────
const W = 200;                    // stats.win.W
const SERIES_LEN = 600;           // per-tick births/deaths ring sent as frame.series
const TURNOVER_WIN = 500;         // the turnover milestone looks at the last 500 ticks
const POOL_SIZE = 3, START_CREDITS = 2;
const SLICE_MS = 10, FF_SLICE_MS = 30;
const PROGRESS_MS = 250, SERIES_MS = 250, ENGINE_STATS_MS = 500;
const KEYFRAME_EVERY = 1000, KEEP_KEYFRAMES = 8, KEEP_EVERY = 5000;
const THUMB = 128;
const DRAIN_CAP = 16384;
const NO_EVENT = -0x40000000;
const { STEM, ECTO, MESO, ENDO, NEURAL, MUSCLE, VESSEL } = TYPE;
const EV_BIRTH = EV.BIRTH, EV_DEATH = EV.DEATH, EV_FATE = EV.FATE;
const FAM = Int8Array.from(FAMILY_OF_TYPE);
const MS_INDEX = Object.fromEntries(MILESTONES.map((m, i) => [m.key, i]));
const ALL_MILESTONES = (1 << MILESTONES.length) - 1;
const LOG_K = 255 / E_LOG_SCALE;

// Window accumulator slots (one Float64Array row per tick): counts, recycled energy in milli-units (exact ints).
// C_RE = fate changes that move a specified cell into another germ-layer family (a band crossing; a specialisation
// such as mesoderm → muscle or ectoderm → neural stays in its family and is not one); C_STEMF = stem cells taking
// their first fate (newborns, and the core's own stem cells).
const C_B = 0, C_D = 1, C_F = 2, C_RIM = 3, C_RE = 4, C_REC = 5, C_CAUSE = 6, C_FTO = 10, C_STEMF = 18, C_LEN = 19;

// Toroidal centroid lookup (circular mean per axis).
const COS = new Float64Array(GRID), SIN = new Float64Array(GRID);
for (let k = 0; k < GRID; k++) { COS[k] = Math.cos((2 * Math.PI * k) / GRID); SIN[k] = Math.sin((2 * Math.PI * k) / GRID); }
const wrapCoord = (v) => ((v % GRID) + GRID) % GRID;
const wrapDelta = (d) => (d > GRID / 2 ? d - GRID : d < -GRID / 2 ? d + GRID : d);

// ─── worker state ───────────────────────────────────────────────────────────────────────────────────────
let mod = null, kind = 'v1', isMock = false, booted = false, booting = false;
const early = [];                 // messages that arrived while the engine module was loading
let live = null, viewSim = null;
let seed = 1, params = null, thrStem = 30, thrDiff = 42, cooldown = 14;
let running = false, tpsTarget = SPEEDS[DEFAULT_SPEED_INDEX], acc = 0;
let viewing = null, viewEntry = null, wasRunning = false;
let ffTarget = -1, ffResumeRunning = false, lastProgressT = 0;
let ctlSeq = 0;
let snapshotCap = 16, fieldsHz = 15, publishInterval = 1000 / 60;

// frame pool and cadence
const pool = [], morphPool = [];
let credits = START_CREDITS, frameId = 0, acked = 0, poolAllocs = 0;
let dirty = false, forceNext = false, cutNext = true;
let lastPublishT = -1e9, lastMorphT = -1e9, lastSeriesT = -1e9, morphDirty = true;
let lastPubTick = 0, lastPubPrevTick = 0;

// per-cell event bookkeeping + the event list of the next frame
const evTick = new Int32Array(N).fill(NO_EVENT);
const evKind = new Uint8Array(N), evDir = new Uint8Array(N), evPrev = new Uint8Array(N);
const drainBuf = new Int32Array(DRAIN_CAP * EV_WORDS);
const pendEv = new Int32Array(MAX_EVENTS_PER_FRAME * EV_WORDS);
let pendCount = 0, pendDropped = 0;

// incremental counts for per-tick milestone checks (resynced from the texture pass at every publish)
const tc = new Int32Array(8);
let cells = 0, founders = 0;
const founderMask = new Uint8Array(N);

// window stats, series and totals: everything a snapshot must carry to resume the same numbers
const win = makeWindow();
function makeWindow() {
  return {
    slots: new Float64Array(W * C_LEN), sum: new Float64Array(C_LEN), cur: new Float64Array(C_LEN),
    seriesB: new Uint16Array(SERIES_LEN), seriesD: new Uint16Array(SERIES_LEN),
    turn: new Float64Array(2),        // births, deaths over the last TURNOVER_WIN ticks
    totals: new Float64Array(3),      // births, deaths, fates since T0
  };
}
const cloneWindow = (w) => ({
  slots: w.slots.slice(), sum: w.sum.slice(), cur: new Float64Array(C_LEN),
  seriesB: w.seriesB.slice(), seriesD: w.seriesD.slice(), turn: w.turn.slice(), totals: w.totals.slice(),
});
function loadWindow(dst, src) {
  if (!src) { dst.slots.fill(0); dst.sum.fill(0); dst.seriesB.fill(0); dst.seriesD.fill(0); dst.turn.fill(0); dst.totals.fill(0); }
  else { dst.slots.set(src.slots); dst.sum.set(src.sum); dst.seriesB.set(src.seriesB); dst.seriesD.set(src.seriesD); dst.turn.set(src.turn); dst.totals.set(src.totals); }
  dst.cur.fill(0);
}

// milestones and snapshots
let fired = 0, snapSeq = 0, snapsChanged = false;
let snapshots = [];               // [{ snapId, tick, kind, key?, snap, aux }] sorted by tick
let milestoneStats = {};
const stage = { key: MILESTONES[0].key, label: MILESTONES[0].label, index: 0 };
let stageTick = -1;

// actual ticks/second: samples of (time, ticks done) every ~100 ms
const RATE_N = 12;
const rateT = new Float64Array(RATE_N), rateK = new Float64Array(RATE_N);
let rateHead = 0, rateFill = 0, ticksDone = 0, tpsActual = 0;

// engine-only numbers refreshed at ≤ 2 Hz (stats() allocates, so it is kept out of the per-frame path)
let engineLost = 0, lastEngineStatsT = -1e9;

// perf (EMA, ms)
const perf = { tickMs: 0, packMs: 0, frames: 0, ticks: 0, resyncs: 0 };

// mock engine state
let mockCells = 10000, mockFrame = null, mockView = null, mockPending = 0, mockId = 0;

// persistent stats object: mutated in place, structured-cloned by postMessage
const ST = makeStats();
function makeStats() {
  const z = (n) => new Array(n).fill(0);
  return {
    tick: 0, seed: 0, seedCount: 0, cellCount: 0, typeCounts: z(8),
    energy: { total: 0, initial: 0, driftPpm: 0, lost: 0, mean: 0, meanStem: 0, meanDiff: 0, thrStem: 0, thrDiff: 0,
      ready: 0, readyStem: 0, readyDiff: 0, readyRoom: 0, histStem: z(24), histDiff: z(24) },
    totals: { births: 0, deaths: 0, fates: 0 },
    win: { W, births: 0, deaths: 0, fates: 0, recycled: 0, deathsByCause: z(4), fatesTo: z(8), reSpecified: 0, stemFates: 0, rimBirthPct: 0 },
    geom: { cx: GRID / 2, cy: GRID / 2, rMax: 0, dmax: 0, bands: { e1: 1, e2: 2, e3: 6 }, gaps: 0,
      neural: { count: 0, cx: GRID / 2, cy: GRID / 2, spread: 0, anteriorPct: 0 } },
    signals: { maxAct: 0, maxInh: 0, maxMid: 0, maxAP: 0, meanAct: 0, maxMesoAct: 0, neuralCompetent: 0, muscleClustering: 0 },
    bands: { counts: z(5), matchPct: 0, stemCore: 0 },
    age: { old: 0 },
    plates: { fate: z(4) },
    stage, milestoneStats: {},
    tps: { target: 0, actual: 0 }, foundersAlive: 0,
  };
}
const neuralIdx = new Int32Array(N);
const series = { births: win.seriesB, deaths: win.seriesD, head: 0 };
const frameMsg = { type: MSG.FRAME, id: 0, tick: 0, prevTick: 0, running: false, viewing: null, ctl: 0,
  cell: null, life: null, idx: null, idxCount: 0, morph: null, events: null, eventCount: 0, eventsDropped: 0,
  stats: ST, series: null };
const transfer4 = [null, null, null, null], transfer5 = [null, null, null, null, null];

// ─── messaging ──────────────────────────────────────────────────────────────────────────────────────────
const post = (msg, transfer) => (transfer ? self.postMessage(msg, transfer) : self.postMessage(msg));
function postError(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  post({ type: MSG.ERROR, message: e.message, stack: e.stack || '' });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || typeof msg.type !== 'string') return;
  if (!booted) {
    if (msg.type === MSG.INIT && !booting) { booting = true; boot(msg).catch(postError); }
    else early.push(msg);
    return;
  }
  try { handle(msg); } catch (err) { postError(err); }
  planNext();
};
self.addEventListener('unhandledrejection', (e) => postError(e.reason));

async function boot(msg) {
  kind = msg.engine in ENGINES ? msg.engine : 'v1';
  if (msg.mockCells > 0 && msg.engine === undefined) kind = 'mock';
  isMock = kind === 'mock';
  seed = Number.isFinite(msg.seed) ? msg.seed >>> 0 : 1;
  tpsTarget = SPEEDS[msg.speedIndex] ?? SPEEDS[DEFAULT_SPEED_INDEX];
  running = !!msg.running;
  if (msg.snapshotCap > 0) snapshotCap = msg.snapshotCap | 0;
  if (msg.fieldsHz > 0) fieldsHz = +msg.fieldsHz;
  if (msg.publishHz > 0) publishInterval = 1000 / msg.publishHz;
  if (msg.mockCells > 0) mockCells = Math.min(25000, msg.mockCells | 0);
  try {
    mod = await ENGINES[kind]();
  } catch (err) {
    throw new Error(`could not load the ${kind} engine: ${err && err.message ? err.message : err}`);
  }
  for (let k = 0; k < POOL_SIZE; k++) { pool.push(makeSet()); morphPool.push(new Float32Array(4 * N)); }
  if (isMock) {
    params = mod.MOCK_PARAMS;
    post({ ...mod.makeMockReady({ seed }), engine: kind });
    mockStart();
  } else {
    params = mod.PARAMS;
    live = mod.createSim({ seed });
    post({
      type: MSG.READY, engine: kind, engineVersion: mod.ENGINE_VERSION, seed, seedCount: live.seedCount, grid: GRID,
      params: mod.PARAMS, fieldInfo: mod.FIELD_INFO, totalEnergy0: mod.PARAMS.totalEnergy,
    });
    simStart();
  }
  thrStem = params.divThreshStem; thrDiff = params.divThreshDiff; cooldown = params.divCooldown;
  booted = true;
  resetRate(performance.now());
  lastLoopT = performance.now();
  maybePublish(performance.now());
  for (const m of early.splice(0)) { try { handle(m); } catch (err) { postError(err); } }
  planNext();
}

const makeSet = () => ({ cell: new Uint8Array(4 * N), life: new Uint8Array(4 * N), idx: new Uint16Array(N),
  events: new Int32Array(EV_WORDS * MAX_EVENTS_PER_FRAME) });

function markControl(msg, { cut = false } = {}) {
  dirty = true; forceNext = true; morphDirty = true;
  if (cut) cutNext = true;
}

function handle(msg) {
  if (Number.isFinite(msg.seq)) ctlSeq = msg.seq;    // frames echo the latest command handled, whatever its type
  switch (msg.type) {
    case MSG.ACK: onAck(msg); break;
    case MSG.RUN: markControl(msg); cancelFF(); leaveView(false); setRunning(true); break;
    case MSG.PAUSE: markControl(msg); cancelFF(); if (viewing) wasRunning = false; else setRunning(false); break;
    case MSG.STEP: {
      markControl(msg); cancelFF(); leaveView(false); setRunning(false);
      const n = Math.max(1, Math.min(100000, (msg.n ?? 1) | 0));
      if (isMock) mockPending += n; else for (let k = 0; k < n; k++) tickOnce();
      break;
    }
    case MSG.RESET: {
      markControl(msg, { cut: true }); cancelFF();
      const keepRunning = viewing ? wasRunning : running;
      viewing = null; viewEntry = null;
      if (Number.isFinite(msg.seed)) seed = msg.seed >>> 0;
      if (isMock) mockStart(); else { live = mod.createSim({ seed }); simStart(); }
      setRunning(keepRunning);
      break;
    }
    case MSG.SPEED: {
      const t = +msg.tps;
      if (Number.isFinite(t) && t >= 0) { tpsTarget = t; acc = Math.min(acc, 1); resetRate(performance.now()); }
      dirty = true;
      break;
    }
    case MSG.FIELDS: if (msg.hz > 0) fieldsHz = +msg.hz; break;
    case MSG.INSPECT: {
      let detail = null;
      if (isMock) { const f = viewing ? mockView : mockFrame; detail = f ? mod.makeMockCellDetail(f, msg.idx) : null; }
      else {
        const sim = viewing ? viewSim : live;
        detail = sim ? sim.readCell(msg.idx) : null;
        if (detail) detail.hasRoom = hasRoom(sim.type, msg.idx);   // Rule 1 also needs an empty 4-neighbour
      }
      post({ type: MSG.INSPECT_RESULT, reqId: msg.reqId, detail: detail || null });
      break;
    }
    // Looking at a snapshot (or back at live) during a fast-forward leaves the jump running in the background.
    case MSG.VIEW_SNAPSHOT: markControl(msg, { cut: true }); viewSnapshot(msg.snapId); break;
    case MSG.LIVE: markControl(msg, { cut: true }); leaveView(true); break;
    case MSG.RESUME: markControl(msg, { cut: true }); cancelFF(); resume(); break;
    case MSG.FAST_FORWARD: markControl(msg); startFF(msg.tick); break;
    case 'hash': post({ type: 'hash', tick: currentTick(), hash: hashDisplayed(), viewing: viewing ? viewing.snapId : null }); break;
    case 'perf': post({ type: 'perf', kind, credits, poolFree: pool.length, published: frameId, acked, poolAllocs,
      tickMs: perf.tickMs, packMs: perf.packMs, ticks: perf.ticks, resyncs: perf.resyncs, tpsActual, tpsTarget, snapshots: snapshots.length }); break;
    case MSG.INIT: break; // already booted
    default: break;
  }
  maybePublish(performance.now());
}

function setRunning(on) {
  if (on && !running) { acc = 0; lastLoopT = performance.now(); resetRate(lastLoopT); }
  running = on;
  if (!on) tpsActual = 0;
}

function currentTick() {
  if (isMock) return viewing ? viewing.tick : mockTick();
  return viewing ? viewSim.tick : live.tick;
}

// ─── the sim ────────────────────────────────────────────────────────────────────────────────────────────
function simStart() {
  evTick.fill(NO_EVENT); evKind.fill(0); evDir.fill(0); evPrev.fill(0);
  pendCount = 0; pendDropped = 0;
  loadWindow(win, null);
  snapshots = []; fired = 0; milestoneStats = {}; stageTick = -1; setStage(0);
  recount(live);
  engineLost = 0; lastEngineStatsT = -1e9;
  lastPubTick = live.tick; lastPubPrevTick = live.tick;
  cutNext = true; dirty = true; forceNext = true; morphDirty = true;
  fireMilestone(MS_INDEX.seed, live.tick);
  snapsChanged = true;
  flushNotices();
}

function recount(sim) {
  const t = sim.type, born = sim.prov.bornTick;
  tc.fill(0); cells = 0; founders = 0;
  for (let i = 0; i < N; i++) {
    const ty = t[i];
    if (ty === 0) { founderMask[i] = 0; continue; }
    tc[ty]++; cells++;
    if (born[i] === 0) { founderMask[i] = 1; founders++; } else founderMask[i] = 0;
  }
}

// One tick: step, drain events into bookkeeping and the window, check milestones, take keyframes.
function tickOnce() {
  const t0 = performance.now();
  live.step(1);
  const T = live.tick;
  for (;;) {
    const n = live.drainEvents(drainBuf);
    if (n > 0) processEvents(n);
    if (n < DRAIN_CAP) break;
  }
  if (live.eventsDropped) pendDropped += live.eventsDropped;
  commitWindow(T);
  if (fired !== ALL_MILESTONES) checkMilestones(T);
  if (T % KEYFRAME_EVERY === 0) keyframe(T);
  ticksDone++; perf.ticks++;
  dirty = true; morphDirty = true;
  perf.tickMs += (performance.now() - t0 - perf.tickMs) * 0.02;
}

function processEvents(n) {
  const cur = win.cur;
  let depth = null;
  for (let k = 0, o = 0; k < n; k++, o += EV_WORDS) {
    const w0 = drainBuf[o], kd = w0 & 255, i = w0 >>> 8, a = drainBuf[o + 2], b = drainBuf[o + 3];
    evTick[i] = drainBuf[o + 1]; evKind[i] = kd;
    if (kd === EV_BIRTH) {
      evDir[i] = b & 3; evPrev[i] = 0;
      tc[STEM]++; cells++;
      if (founderMask[i]) { founderMask[i] = 0; founders--; }
      cur[C_B]++;
      if (depth === null) depth = live.depth;
      if (depth[i] === 1) cur[C_RIM]++;
    } else if (kd === EV_DEATH) {
      const t = a & 15;
      evDir[i] = 0; evPrev[i] = t;
      tc[t]--; cells--;
      if (founderMask[i]) { founderMask[i] = 0; founders--; }
      cur[C_D]++; cur[C_CAUSE + ((a >> 8) & 3)]++; cur[C_REC] += b;
    } else if (kd === EV_FATE) {
      const from = a & 15, to = (a >> 4) & 15;
      evDir[i] = 0; evPrev[i] = from;
      tc[from]--; tc[to]++;
      cur[C_F]++; cur[C_FTO + to]++;
      if (from === STEM) cur[C_STEMF]++;
      else if (FAM[from] !== FAM[to]) cur[C_RE]++;
    }
    if (pendCount < MAX_EVENTS_PER_FRAME) {
      const p = pendCount * EV_WORDS;
      pendEv[p] = w0; pendEv[p + 1] = drainBuf[o + 1]; pendEv[p + 2] = a; pendEv[p + 3] = b;
      pendCount++;
    } else pendDropped++;
  }
}

function commitWindow(T) {
  const { slots, sum, cur, seriesB, seriesD, turn, totals } = win;
  const base = (T % W) * C_LEN;
  for (let k = 0; k < C_LEN; k++) { sum[k] += cur[k] - slots[base + k]; slots[base + k] = cur[k]; }
  const b = cur[C_B], d = cur[C_D];
  totals[0] += b; totals[1] += d; totals[2] += cur[C_F];
  const s = T % SERIES_LEN, old = (T - TURNOVER_WIN) % SERIES_LEN;
  if (T - TURNOVER_WIN >= 1) { turn[0] -= seriesB[old]; turn[1] -= seriesD[old]; }
  seriesB[s] = b > 65535 ? 65535 : b; seriesD[s] = d > 65535 ? 65535 : d;
  turn[0] += seriesB[s]; turn[1] += seriesD[s];
  cur.fill(0);
}

// Milestone conditions: shared.js MILESTONES[].when, evaluated on the incremental counts after every tick.
function checkMilestones(T) {
  const n = cells;
  for (let m = 1; m < MILESTONES.length; m++) {
    if (fired & (1 << m)) continue;
    let hit = false;
    switch (MILESTONES[m].key) {
      case 'firstFates': hit = n - tc[STEM] > 0; break;
      case 'muscle': hit = tc[MUSCLE] >= 10; break;
      case 'layers': hit = n >= 200 && tc[ECTO] >= 0.05 * n && tc[MESO] + tc[MUSCLE] + tc[VESSEL] >= 0.05 * n
        && tc[ENDO] >= 0.05 * n && tc[STEM] >= 0.01 * n; break;
      case 'neural': hit = tc[NEURAL] >= 10; break;
      case 'endoCore': hit = n >= 500 && tc[ENDO] > tc[ECTO]; break;
      case 'turnover': hit = T > 1000 && win.turn[0] > 0 && Math.abs(win.turn[0] - win.turn[1]) < 0.15 * win.turn[0]; break;
      case 'founders': hit = T > 0 && founders === 0; break;
      default: break;
    }
    if (hit) fireMilestone(m, T);
  }
}

function fireMilestone(m, T) {
  const key = MILESTONES[m].key;
  fired |= 1 << m;
  const entry = takeSnapshot(T, 'milestone', key);
  thinSnapshots();
  const typeCounts = Array.from(tc);
  milestoneStats[key] = { tick: T, typeCounts };
  if (T >= stageTick) { stageTick = T; setStage(m); }
  const types = makeThumb(live);
  post({ type: MSG.MILESTONE, key, tick: T, snapId: entry.snapId, typeCounts, thumb: { w: THUMB, h: THUMB, types } }, [types.buffer]);
}

function setStage(m) { stage.key = MILESTONES[m].key; stage.label = MILESTONES[m].label; stage.index = m; }

function takeSnapshot(T, kindName, key) {
  // milestones reached in the same tick share one engine snapshot
  const same = snapshots.find((s) => s.tick === T);
  const snap = same ? same.snap : live.snapshot();
  const aux = same ? same.aux : { win: cloneWindow(win) };
  const entry = { snapId: ++snapSeq, tick: T, kind: kindName, snap, aux };
  if (key) entry.key = key;
  snapshots.push(entry);
  snapshots.sort((a, b) => a.tick - b.tick || a.snapId - b.snapId);
  snapsChanged = true;
  return entry;
}

function keyframe(T) {
  if (snapshots.some((s) => s.tick === T)) return;
  takeSnapshot(T, 'keyframe');
  thinSnapshots();
}

// Keep every milestone, the latest 8 keyframes and every 5000th; then enforce the hard cap by dropping the
// oldest ordinary keyframes first, then the oldest 5000th ones. Milestones are never dropped.
function thinSnapshots() {
  const keys = snapshots.filter((s) => s.kind === 'keyframe');
  const latest = new Set(keys.slice(-KEEP_KEYFRAMES));
  let drop = keys.filter((s) => !latest.has(s) && s.tick % KEEP_EVERY !== 0);
  let keep = snapshots.filter((s) => !drop.includes(s));
  const byAge = (pred) => keep.filter((s) => s.kind === 'keyframe' && pred(s) && s !== viewEntry);
  for (const pred of [(s) => s.tick % KEEP_EVERY !== 0, () => true]) {
    const cands = byAge(pred);
    while (keep.length > snapshotCap && cands.length) { const s = cands.shift(); keep = keep.filter((x) => x !== s); drop.push(s); }
  }
  if (drop.length) { snapshots = keep; snapsChanged = true; }
}

function flushNotices() {
  if (!snapsChanged) return;
  snapsChanged = false;
  post({ type: MSG.SNAPSHOTS, list: snapshots.map((s) => (s.key ? { snapId: s.snapId, tick: s.tick, kind: s.kind, key: s.key }
    : { snapId: s.snapId, tick: s.tick, kind: s.kind })) });
}

// Thumbnail: nearest-neighbour 128×128 resample of `type` in the square centred on (cx, cy),
// side clamp(2·rMax + 16, 24, 200), toroidal wrap, row-major, y down.
const geomTmp = new Float64Array(3);
function makeThumb(sim) {
  centroid(sim.type, geomTmp);
  const cx = geomTmp[0], cy = geomTmp[1], rMax = geomTmp[2];
  const out = new Uint8Array(THUMB * THUMB), t = sim.type;
  const side = Math.min(200, Math.max(24, 2 * rMax + 16)), x0 = cx - side / 2, y0 = cy - side / 2;
  for (let v = 0; v < THUMB; v++) {
    const y = wrapCoord(Math.floor(y0 + ((v + 0.5) * side) / THUMB));
    for (let u = 0; u < THUMB; u++) {
      const x = wrapCoord(Math.floor(x0 + ((u + 0.5) * side) / THUMB));
      out[v * THUMB + u] = t[y * GRID + x];
    }
  }
  return out;
}

// Toroidal-safe centroid (circular mean per axis) and rMax, into out[0..2].
function centroid(t, out) {
  let n = 0, cxs = 0, sxs = 0, cys = 0, sys = 0;
  for (let i = 0; i < N; i++) {
    if (t[i] === 0) continue;
    const x = i % GRID, y = (i / GRID) | 0;
    cxs += COS[x]; sxs += SIN[x]; cys += COS[y]; sys += SIN[y]; n++;
  }
  const cx = n ? wrapCoord((Math.atan2(sxs, cxs) * GRID) / (2 * Math.PI)) : GRID / 2;
  const cy = n ? wrapCoord((Math.atan2(sys, cys) * GRID) / (2 * Math.PI)) : GRID / 2;
  let r2 = 0;
  for (let i = 0; i < N; i++) {
    if (t[i] === 0) continue;
    const dx = wrapDelta((i % GRID) - cx), dy = wrapDelta(((i / GRID) | 0) - cy), q = dx * dx + dy * dy;
    if (q > r2) r2 = q;
  }
  out[0] = cx; out[1] = cy; out[2] = Math.sqrt(r2);
}

// ─── snapshots: view, live, resume ──────────────────────────────────────────────────────────────────────
function viewSnapshot(snapId) {
  const entry = snapshots.find((s) => s.snapId === snapId);
  if (!entry) { snapsChanged = true; return; }   // thinned away: the next frame (viewing null) and list tell main
  if (!viewing) { wasRunning = running; setRunning(false); }
  viewEntry = entry;
  viewing = entry.key ? { snapId: entry.snapId, tick: entry.tick, key: entry.key } : { snapId: entry.snapId, tick: entry.tick };
  if (isMock) { mockView = null; return; }       // built into a pooled set by publishMock()
  if (!viewSim) viewSim = mod.createSim({ seed });
  viewSim.restore(entry.snap);
}

function leaveView(restoreRunning) {
  if (!viewing) return;
  viewing = null; viewEntry = null; mockView = null;
  cutNext = true;
  if (isMock) mockPending = Math.max(mockPending, 1);   // the mock cannot re-pack a tick: show the next one
  // during a fast-forward the jump decides: finishFF() applies the run state it was started with
  if (restoreRunning && ffTarget < 0) setRunning(wasRunning);
}

function resume() {
  if (!viewing) return;
  const entry = viewEntry, T = entry.tick;
  if (isMock) { if (mockView) mockFrame = mockView; mockView = null; mockPending = Math.max(mockPending, 1); }
  else {
    live.restore(entry.snap);
    loadWindow(win, entry.aux.win);
    recount(live);
    evTick.fill(NO_EVENT); evKind.fill(0);
    pendCount = 0; pendDropped = 0;
  }
  // Deterministic replay will re-fire whatever happened after T.
  const before = snapshots.length;
  snapshots = snapshots.filter((s) => s.tick <= T);
  if (snapshots.length !== before) snapsChanged = true;
  fired = 0; stageTick = -1; setStage(0);
  const kept = {};
  for (let m = 0; m < MILESTONES.length; m++) {
    const ms = milestoneStats[MILESTONES[m].key];
    if (ms && ms.tick <= T) { kept[MILESTONES[m].key] = ms; fired |= 1 << m; if (ms.tick >= stageTick) { stageTick = ms.tick; setStage(m); } }
  }
  milestoneStats = kept;
  viewing = null; viewEntry = null;
  lastPubTick = T; lastPubPrevTick = T;
  setRunning(true);
  flushNotices();
}

// ─── fast-forward ───────────────────────────────────────────────────────────────────────────────────────
function startFF(target) {
  target = Math.floor(+target);
  if (!Number.isFinite(target)) return;
  leaveView(false);
  ffResumeRunning = ffTarget >= 0 ? ffResumeRunning : running;
  if (isMock) {
    if (target > mockTick()) mockBuildTick = target;
    finishFF(target);
    return;
  }
  if (target <= live.tick) { finishFF(target); return; }
  ffTarget = target;
  running = false;
  lastProgressT = 0;
}

function ffSlice(now) {
  const deadline = now + FF_SLICE_MS;
  while (live.tick < ffTarget && performance.now() < deadline) tickOnce();
  flushNotices();
  if (live.tick >= ffTarget) { const t = ffTarget; ffTarget = -1; finishFF(t); return; }
  if (now - lastProgressT >= PROGRESS_MS) { lastProgressT = now; post({ type: MSG.PROGRESS, tick: live.tick, target: ffTarget }); }
}

function finishFF(target) {
  post({ type: MSG.PROGRESS, tick: isMock ? mockTick() : live.tick, target, done: true });
  // events accumulated during the jump are not animated
  pendCount = 0;
  cutNext = true; dirty = true; forceNext = true; morphDirty = true;
  // still looking at a snapshot: the run state waits for the return to live
  if (viewing) { wasRunning = ffResumeRunning; setRunning(false); } else setRunning(ffResumeRunning);
}

// A run or step control stops the jump where it is (main says so: the link's target was not reached).
function cancelFF() {
  if (ffTarget < 0) return;
  const t = ffTarget;
  ffTarget = -1;
  post({ type: MSG.PROGRESS, tick: live.tick, target: t, done: true, cancelled: true });
  pendCount = 0; cutNext = true;
}

// ─── pacing loop ────────────────────────────────────────────────────────────────────────────────────────
let lastLoopT = 0, timer = null, timerDue = 0, pinged = false, pingStreak = 0;
const chan = new MessageChannel();
chan.port1.onmessage = () => { pinged = false; loop(); };
const onTimer = () => { timer = null; loop(); };

// Schedule the next loop slice. delay 0 = as soon as possible: a MessageChannel ping (no 4 ms timer clamp), but
// every 4th consecutive one is a setTimeout(0) so a self-sustaining ping chain can never starve incoming messages.
function wake(delay) {
  const now = performance.now();
  if (delay <= 0) {
    if (pinged) return;
    if (timer !== null) { if (timerDue <= now + 1) return; clearTimeout(timer); timer = null; }
    if (++pingStreak >= 4) { pingStreak = 0; timerDue = now; timer = setTimeout(onTimer, 0); return; }
    pinged = true; chan.port2.postMessage(0);
    return;
  }
  pingStreak = 0;
  if (pinged) return;
  const due = now + delay;
  if (timer !== null) { if (timerDue <= due + 0.5) return; clearTimeout(timer); }
  timerDue = due;
  timer = setTimeout(onTimer, delay);
}

function loop() {
  if (!booted) return;
  try {
    const now = performance.now();
    const dt = Math.min(now - lastLoopT, 1000);
    lastLoopT = now;
    if (ffTarget >= 0) ffSlice(now);
    else if (running && !viewing) runSlice(now, dt);
    flushNotices();
    sampleRate(performance.now());
    maybePublish(performance.now());
  } catch (err) {
    running = false; ffTarget = -1;
    postError(err);
  }
  planNext();
}

function runSlice(now, dt) {
  let due;
  if (tpsTarget > 0) {
    acc += (dt * tpsTarget) / 1000;
    const cap = Math.max(1, 0.25 * tpsTarget);
    if (acc > cap) acc = cap;
    due = Math.floor(acc);
  } else due = Infinity;
  if (isMock) {
    const n = due === Infinity ? 16 : due;
    mockPending = Math.min(64, mockPending + n); if (tpsTarget > 0) acc -= n;   // ticks count when published
    if (n > 0) dirty = true;
    return;
  }
  const deadline = now + SLICE_MS;
  let n = 0;
  while (n < due) { tickOnce(); n++; if (performance.now() >= deadline) break; }
  if (tpsTarget > 0) acc -= n;
}

function planNext() {
  if (!booted) return;
  if (ffTarget >= 0) { wake(0); return; }
  const now = performance.now();
  const publishWait = dirty && credits > 0 && pool.length > 0 ? Math.max(0, lastPublishT + publishInterval - now) : Infinity;
  if (running && !viewing) {
    if (tpsTarget === 0 || acc >= 1) { wake(0); return; }
    const d = Math.min(((1 - acc) * 1000) / tpsTarget, publishWait);
    wake(Math.max(1, d));
    return;
  }
  if (publishWait !== Infinity) wake(Math.max(1, publishWait));
}

function resetRate(now) {
  rateHead = 0; rateFill = 1; rateT[0] = now; rateK[0] = ticksDone; tpsActual = 0;
}
function sampleRate(now) {
  const last = (rateHead + RATE_N - 1) % RATE_N;
  if (rateFill && now - rateT[last] < 100) return;
  rateT[rateHead] = now; rateK[rateHead] = ticksDone;
  rateHead = (rateHead + 1) % RATE_N; rateFill = Math.min(RATE_N, rateFill + 1);
  if (!running || viewing) { tpsActual = 0; return; }
  // oldest sample no more than ~1.1 s old
  let o = (rateHead + RATE_N - rateFill) % RATE_N;
  for (let k = 0; k < rateFill - 1 && now - rateT[o] > 1100; k++) o = (o + 1) % RATE_N;
  const span = now - rateT[o];
  tpsActual = span >= 150 ? ((ticksDone - rateK[o]) * 1000) / span : tpsTarget;
}

// ─── credits, pool and publishing ───────────────────────────────────────────────────────────────────────
function onAck(msg) {
  acked++;
  credits = Math.min(START_CREDITS, credits + 1);
  const b = msg.buffers;
  if (b && b.cell && b.cell.length === 4 * N && b.life && b.life.length === 4 * N && b.idx && b.idx.length === N
      && b.events && b.events.length === EV_WORDS * MAX_EVENTS_PER_FRAME) {
    pool.push({ cell: b.cell, life: b.life, idx: b.idx, events: b.events });
  } else if (pool.length + credits <= POOL_SIZE) { pool.push(makeSet()); poolAllocs++; }
  if (b && b.morph && b.morph.length === 4 * N) morphPool.push(b.morph);
}

function maybePublish(now) {
  if (!booted || !dirty) return;
  // During a fast-forward only a viewed snapshot is published, once per control (its content does not change).
  if (ffTarget >= 0 && !(viewing && forceNext)) return;
  if (credits <= 0 || pool.length === 0) return;
  if (!forceNext && now - lastPublishT < publishInterval - 2) return;
  if (isMock) publishMock(now); else publish(now);
}

function publish(now) {
  const t0 = performance.now();
  const set = pool.pop();
  const sim = viewing ? viewSim : live;
  const tick = sim.tick;
  const morphDue = morphDirty && (forceNext || cutNext || now - lastMorphT >= 1000 / fieldsHz) && morphPool.length > 0;
  const morph = morphDue ? morphPool.pop() : null;
  const cut = cutNext || !!viewing;
  const prevTick = cut ? tick : tick === lastPubTick ? lastPubPrevTick : lastPubTick;
  // Cut frames (first, reset, fast-forward, live, snapshots) show the state without replaying its events.
  const idxCount = pack(set, sim, morph, tick, cut, cut ? 0 : tick - lastPubTick);
  if (cut && !viewing) evKind.fill(0);
  fillStats(sim, viewing ? viewEntry.aux.win : win, tick);

  const f = frameMsg;
  f.id = ++frameId; f.tick = tick; f.prevTick = prevTick; f.running = running && !viewing; f.viewing = viewing; f.ctl = ctlSeq;
  f.cell = set.cell; f.life = set.life; f.idx = set.idx; f.idxCount = idxCount; f.morph = morph;
  let ne = 0;
  if (!viewing && !cut) { ne = pendCount; const w = ne * EV_WORDS, ev = set.events; for (let j = 0; j < w; j++) ev[j] = pendEv[j]; }
  f.events = set.events; f.eventCount = ne; f.eventsDropped = viewing ? 0 : pendDropped;
  f.series = null;
  if (forceNext || cut || now - lastSeriesT >= SERIES_MS) {
    const w = viewing ? viewEntry.aux.win : win;
    series.births = w.seriesB; series.deaths = w.seriesD; series.head = (tick + 1) % SERIES_LEN;
    f.series = series; lastSeriesT = now;
  }
  let tl;
  if (morph) { tl = transfer5; tl[4] = morph.buffer; } else tl = transfer4;
  tl[0] = set.cell.buffer; tl[1] = set.life.buffer; tl[2] = set.idx.buffer; tl[3] = set.events.buffer;
  post(f, tl);
  f.cell = f.life = f.idx = f.events = f.morph = null; f.series = null;

  credits--;
  if (morph) { lastMorphT = now; morphDirty = false; }
  if (!viewing) { pendCount = 0; pendDropped = 0; lastPubPrevTick = prevTick; lastPubTick = tick; }
  lastPublishT = now; dirty = false; forceNext = false; cutNext = false;
  perf.frames++;
  perf.packMs += (performance.now() - t0 - perf.packMs) * 0.05;
}

// Pack the cell/life textures, the instance list and (when due) morph; accumulate stats in the same pass.
// Stats accumulators live in module scope so fillStats can finish them without allocating.
const A = new Float64Array(32);
const A_TOTAL = 0, A_COMP = 1, A_ESTEM = 2, A_EDIFF = 3, A_READY = 4, A_READYS = 5, A_READYD = 6, A_OLD = 7, A_MATCH = 8,
  A_GAPS = 9, A_FOUND = 10, A_SUMACT = 11, A_MAXACT = 12, A_MAXINH = 13, A_MAXMID = 14, A_MAXAP = 15, A_MAXMESO = 16,
  A_COMPET = 17, A_CXC = 18, A_CXS = 19, A_CYC = 20, A_CYS = 21, A_NNEUR = 22, A_N = 23, A_ROOM = 24, A_STEMCORE = 25,
  A_MUSCSAME = 26, A_MUSCN = 27;

// Torus 4-neighbours of cell i at (x, y).
const nbL = (i, x) => (x === 0 ? i + GRID - 1 : i - 1);
const nbR = (i, x) => (x === GRID - 1 ? i - GRID + 1 : i + 1);
const nbU = (i, y) => (y === 0 ? i + N - GRID : i - GRID);
const nbD = (i, y) => (y === GRID - 1 ? i - N + GRID : i + GRID);
/** Rule 1's other condition: an empty 4-neighbour to put the daughter in. */
function hasRoom(type, i) {
  const x = i % GRID, y = (i / GRID) | 0;
  return type[nbL(i, x)] === 0 || type[nbR(i, x)] === 0 || type[nbU(i, y)] === 0 || type[nbD(i, y)] === 0;
}
const tcount = new Int32Array(8), bcount = new Int32Array(5), fcount = new Int32Array(4);
const hStem = new Int32Array(24), hDiff = new Int32Array(24);

function pack(set, sim, morph, tick, still, sincePub) {
  const cell = set.cell, life = set.life, idx = set.idx;
  const type = sim.type, energy = sim.energy, age = sim.age, maxAge = sim.maxAge, depth = sim.depth, band = sim.band;
  const born = sim.prov.bornTick;
  const m0 = sim.morph[0], m1 = sim.morph[1], m2 = sim.morph[2], m3 = sim.morph[3];
  const gMid = params.gates.neuralMid, gAP = params.gates.neuralAP;
  const ghostTicks = Math.min(255, Math.ceil(0.5 * Math.max(tpsTarget || tpsActual, 2.5)) + sincePub);
  const tS = thrStem, tD = thrDiff, cd = cooldown;
  A.fill(0); tcount.fill(0); bcount.fill(0); fcount.fill(0); hStem.fill(0); hDiff.fill(0);
  let total = 0, comp = 0, nNeur = 0, n = 0;
  let maxAct = 0, maxInh = 0, maxMid = 0, maxAP = 0, maxMeso = 0, sumAct = 0;
  let eStem = 0, eDiff = 0, ready = 0, readyS = 0, readyD = 0, old = 0, match = 0, gaps = 0, found = 0, compet = 0;
  let room = 0, stemCore = 0, muscSame = 0, muscN = 0;
  let cxc = 0, cxs = 0, cyc = 0, cys = 0;
  for (let i = 0, o = 0; i < N; i++, o += 4) {
    const t = type[i];
    let bits = 0, evAge = 255;
    if (!still) {
      const k = evKind[i];
      if (k !== 0) {
        const ea = tick - evTick[i];
        evAge = ea > 255 ? 255 : ea < 0 ? 0 : ea;
        bits = k | (evDir[i] << 2) | (evPrev[i] << 4);
      }
    }
    if (t === 0) {
      const d = depth[i];
      cell[o] = 0; cell[o + 1] = 0; cell[o + 2] = d; cell[o + 3] = 0;
      life[o] = 0; life[o + 1] = bits; life[o + 2] = evAge; life[o + 3] = 0;
      if (d === 255) gaps++;
      if ((bits & 3) === 2 && evAge <= ghostTicks) idx[n++] = i;
      continue;
    }
    const e = energy[i], a = age[i], ma = maxAge[i], bd = band[i];
    const lg = Math.log2(1 + e) * LOG_K;
    cell[o] = t; cell[o + 1] = bd; cell[o + 2] = depth[i]; cell[o + 3] = lg >= 255 ? 255 : lg <= 0 ? 0 : Math.round(lg);
    const r = ma > 0 ? a / ma : 1;
    const stem = t === STEM, thr = stem ? tS : tD;
    const rdy = e > thr && a >= cd;
    const x = i % GRID, y = (i / GRID) | 0;
    // bit 7 (the Energy stain's gold) marks a cell that can divide now: above its threshold, past its cooldown, and
    // with an empty neighbour for the daughter (Rule 1). Most cells above the threshold are boxed in and wait.
    const canDivide = rdy && (type[nbL(i, x)] === 0 || type[nbR(i, x)] === 0 || type[nbU(i, y)] === 0 || type[nbD(i, y)] === 0);
    life[o] = r >= 1 ? 255 : Math.round(255 * r);
    life[o + 1] = bits | (canDivide ? 128 : 0); life[o + 2] = evAge; life[o + 3] = 0;
    idx[n++] = i;

    // stats
    tcount[t]++;
    const u = total + e;
    comp += Math.abs(total) >= Math.abs(e) ? total - u + e : e - u + total;
    total = u;
    const bin = (e / thr) * 12, bi = bin >= 23 ? 23 : bin | 0;
    if (stem) { eStem += e; hStem[bi]++; } else { eDiff += e; hDiff[bi]++; }
    if (rdy) { ready++; if (stem) readyS++; else readyD++; if (canDivide) room++; }
    if (r > 0.85) old++;
    bcount[bd]++;
    if (stem && bd === 4) stemCore++;
    if (t === MUSCLE) {
      // clustering: the share of a muscle cell's live 4-neighbours that are muscle too (engine-v1.md's definition)
      const a1 = type[nbL(i, x)], a2 = type[nbR(i, x)], a3 = type[nbU(i, y)], a4 = type[nbD(i, y)];
      const lv = (a1 !== 0) + (a2 !== 0) + (a3 !== 0) + (a4 !== 0);
      if (lv > 0) { muscSame += ((a1 === MUSCLE) + (a2 === MUSCLE) + (a3 === MUSCLE) + (a4 === MUSCLE)) / lv; muscN++; }
    }
    const fam = FAM[t];
    fcount[fam]++;
    if (fam === bd - 1) match++;
    if (born[i] === 0) found++;
    const act = m0[i], inh = m1[i], mid = m2[i], ap = m3[i];
    if (act > maxAct) maxAct = act;
    if (inh > maxInh) maxInh = inh;
    if (mid > maxMid) maxMid = mid;
    if (ap > maxAP) maxAP = ap;
    sumAct += act;
    if (t === MESO && act > maxMeso) maxMeso = act;
    if (bd === 1 && mid > gMid && ap > gAP) compet++;
    if (t === NEURAL) neuralIdx[nNeur++] = i;
    cxc += COS[x]; cxs += SIN[x]; cyc += COS[y]; cys += SIN[y];
  }
  if (morph) {
    for (let i = 0, o = 0; i < N; i++, o += 4) { morph[o] = m0[i]; morph[o + 1] = m1[i]; morph[o + 2] = m2[i]; morph[o + 3] = m3[i]; }
  }
  A[A_TOTAL] = total + comp; A[A_ESTEM] = eStem; A[A_EDIFF] = eDiff; A[A_READY] = ready; A[A_READYS] = readyS;
  A[A_READYD] = readyD; A[A_OLD] = old; A[A_MATCH] = match; A[A_GAPS] = gaps; A[A_FOUND] = found; A[A_SUMACT] = sumAct;
  A[A_MAXACT] = maxAct; A[A_MAXINH] = maxInh; A[A_MAXMID] = maxMid; A[A_MAXAP] = maxAP; A[A_MAXMESO] = maxMeso;
  A[A_COMPET] = compet; A[A_CXC] = cxc; A[A_CXS] = cxs; A[A_CYC] = cyc; A[A_CYS] = cys; A[A_NNEUR] = nNeur;
  A[A_ROOM] = room; A[A_STEMCORE] = stemCore; A[A_MUSCSAME] = muscSame; A[A_MUSCN] = muscN;
  lastIdxSet = idx; lastIdxCount = n;
  return n;
}
let lastIdxSet = null, lastIdxCount = 0;

function fillStats(sim, w, tick) {
  const s = ST, n = tcount[1] + tcount[2] + tcount[3] + tcount[4] + tcount[5] + tcount[6] + tcount[7];
  // resync the incremental counters from the exact texture pass (live frames only)
  if (sim === live) {
    let off = cells !== n || founders !== A[A_FOUND];
    for (let k = 0; k < 8; k++) { if (tc[k] !== tcount[k]) off = true; tc[k] = tcount[k]; }
    if (off) perf.resyncs++;
    cells = n; founders = A[A_FOUND];
  }
  const now = performance.now();
  if (now - lastEngineStatsT > ENGINE_STATS_MS && sim === live) { lastEngineStatsT = now; engineLost = +live.stats().energyLost || 0; }

  s.tick = tick; s.seed = seed; s.seedCount = sim.seedCount; s.cellCount = n;
  for (let k = 0; k < 8; k++) s.typeCounts[k] = tcount[k];
  // Σ is the live cells' energy; after an extinction the engine carries it in its pool, which only its own
  // totalEnergy includes (cheap to read then: no live cells to scan).
  const total = n === 0 && typeof sim.stats === 'function' ? +sim.stats().totalEnergy || 0 : A[A_TOTAL];
  const E = s.energy, initial = params.totalEnergy, nStem = tcount[STEM], nDiff = n - nStem;
  E.total = total; E.initial = initial; E.driftPpm = ((total - initial) / initial) * 1e6; E.lost = sim === live ? engineLost : 0;
  E.mean = n ? total / n : 0; E.meanStem = nStem ? A[A_ESTEM] / nStem : 0; E.meanDiff = nDiff ? A[A_EDIFF] / nDiff : 0;
  E.thrStem = thrStem; E.thrDiff = thrDiff; E.ready = A[A_READY]; E.readyStem = A[A_READYS]; E.readyDiff = A[A_READYD];
  E.readyRoom = A[A_ROOM];
  for (let k = 0; k < 24; k++) { E.histStem[k] = hStem[k]; E.histDiff[k] = hDiff[k]; }

  s.totals.births = w.totals[0]; s.totals.deaths = w.totals[1]; s.totals.fates = w.totals[2];
  const sum = w.sum, Wn = s.win;
  Wn.births = sum[C_B]; Wn.deaths = sum[C_D]; Wn.fates = sum[C_F]; Wn.recycled = sum[C_REC] / 1000;
  for (let k = 0; k < 4; k++) Wn.deathsByCause[k] = sum[C_CAUSE + k];
  for (let k = 0; k < 8; k++) Wn.fatesTo[k] = sum[C_FTO + k];
  Wn.reSpecified = sum[C_RE]; Wn.stemFates = sum[C_STEMF]; Wn.rimBirthPct = sum[C_B] ? (100 * sum[C_RIM]) / sum[C_B] : 0;

  // geometry: toroidal centroid, rMax over the instance list, neural patch relative to the centroid
  const G = s.geom;
  const cx = n ? wrapCoord((Math.atan2(A[A_CXS], A[A_CXC]) * GRID) / (2 * Math.PI)) : GRID / 2;
  const cy = n ? wrapCoord((Math.atan2(A[A_CYS], A[A_CYC]) * GRID) / (2 * Math.PI)) : GRID / 2;
  let r2 = 0;
  const t = sim.type, idxList = lastIdxSet;
  for (let k = 0; k < lastIdxCount; k++) {
    const i = idxList[k];
    if (t[i] === 0) continue;
    const dx = wrapDelta((i % GRID) - cx), dy = wrapDelta(((i / GRID) | 0) - cy), q = dx * dx + dy * dy;
    if (q > r2) r2 = q;
  }
  G.cx = cx; G.cy = cy; G.rMax = Math.sqrt(r2); G.dmax = sim.dmax;
  G.bands.e1 = sim.bands.e1; G.bands.e2 = sim.bands.e2; G.bands.e3 = sim.bands.e3; G.gaps = A[A_GAPS];
  const nN = A[A_NNEUR];
  let sx = 0, sy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < nN; k++) {
    const i = neuralIdx[k], dx = wrapDelta((i % GRID) - cx), dy = wrapDelta(((i / GRID) | 0) - cy);
    sx += dx; sy += dy; sxx += dx * dx; syy += dy * dy;
  }
  let ant = 0;
  for (let k = 0; k < nN; k++) { const i = neuralIdx[k]; if (wrapDelta(((i / GRID) | 0) - cy) < 0) ant++; }
  const mx = nN ? sx / nN : 0, my = nN ? sy / nN : 0, NG = G.neural;
  NG.count = nN; NG.cx = wrapCoord(cx + mx); NG.cy = wrapCoord(cy + my);
  NG.spread = nN ? Math.sqrt(Math.max(0, sxx / nN - mx * mx + syy / nN - my * my)) : 0;
  NG.anteriorPct = nN ? (100 * ant) / nN : 0;

  const S = s.signals;
  S.maxAct = A[A_MAXACT]; S.maxInh = A[A_MAXINH]; S.maxMid = A[A_MAXMID]; S.maxAP = A[A_MAXAP];
  S.meanAct = n ? A[A_SUMACT] / n : 0; S.maxMesoAct = A[A_MAXMESO]; S.neuralCompetent = A[A_COMPET];
  S.muscleClustering = A[A_MUSCN] ? A[A_MUSCSAME] / A[A_MUSCN] : 0;
  for (let k = 0; k < 5; k++) s.bands.counts[k] = bcount[k];
  s.bands.stemCore = A[A_STEMCORE];
  s.bands.matchPct = n ? (100 * A[A_MATCH]) / n : 0;
  s.age.old = A[A_OLD];
  for (let k = 0; k < 4; k++) s.plates.fate[k] = fcount[k];
  if (viewing) {
    // the stage and milestone numbers as they were at the viewed tick
    const vs = {};
    let best = 0, bestTick = -1;
    for (let m = 0; m < MILESTONES.length; m++) {
      const ms = milestoneStats[MILESTONES[m].key];
      if (ms && ms.tick <= tick) { vs[MILESTONES[m].key] = ms; if (ms.tick >= bestTick) { bestTick = ms.tick; best = m; } }
    }
    s.stage = { key: MILESTONES[best].key, label: MILESTONES[best].label, index: best };
    s.milestoneStats = vs;
  } else { s.stage = stage; s.milestoneStats = milestoneStats; }
  s.tps.target = tpsTarget; s.tps.actual = running && !viewing ? Math.round(tpsActual * 10) / 10 : 0;
  s.foundersAlive = A[A_FOUND];
}

// ─── mock engine (dev/mock-frames.js) ───────────────────────────────────────────────────────────────────
// Synthetic frames for scene/HUD work at large cell counts. Milestones follow the mock's fixed timeline;
// snapshots are rebuilt at their tick; resume continues from the rebuilt organism (not deterministic).
const MOCK_START_TICK = 5000;
let mockBuildTick = -1;
const mockTick = () => (mockBuildTick >= 0 ? mockBuildTick : mockFrame ? mockFrame.tick + mockPending : MOCK_START_TICK);

function mockStart() {
  mockFrame = null; mockView = null; mockPending = 0; mockBuildTick = MOCK_START_TICK;
  snapshots = []; milestoneStats = {};
  for (const m of mod.makeMockMilestones(MOCK_START_TICK)) {
    if (m.tick === null) continue;
    const snapId = ++snapSeq;
    snapshots.push({ snapId, tick: m.tick, kind: 'milestone', key: m.key, snap: null, aux: null });
    const f = mod.makeMockFrame({ cells: m.tick === 0 ? 37 : mockCells, tick: m.tick, seed, id: 0, morph: false, series: false });
    const types = mod.makeMockThumbTypes(f);
    const typeCounts = Array.from(f.stats.typeCounts);
    milestoneStats[m.key] = { tick: m.tick, typeCounts };
    post({ type: MSG.MILESTONE, key: m.key, tick: m.tick, snapId, typeCounts, thumb: { w: THUMB, h: THUMB, types } }, [types.buffer]);
  }
  snapshots.sort((a, b) => a.tick - b.tick);
  snapsChanged = true; flushNotices();
  cutNext = true; dirty = true; forceNext = true;
}

function publishMock(now) {
  const cut = cutNext || !!viewing;
  // The mock cannot re-pack an unchanged tick. A command still gets an answering frame: the next tick (live) or
  // a rebuild of the viewed snapshot; otherwise nothing new is published.
  if (forceNext) { if (viewing) mockView = null; else if (mockBuildTick < 0 && mockPending <= 0) mockPending = 1; }
  const building = viewing ? !mockView : mockBuildTick >= 0;
  if (!building && !viewing && mockPending <= 0) { dirty = false; return; }
  if (viewing && !building) { dirty = false; return; }
  const set = pool.pop();
  const morphDue = (forceNext || cut || now - lastMorphT >= 1000 / fieldsHz) && morphPool.length > 0;
  const morph = morphDue ? morphPool.pop() : null;
  const seriesDue = forceNext || cut || now - lastSeriesT >= SERIES_MS;
  const buffers = { cell: set.cell, life: set.life, idx: set.idx, events: set.events };
  if (morph) buffers.morph = morph;
  const opts = { id: ++frameId, running: running && !viewing, morph: !!morph, series: seriesDue, buffers };
  let f;
  if (viewing) { f = mod.makeMockFrame({ ...opts, cells: viewing.tick === 0 ? 37 : mockCells, tick: viewing.tick, seed }); mockView = f; }
  else if (mockBuildTick >= 0) { f = mod.makeMockFrame({ ...opts, cells: mockCells, tick: mockBuildTick, seed }); mockBuildTick = -1; mockPending = 0; mockFrame = f; }
  else {
    const n = Math.min(mockPending, 64);
    f = mod.makeMockFrame({ ...opts, prev: mockFrame, tick: mockFrame.tick + n });
    mockPending = 0; mockFrame = f; ticksDone += n;
  }
  f.running = running && !viewing; f.viewing = viewing; f.ctl = ctlSeq;
  if (cut) { f.prevTick = f.tick; f.eventCount = 0; }
  f.stats.tps = { target: tpsTarget, actual: running && !viewing ? Math.round(tpsActual) : 0 };
  post(f, mod.mockTransferList(f));
  credits--;
  if (morph) lastMorphT = now;
  if (seriesDue) lastSeriesT = now;
  lastPublishT = now; dirty = false; forceNext = false; cutNext = false;
  perf.frames++;
}

// ─── dev helpers ────────────────────────────────────────────────────────────────────────────────────────
function hashDisplayed() {
  if (isMock) return null;
  const sim = viewing ? viewSim : live;
  if (typeof mod.hashState === 'function') return mod.hashState(sim);
  let h = 0x811C9DC5;
  for (const a of [sim.type, sim.energy, sim.age]) {
    const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let k = 0; k < u8.length; k++) h = Math.imul(h ^ u8[k], 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
