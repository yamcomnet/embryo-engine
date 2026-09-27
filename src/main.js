// src/main.js: boot, the AppState store, worker I/O, the display clock, the render-on-demand loop, picking and
// the inspector, milestone thumbnails, adaptive quality, share links, reduced motion and URL parameters.
// SPEC §3.6 as amended by ADDENDUM §B and §G. The single writer of AppState is dispatch() → reduce().
//
// URL parameters: seed=S · t=TICK (fast-forward) · view=<id|1..8> · apart=1 (x=1) · cam=specimen|close|map ·
//                 q=auto|high|medium|low · engine=v1|v09|mock · mock=<cells> (mock engine with that many cells).

import {
  N, VIEWS, VIEW_INDEX, SPEEDS, DEFAULT_SPEED_INDEX, CAMERA_PRESETS, QUALITY_MODES, MSG, MILESTONES, TISSUE_HEX, viewIdFrom,
} from './shared.js';
import { TIERS } from './scene/quality.js';   // pure data (no three): the tiers' DPR caps and floors
import { orbitTurning, orbitIdleReason } from './ui/dock.js';   // the dock's Orbit button and the stage agree on it

const $ = (id) => document.getElementById(id);
const canvas = $('stage'), labelsRoot = $('labels'), hudRoot = $('hud');

// ─── constants ──────────────────────────────────────────────────────────────────────────────────────────
const AUTOSTART_MS = 1200;
const STATS_MS = 100;            // hud.setStats / stage.setStats ≤ 10 Hz
const PICK_MS = 33;              // pointer picking ≤ 30 Hz
const INSPECT_MS = 100;          // hover inspect ≤ 10 Hz
const PIN_REFRESH_MS = 250;      // pinned (or held hover) cell refreshed at 4 Hz
const LAYOUT_MS = 200;           // the HUD's footprint → stage (label exclusions, view centring) at 5 Hz
const TAP_MS = 300, TAP_PX = 6;
const TIER_ORDER = ['low', 'medium', 'high'];
const MOBILE_MQ = '(max-width: 759px), (max-height: 499px) and (pointer: coarse)';   // = the HUD's mobile layout
// A share link's tick is capped where a fast-forward still ends within about half an hour (≈ 1,100 ticks/s late in a
// run on an M2 Pro); a clamped link says so. The progress pill always offers Stop.
const T_MAX = 2_000_000;

// ─── URL parameters ─────────────────────────────────────────────────────────────────────────────────────
function parseParams(search) {
  const p = new URLSearchParams(search);
  const int = (k) => { const v = p.get(k); if (v === null || v.trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : null; };
  const out = { seed: null, t: null, tClamped: false, view: null, apart: false, cam: null, q: null, engine: null, mockCells: 0 };
  const seed = int('seed'); if (seed !== null && seed >= 0) out.seed = seed >>> 0;
  // t=0 is kept (a link shared at T 0 lands paused like any other share link); only t > 0 fast-forwards
  const t = int('t'); if (t !== null && t >= 0) { out.t = Math.min(t, T_MAX); out.tClamped = t > T_MAX; }
  // own view ids or keys only: ?view=toString must not reach the HUD as a view
  const view = p.get('view');
  if (view) out.view = viewIdFrom(view);
  out.apart = p.get('apart') === '1' || p.get('x') === '1';
  const cam = p.get('cam'); if (CAMERA_PRESETS.includes(cam)) out.cam = cam;
  const q = p.get('q'); if (QUALITY_MODES.includes(q)) out.q = q;
  const engine = p.get('engine'); if (engine === 'v1' || engine === 'v09' || engine === 'mock') out.engine = engine;
  const mock = int('mock'); if (mock !== null && mock > 0) { out.mockCells = Math.min(25000, mock); out.engine = out.engine || 'mock'; }
  return out;
}

// ─── the reducer ────────────────────────────────────────────────────────────────────────────────────────
// reduce(state, action) → { s, fx }. Pure: side effects are returned as fx tuples and run by commit().
//   ['w', message]            post to the worker (control messages get a seq)
//   ['stage', method, ...a]   call a stage method
//   ['hint', text]            hud.setHint
//   ['share']                 copy the share link
const clampIndex = (i) => Math.max(0, Math.min(SPEEDS.length - 1, i | 0));
const validIdx = (i) => (Number.isInteger(i) && i >= 0 && i < N ? i : null);
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fieldsHzFor = (s) => (s.quality.tier === 'low' ? 8 : VIEWS[VIEW_INDEX[s.view]]?.group === 'signal' ? 30 : 15);

function resetMilestones() {
  return MILESTONES.map(({ key, label, awaiting }) => ({ key, label, awaiting, tick: null, snapId: null, thumb: null }));
}

// Milestones reached so far, in time order (the targets of milestone{key} and milestoneDelta).
const reachedMilestones = (s) => s.milestones.filter((m) => m.snapId !== null).sort((a, b) => a.tick - b.tick || MILESTONES.findIndex((x) => x.key === a.key) - MILESTONES.findIndex((x) => x.key === b.key));

function viewTarget(s, snapId) {
  const snap = s.snapshots.find((x) => x.snapId === snapId);
  if (snap) return snap.key ? { snapId, tick: snap.tick, key: snap.key } : { snapId, tick: snap.tick };
  const m = s.milestones.find((x) => x.snapId === snapId);
  return m ? { snapId, tick: m.tick, key: m.key } : null;
}

// Actions that drive the simulation. With the error card up (the worker faulted, or the scene died) they do
// nothing: the card's Reload is the way on, and a faulted worker must not be restarted behind it.
const SIM_ACTIONS = new Set(['toggleRun', 'run', 'step', 'reset', 'newSeed', 'resume', 'milestone', 'milestoneDelta', 'viewSnapshot']);

export function reduce(s, a) {
  const fx = [];
  const set = (patch) => { s = { ...s, ...patch }; };
  if (s.error && SIM_ACTIONS.has(a.type)) return { s, fx };
  const goView = (snapId) => {
    const v = viewTarget(s, snapId);
    if (!v) return;
    set({ viewing: v, running: false });
    fx.push(['w', { type: MSG.VIEW_SNAPSHOT, snapId }]);
  };
  switch (a.type) {
    case 'toggleRun':
      // during a fast-forward Space is Stop: the jump ends where it is (and says so), the view stays as it is
      if (s.progress) { set({ running: false, progress: null }); fx.push(['w', { type: MSG.PAUSE }]); break; }
      if (s.viewing) { set({ viewing: null, running: true, progress: null }); fx.push(['w', { type: MSG.LIVE }], ['w', { type: MSG.RUN }]); break; }
      set({ running: !s.running, progress: s.running ? s.progress : null });
      fx.push(['w', { type: s.running ? MSG.RUN : MSG.PAUSE }]);
      break;
    case 'run':
      if (s.viewing) fx.push(['w', { type: MSG.LIVE }]);
      set({ viewing: null, running: true, progress: null }); fx.push(['w', { type: MSG.RUN }]);
      break;
    case 'pause': set({ running: false, progress: null }); fx.push(['w', { type: MSG.PAUSE }]); break;
    case 'step': {
      const n = Math.max(1, Math.min(10000, Number.isFinite(+a.n) ? Math.floor(+a.n) : 1));
      set({ running: false, viewing: null, progress: null }); fx.push(['w', { type: MSG.STEP, n }]);
      break;
    }
    case 'reset':
      set({ viewing: null, progress: null, hover: null, pinned: null, milestones: resetMilestones(), snapshots: [] });
      fx.push(['w', { type: MSG.RESET, seed: s.seed }], ['hint', `Reset · seed ${s.seed}`]);
      break;
    case 'newSeed': {
      let seed = Number.isFinite(+a.seed) ? +a.seed >>> 0 : 1 + Math.floor(Math.random() * 99999);
      if (seed === s.seed && !Number.isFinite(+a.seed)) seed = (seed % 99999) + 1;
      set({ seed, viewing: null, progress: null, hover: null, pinned: null, milestones: resetMilestones(), snapshots: [] });
      fx.push(['w', { type: MSG.RESET, seed }], ['hint', `New seed · ${seed}`]);
      break;
    }
    case 'speed': case 'speedDelta': {
      const i = clampIndex(a.type === 'speed' ? +a.index : s.speedIndex + Math.sign(+a.delta || 0));
      if (!Number.isFinite(i) || i === s.speedIndex) break;
      set({ speedIndex: i, tps: { ...s.tps, target: SPEEDS[i] } });
      fx.push(['w', { type: MSG.SPEED, tps: SPEEDS[i] }]);
      break;
    }
    case 'view': {
      const id = viewIdFrom(a.id);
      if (id && id !== s.view) set({ view: id });
      break;
    }
    case 'isolate': {
      const t = a.tissue === null || a.tissue === undefined ? null : a.tissue | 0;
      set({ isolate: t >= 1 && t <= 7 ? t : null });
      break;
    }
    case 'toggleExplode': set({ exploded: !s.exploded }); break;
    case 'explode': set({ exploded: !!a.on }); break;
    case 'camera': case 'cycleCamera': {
      const preset = a.type === 'camera' ? a.preset
        : CAMERA_PRESETS[(CAMERA_PRESETS.indexOf(s.camera) + 1) % CAMERA_PRESETS.length];
      if (!CAMERA_PRESETS.includes(preset)) break;
      set({ camera: preset, autoFrame: true });
      fx.push(['stage', 'setCamera', preset]);
      break;
    }
    case 'frame': set({ autoFrame: true }); fx.push(['stage', 'frameOrganism']); break;
    case 'userCamera': if (s.autoFrame) set({ autoFrame: false }); break;
    case 'orbit': set({ autoFrame: false }); fx.push(['stage', 'orbitBy', +a.dAz || 0, +a.dEl || 0]); break;
    case 'zoom': { const f = +a.factor; if (f > 0) { set({ autoFrame: false }); fx.push(['stage', 'zoomBy', f]); } break; }
    case 'milestone': {
      const m = s.milestones.find((x) => x.key === a.key);
      if (!m) break;
      if (m.snapId !== null) goView(m.snapId);
      else fx.push(['hint', `${m.label}: not reached yet${m.awaiting ? ` · ${m.awaiting}` : ''}`]);
      break;
    }
    case 'milestoneDelta': {
      const list = reachedMilestones(s), d = Math.sign(+a.delta || 0);
      if (!list.length || !d) break;
      let pos;
      if (!s.viewing) pos = list.length;                     // live sits after the last milestone
      else {
        pos = list.findIndex((m) => m.snapId === s.viewing.snapId);
        if (pos < 0) { pos = list.findIndex((m) => m.tick > s.viewing.tick); if (pos < 0) pos = list.length; if (d > 0) pos -= 1; }
      }
      const next = pos + d;
      if (next < 0) break;
      if (next >= list.length) {
        if (s.viewing) { set({ viewing: null }); fx.push(['w', { type: MSG.LIVE }]); }
        else fx.push(['hint', 'Live: no later milestone yet · [ goes back']);
        break;
      }
      goView(list[next].snapId);
      break;
    }
    case 'viewSnapshot': goView(+a.snapId); break;
    case 'live': if (s.viewing) { set({ viewing: null }); fx.push(['w', { type: MSG.LIVE }]); } break;
    case 'resume': {
      if (!s.viewing) break;
      const T = s.viewing.tick;
      const milestones = s.milestones.map((m) => (m.tick !== null && m.tick > T ? { ...m, tick: null, snapId: null, thumb: null } : m));
      set({ viewing: null, running: true, progress: null, milestones, snapshots: s.snapshots.filter((x) => x.tick <= T) });
      fx.push(['w', { type: MSG.RESUME }], ['hint', `Resumed from T ${fmtInt(T)} · the same future replays`]);
      break;
    }
    case 'hover': { const idx = validIdx(a.idx); if (idx !== s.hover) set({ hover: idx }); break; }
    case 'pin': { const idx = validIdx(a.idx); if (idx !== s.pinned) set({ pinned: idx }); break; }
    case 'quality': case 'cycleQuality': {
      const mode = a.type === 'quality' ? a.mode : QUALITY_MODES[(QUALITY_MODES.indexOf(s.quality.mode) + 1) % QUALITY_MODES.length];
      if (!QUALITY_MODES.includes(mode)) break;
      const tier = mode === 'auto' ? AUTO_TIER : mode;         // auto starts again from the device's default tier
      set({ quality: { ...s.quality, mode, tier } });
      if (a.type === 'cycleQuality') fx.push(['hint', `Quality: ${mode === 'auto' ? `auto (${tier})` : mode}`]);
      break;
    }
    case 'help': set({ helpOpen: !!a.open }); break;
    case 'toggleHelp': set({ helpOpen: !s.helpOpen }); break;
    case 'escape':
      if (s.helpOpen) set({ helpOpen: false });
      else if (s.pinned !== null) set({ pinned: null });
      else if (s.viewing) { set({ viewing: null }); fx.push(['w', { type: MSG.LIVE }]); }
      else if (s.progress && !s.error) { set({ running: false, progress: null }); fx.push(['w', { type: MSG.PAUSE }]); }   // stop a fast-forward
      else if (s.isolate) set({ isolate: null });
      else if (s.hover !== null) set({ hover: null });
      break;
    case 'reducedMotion': set({ reducedMotion: !!a.on }); break;
    // turntable orbit (O, or the dock's Orbit): the stage turns only while running, following, live, in motion, not in Map
    case 'toggleTurntable': {
      set({ turntable: !s.turntable });
      const why = orbitIdleReason(s);                        // on, but idle: say when it will turn
      fx.push(['hint', s.turntable ? `Orbit on${why ? ` · ${why[0].toLowerCase() + why.slice(1)}` : ''}` : 'Orbit off']);
      break;
    }
    case 'share': fx.push(['share']); break;
    default: break;
  }
  return { s, fx };
}

// Actions arrive as { type, ...payload } (HUD, keys, stage) or as dispatch('name', payload).
// §G.4 writes isolate's payload as `type`, which collides with the action type: accept isolate/tissue/value too.
function normalize(a, payload) {
  let act;
  if (typeof a === 'string') {
    const p = payload && typeof payload === 'object' ? payload : { value: payload };
    act = { ...p, type: a };
    if (a === 'isolate') act.tissue = p.tissue ?? p.isolate ?? p.type ?? p.value ?? null;
  } else if (a && typeof a === 'object') {
    if (typeof a.action === 'string') { act = { ...a, type: a.action }; if (a.action === 'isolate') act.tissue = a.tissue ?? a.isolate ?? a.type ?? a.value ?? null; }
    else if (typeof a.type === 'string') { act = a; if (a.type === 'isolate') act = { ...a, tissue: a.tissue ?? a.isolate ?? a.value ?? null }; }
  }
  if (!act) return null;
  // accept `value` as the main parameter of single-parameter actions
  if ('value' in act) {
    const main = { step: 'n', speed: 'index', speedDelta: 'delta', view: 'id', explode: 'on', camera: 'preset', zoom: 'factor',
      milestone: 'key', milestoneDelta: 'delta', viewSnapshot: 'snapId', hover: 'idx', pin: 'idx', quality: 'mode', help: 'open',
      reducedMotion: 'on' }[act.type];
    if (main && act[main] === undefined) act = { ...act, [main]: act.value };
  }
  return act;
}

// ─── app ────────────────────────────────────────────────────────────────────────────────────────────────
const params = parseParams(location.search);
const isMobile = matchMedia(MOBILE_MQ).matches;
const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;   // hints name keys only where there are keys
const rmQuery = matchMedia('(prefers-reduced-motion: reduce)');
let rmOverride = null;                  // M key / help toggle overrides the OS setting for this session

// Auto quality starts at Low on touch devices or ≤ 4 GB, otherwise Medium (SPEC §3.6.8), then adapts.
const AUTO_TIER = matchMedia('(pointer: coarse)').matches || (navigator.deviceMemory && navigator.deviceMemory <= 4) ? 'low' : 'medium';
const initialTier = params.q && params.q !== 'auto' ? params.q : AUTO_TIER;

let state = {
  ready: false, stageReady: false, error: null, seed: params.seed ?? 1, seedCount: 37, engineVersion: '', params: null, fieldInfo: null,
  running: false, speedIndex: DEFAULT_SPEED_INDEX, tps: { target: SPEEDS[DEFAULT_SPEED_INDEX], actual: 0 },
  view: params.view || 'cells', isolate: null, exploded: params.apart,
  camera: params.cam || (isMobile ? 'close' : 'specimen'), autoFrame: true,
  viewing: null, milestones: resetMilestones(), snapshots: [],
  hover: null, pinned: null,
  quality: { mode: params.q || 'auto', tier: initialTier, dpr: Math.min(devicePixelRatio || 1, 2) },
  reducedMotion: rmQuery.matches, helpOpen: false, progress: null,
  turntable: true,        // polish: slow cinematic orbit while running and untouched (O toggles)
};

let hud = null, stage = null, worker = null, unbindKeys = null;
let ctlSeq = 0, userStarted = false, sceneDirty = true, queuedRun = false;
const getState = () => state;

// Until the 3D scene exists, a run would play out unseen: a run request waits for it (and then starts), the other
// run controls are ignored (the HUD keeps them disabled meanwhile).
const NEEDS_STAGE = new Set(['toggleRun', 'run', 'step', 'reset', 'newSeed', 'resume']);

function dispatch(a, payload) {
  const act = normalize(a, payload);
  if (!act) return;
  if (!state.stageReady && NEEDS_STAGE.has(act.type) && !state.error) {
    if (act.type === 'toggleRun' || act.type === 'run') { queuedRun = true; userStarted = true; hud?.setHint('Loading the 3D scene…'); }
    return;
  }
  if (['toggleRun', 'run', 'pause', 'step', 'reset', 'newSeed', 'viewSnapshot', 'milestone', 'resume'].includes(act.type)) userStarted = true;
  if (act.type === 'reducedMotion') rmOverride = !!act.on;
  const { s, fx } = reduce(state, act);
  commit(s, fx);
}

// Apply a new state: sync the stage from the diff, run effects, re-render the HUD.
function commit(next, fx = []) {
  const prev = state;
  state = next;
  if (stage && !sceneDead) syncStage(prev, next, false);
  if (worker && fieldsHzFor(prev) !== fieldsHzFor(next)) worker.postMessage({ type: MSG.FIELDS, hz: fieldsHzFor(next) });
  if (prev.hover !== next.hover || prev.pinned !== next.pinned) inspector.targetChanged();
  for (const f of fx) runEffect(f);
  if (next !== prev) { sceneDirty = true; hud?.render(state); }
}

function patch(p) { commit({ ...state, ...p }); }

function syncStage(a, b, all) {
  const ch = (k) => all || a[k] !== b[k];
  if (ch('view')) stage.setView(b.view);
  if (ch('isolate')) stage.setIsolate(b.isolate);
  if (ch('exploded')) stage.setExploded(b.exploded);
  if (all) stage.setCamera(b.camera);
  if (ch('autoFrame')) stage.setAutoFrame(b.autoFrame);
  if (ch('hover') || ch('pinned')) stage.setHighlight({ hover: b.hover, pinned: b.pinned });
  if (ch('reducedMotion')) stage.setReducedMotion(b.reducedMotion);
  if (all || orbitTurning(a) !== orbitTurning(b)) stage.setTurntable?.(orbitTurning(b));
  if (all || a.quality.tier !== b.quality.tier || a.quality.mode !== b.quality.mode) {
    if (quality.dprOverridden) { stage.setQuality({ tier: b.quality.tier, dpr: null }); quality.dprOverridden = false; }
    else stage.setQuality(b.quality.tier);
    const q = stage.getQuality();
    if (q.dpr !== b.quality.dpr || q.tier !== b.quality.tier) state = { ...state, quality: { ...state.quality, tier: q.tier, dpr: q.dpr } };
    quality.onTierApplied();
  }
}

// Worker commands after which the scene is rebuilt or starts moving (a cut, a new state upload, the first frames
// of a run): the next second of frame times says nothing about the device, so adaptive quality ignores it.
const GRACE_MSGS = new Set([MSG.RUN, MSG.RESET, MSG.RESUME, MSG.VIEW_SNAPSHOT, MSG.LIVE]);

function runEffect([kind, ...args]) {
  if (kind === 'w') {
    const msg = args[0];
    if (!worker) return;
    msg.seq = ++ctlSeq;
    worker.postMessage(msg);
    if (GRACE_MSGS.has(msg.type)) quality.grace(performance.now());
  } else if (kind === 'stage') {
    const [method, ...rest] = args;
    if (stage && !sceneDead && typeof stage[method] === 'function') stage[method](...rest);
  } else if (kind === 'hint') hud?.setHint(args[0]);
  else if (kind === 'share') share();
}

// ─── worker I/O ─────────────────────────────────────────────────────────────────────────────────────────
const clock = { visTick: 0, tick: 0, prevTick: 0, viewingId: null };
let latestStats = null, statsDirty = false, lastStatsPush = -1e9, lastTpsPatch = -1e9, lastLayout = -1e9;
let heldFrames = [];
let firstFrameSeen = false;
let pendingFF = null;             // the share link's fast-forward target, from posting it until its progress is done
const ackMsg = { type: MSG.ACK, id: 0, buffers: { cell: null, life: null, idx: null, events: null, morph: undefined } };
const ackList4 = [null, null, null, null], ackList5 = [null, null, null, null, null];

// Frames that arrive while the tab is hidden are held (not acked, so the worker stops publishing) and ingested when
// it shows again. Registered before the worker exists: the first frame can arrive, hidden, long before the stage
// has loaded, and the tab can become visible at any moment of that boot.
function onVisibility() {
  if (document.hidden) return;
  flushHeldFrames();
  lastRaf = 0; lastRendered = false; sceneDirty = true;
  quality.grace(performance.now());
}
function flushHeldFrames() {
  if (!heldFrames.length) return;
  const held = heldFrames; heldFrames = [];
  for (const f of held) ingest(f);                       // acks resume; the worker publishes a fresh frame
}

function startWorker() {
  document.addEventListener('visibilitychange', onVisibility);
  worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => onWorkerMessage(e.data);
  worker.onerror = (e) => { e.preventDefault?.(); fail(`The simulation worker failed: ${e.message || 'script error'}`); };
  worker.onmessageerror = () => fail('The simulation worker sent a message that could not be read.');
  worker.postMessage({
    type: MSG.INIT, seed: state.seed, speedIndex: state.speedIndex, running: false,
    snapshotCap: initialTier === 'low' ? 6 : 16, fieldsHz: fieldsHzFor(state),
    engine: params.engine || 'v1', mockCells: params.mockCells || undefined,
  });
}

function onWorkerMessage(m) {
  switch (m.type) {
    case MSG.FRAME: onFrame(m); break;
    case MSG.READY:
      patch({ ready: true, seed: m.seed, seedCount: m.seedCount, engineVersion: m.engineVersion, params: m.params, fieldInfo: m.fieldInfo });
      stage?.setFieldInfo(m.fieldInfo, m.params);
      if (params.t > 0) { pendingFF = params.t; worker.postMessage({ type: MSG.FAST_FORWARD, tick: params.t, seq: ++ctlSeq }); }
      break;
    case MSG.MILESTONE: onMilestone(m); break;
    case MSG.SNAPSHOTS: onSnapshots(m.list || []); break;
    case MSG.INSPECT_RESULT: inspector.onResult(m); break;
    case MSG.PROGRESS: {
      const p = m.done ? null : { tick: m.tick, target: m.target };
      if (m.done) { pendingFF = null; quality.grace(performance.now()); }   // a whole new state is uploaded next
      patch({ progress: p });
      hud?.setProgress(p);
      // stopped by a run or step control (or Stop): say where the jump ended and that the link's tick was not reached
      if (m.done && m.cancelled && m.tick < m.target) hud?.setHint(`Fast-forward stopped at T ${fmtInt(m.tick)} of ${fmtInt(m.target)} · link target not reached`, 8000);
      break;
    }
    case MSG.ERROR: fail(m.message || 'The simulation stopped with an error.', m.stack); break;
    default: break;
  }
}

// Main-thread cost of frame ingest (stage.setFrame + ack + clock), for QA via window.__ee.perf.
const perf = { frames: 0, ingestMs: 0, ingestMax: 0 };

function onFrame(f) {
  if (document.hidden) { heldFrames.push(f); return; }     // no acks while hidden: the worker stops publishing
  const t0 = performance.now();
  ingest(f);
  const ms = performance.now() - t0;
  perf.frames++; perf.ingestMs += (ms - perf.ingestMs) * 0.05; if (ms > perf.ingestMax) perf.ingestMax = ms;
}

function ingest(f) {
  // Every frame is acked, whatever the stage does with it: an unacked frame is a credit the worker never gets back,
  // and with two credits two exceptions would stop it for good.
  try {
    if (stage) { if (!sceneDead) stage.setFrame(f); }
    else { pendingBeforeStage.length = 0; pendingBeforeStage.push(copyFrame(f)); }   // replayed once the stage exists
  } catch (err) {
    sceneError(err);
  } finally {
    ack(f);
  }
  // display clock (SPEC §3.6.4)
  const viewingId = f.viewing ? f.viewing.snapId : null;
  if (f.prevTick === f.tick || viewingId !== clock.viewingId || f.tick < clock.tick) clock.visTick = f.tick;
  else if (f.tick - clock.visTick > 3 * (f.tick - f.prevTick)) clock.visTick = f.prevTick;
  clock.tick = f.tick; clock.prevTick = f.prevTick; clock.viewingId = viewingId;
  latestStats = f.stats; statsDirty = true; sceneDirty = true;
  // The worker is authoritative for running/viewing once it has handled our latest command.
  if (f.ctl === ctlSeq) {
    const viewing = f.viewing ? { ...f.viewing } : null;
    const same = (state.viewing?.snapId ?? null) === (viewing?.snapId ?? null);
    if (f.running !== state.running || !same) patch({ running: f.running, viewing: same ? state.viewing : viewing });
  }
  const now = performance.now();
  if (now - lastTpsPatch > 500 && f.stats?.tps && f.stats.tps.actual !== state.tps.actual) {
    lastTpsPatch = now;
    patch({ tps: { target: state.tps.target, actual: f.stats.tps.actual } });
  }
  if (!firstFrameSeen) { firstFrameSeen = true; maybeAutostart(); }
}

function ack(f) {
  const b = ackMsg.buffers;
  b.cell = f.cell; b.life = f.life; b.idx = f.idx; b.events = f.events; b.morph = f.morph || undefined;
  ackMsg.id = f.id;
  let list = ackList4;
  if (f.morph) { list = ackList5; list[4] = f.morph.buffer; }
  list[0] = f.cell.buffer; list[1] = f.life.buffer; list[2] = f.idx.buffer; list[3] = f.events.buffer;
  try { worker?.postMessage(ackMsg, list); }
  finally { b.cell = b.life = b.idx = b.events = null; b.morph = undefined; }
}

// Stats to the HUD and stage at ≤ 10 Hz (the HUD also rewrites the canvas aria-label, at 1 Hz).
function pushStats(now) {
  if (!statsDirty || !latestStats || now - lastStatsPush < STATS_MS) return;
  statsDirty = false; lastStatsPush = now;
  hud?.setStats(latestStats, state);
  stage?.setStats(latestStats);
}

// The HUD's panels → the stage: notes keep clear of them and the specimen centres in the space they leave.
function pushLayout(now, force = false) {
  if (!hud?.layout || !stage || (!force && now - lastLayout < LAYOUT_MS)) return;
  lastLayout = now;
  stage.setHudLayout(hud.layout());
}

// Milestone thumbnails: one pixel per cell in its tissue colour; empty stays transparent.
const PAL = TISSUE_HEX.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
function paintThumb({ w, h, types }) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(w, h), d = img.data;
  for (let i = 0, o = 0; i < types.length; i++, o += 4) {
    const t = types[i];
    if (!t) continue;
    const p = PAL[t] || PAL[1];
    d[o] = p[0]; d[o + 1] = p[1]; d[o + 2] = p[2]; d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  c.style.imageRendering = 'pixelated';
  return c;
}

function onMilestone(m) {
  const thumb = m.thumb ? paintThumb(m.thumb) : null;
  const milestones = state.milestones.map((x) => (x.key === m.key ? { ...x, tick: m.tick, snapId: m.snapId, thumb } : x));
  const snapshots = state.snapshots.some((x) => x.snapId === m.snapId) ? state.snapshots
    : [...state.snapshots, { snapId: m.snapId, tick: m.tick, kind: 'milestone', key: m.key }].sort((a, b) => a.tick - b.tick);
  patch({ milestones, snapshots });
}

function onSnapshots(list) {
  const ids = new Set(list.map((x) => x.snapId));
  // milestones whose snapshot is gone were undone by a resume: they are awaiting again
  const milestones = state.milestones.map((m) => (m.snapId !== null && !ids.has(m.snapId) ? { ...m, tick: null, snapId: null, thumb: null } : m));
  patch({ snapshots: list, milestones });
}

function fail(message, stack) {
  if (stack) console.error(message, stack); else console.error(message);
  // the run stops behind the card whatever failed (a faulted worker has stopped itself; this also covers the rest)
  try { if (worker) runEffect(['w', { type: MSG.PAUSE }]); } catch { /* the worker may be gone */ }
  try { patch({ error: message, running: false }); } catch (err) { console.error(err); }   // the card shows regardless
  hud?.showError(message);
}

// Errors from our own code outside the worker (the stage while ingesting or rendering, the HUD, input handlers).
// Each is logged; a burst of them (3 within 1 s: a broken scene throws every frame) stops the 3D view: the rAF loop
// no longer calls into the stage, the worker is paused (fail() alone only patches local state) and the error card
// shows. A single transient error costs nothing else: its frame is still acked.
const ERR_BURST = 3, ERR_BURST_MS = 1000;
const SRC_URL = new URL('./', import.meta.url).href;     // …/src/: errors whose stack is ours
let sceneDead = false;
const errTimes = [];
function sceneError(err, { logged = false, where = 'scene' } = {}) {
  if (sceneDead) return;
  if (!logged) console.error(err);
  const now = performance.now();
  while (errTimes.length && now - errTimes[0] > ERR_BURST_MS) errTimes.shift();
  errTimes.push(now);
  if (errTimes.length < ERR_BURST) return;
  sceneDead = true;
  labelsRoot.style.visibility = 'hidden';
  if (worker) runEffect(['w', { type: MSG.PAUSE }]);
  fail(where === 'scene' ? 'The 3D view stopped with an error.' : 'The app stopped with an error.', err && err.stack ? err.stack : String(err));
}
// Backstop for uncaught errors from src/ (the browser has already logged them).
const ours = (err, file) => String((err && err.stack) || file || '').includes(SRC_URL);
window.addEventListener('error', (e) => { if (ours(e.error, e.filename)) sceneError(e.error || e.message, { logged: true, where: 'app' }); });
window.addEventListener('unhandledrejection', (e) => { if (ours(e.reason)) sceneError(e.reason, { logged: true, where: 'app' }); });

// ─── boot ───────────────────────────────────────────────────────────────────────────────────────────────
function hasWebGL2() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}

function hasModuleWorker() {
  let supported = false;
  try {
    const url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
    const w = new Worker(url, { get type() { supported = true; return 'module'; } });
    w.terminate();
    URL.revokeObjectURL(url);
  } catch { return false; }
  return supported;
}

function minimalFallback(reason) {
  hudRoot.innerHTML = '';
  const p = document.createElement('p');
  p.style.cssText = 'position:fixed;left:24px;bottom:24px;max-width:40ch;margin:0;color:#C9C3B8;font:14px/1.5 system-ui,sans-serif;pointer-events:auto';
  p.append(`${reason} `);
  const a = document.createElement('a');
  a.href = './classic.html'; a.textContent = 'Open the classic 2D version.'; a.style.color = '#ECE7DC';
  p.append(a);
  hudRoot.append(p);
}

async function boot() {
  // The capability checks need no module; when they pass, the 3D scene's modules and the worker (with the engine)
  // start loading at once, in parallel with the HUD, instead of one import level after it.
  const reason = !hasWebGL2() ? 'webgl2' : !hasModuleWorker() ? 'module-worker' : null;
  let sceneP = null;
  if (!reason) {
    sceneP = Promise.all([import('./scene/stage.js'), import('./ui/keys.js')]);
    sceneP.catch(() => {});                              // handled where it is awaited
    startWorker();
  }
  try {
    const { createHud } = await import('./ui/hud.js');
    hud = createHud(hudRoot, { dispatch });
  } catch (err) {
    console.error(err);
    worker?.terminate(); worker = null;
    minimalFallback('The interface could not load.');
    return;
  }
  try {
    hud.render(state);
    if (reason) { hud.showFallback(reason); return; }
    if (params.tClamped) hud.setHint(`Link time clamped to T ${fmtInt(T_MAX)}`, 8000);
  } catch (err) { bootFailed(err); return; }

  try {
    const [{ createStage }, { bindKeys }] = await sceneP;
    unbindKeys = bindKeys(window, { dispatch, getState });
    stage = await createStage(canvas, {
      quality: state.quality.tier, reducedMotion: state.reducedMotion, labelsRoot, palette: TISSUE_HEX,
      onAction: (a) => dispatch(a), onUserCamera: () => dispatch({ type: 'userCamera' }),
    });
  } catch (err) {
    console.error(err);
    worker?.terminate(); worker = null;
    hud.showFallback(`scene: ${err && err.message ? err.message : err}`);
    return;
  }
  try {
    syncStage(state, state, true);
    pushLayout(performance.now(), true);
    if (state.fieldInfo) stage.setFieldInfo(state.fieldInfo, state.params);
    if (latestStats) { stage.setStats(latestStats); statsDirty = true; }
    try { for (const f of pendingBeforeStage.splice(0)) stage.setFrame(f); } catch (err) { sceneError(err); }
    bindPointer();
    bindEnvironment();
    bindContextLoss();
    if (!document.hidden) flushHeldFrames();             // belt and braces: visible, yet frames still held
    patch({ stageReady: true });
    requestAnimationFrame(frameLoop);
    if (queuedRun && !state.error) { queuedRun = false; dispatch({ type: 'run' }); }
    maybeAutostart();
    precompileSoon();
  } catch (err) { bootFailed(err); }
}
// Anything that throws while the app is being put together ends in a card, never in a page stuck on "preparing".
function bootFailed(err) {
  console.error(err);
  try { worker?.terminate(); } catch { /* already gone */ }
  worker = null;
  try { if (hud) hud.showFallback(`boot: ${err && err.message ? err.message : err}`); else minimalFallback('The specimen could not start.'); }
  catch { minimalFallback('The specimen could not start.'); }
}
// Shader programs for the Low tier (no shadows) are compiled while the browser is idle, so adaptive quality's
// first switch to Low does not freeze the page on a synchronous compile.
function precompileSoon() {
  if (state.quality.tier === 'low' || typeof stage?.precompileShadowless !== 'function') return;
  const run = () => { try { if (!sceneDead && !glLost) stage.precompileShadowless(); } catch (err) { console.warn('[main] precompile:', err); } };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 }); else setTimeout(run, 2000);
}
const pendingBeforeStage = [];

// Autostart 1.2 s after the scene shows its first frame, unless reduced motion or a share link (which lands paused,
// T 0 included).
let autostartArmed = false;
function maybeAutostart() {
  if (autostartArmed || !stage || !firstFrameSeen) return;
  autostartArmed = true;
  if (params.t !== null) return;
  if (state.reducedMotion) { hud?.setHint(TOUCH ? 'Tap ▶ to start' : 'Press Space to start'); return; }
  setTimeout(() => { if (!userStarted && !state.running && !state.viewing && !state.error) dispatch({ type: 'run' }); userStarted = true; }, AUTOSTART_MS);
}

// ─── WebGL context loss ─────────────────────────────────────────────────────────────────────────────────
// three.js recovers by itself when the browser restores the context. Until then nothing is drawn: the callouts are
// hidden (they would point at a black dish) and the loop stops rendering. If the context is not back after
// CONTEXT_WAIT_MS of the tab being visible (browsers may wait for visibility to restore), the run is paused and
// the error card offers a reload.
const CONTEXT_WAIT_MS = 4000;
let glLost = false, glGaveUp = false, glTimer = 0;
function bindContextLoss() {
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();                                  // allow a restore (three.js does this too)
    if (glLost) return;
    glLost = true;
    labelsRoot.style.visibility = 'hidden';
    hud?.setHint('Graphics reset… restoring', 0);
    let waited = 0;
    clearInterval(glTimer);
    glTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      waited += 250;
      if (waited < CONTEXT_WAIT_MS) return;
      clearInterval(glTimer); glTimer = 0;
      glGaveUp = true;
      hud?.setHint('');
      if (worker) runEffect(['w', { type: MSG.PAUSE }]);
      fail('The graphics context was lost and did not come back. Reload to try again.');
    }, 250);
  });
  canvas.addEventListener('webglcontextrestored', () => {
    clearInterval(glTimer); glTimer = 0;
    if (!glLost) return;
    glLost = false;
    if (!sceneDead) labelsRoot.style.visibility = '';
    hud?.setHint('');
    if (glGaveUp) { glGaveUp = false; if (!sceneDead) patch({ error: null }); }   // closes the card
    stage.resize();
    sceneDirty = true; lastRendered = false;
    quality.grace(performance.now());
  });
}

// ─── render loop (render on demand) and the display clock ───────────────────────────────────────────────
let lastRaf = 0, lastRendered = false;

function frameLoop(now) {
  if (sceneDead) return;                                 // stopped after a burst of errors (sceneError)
  requestAnimationFrame(frameLoop);
  const t0 = performance.now();
  try { frame(now); } catch (err) { sceneError(err); }
  lastWorkMs = performance.now() - t0;                   // adaptive quality: is the main thread the bottleneck?
}

function frame(now) {
  const dt = lastRaf ? Math.min(0.1, (now - lastRaf) / 1000) : 1 / 60;
  const interval = now - lastRaf;
  lastRaf = now;

  // display clock (SPEC §3.6.4). While paused, visTick may run up to τ past the last frame so the animations of
  // its final tick complete (visRel > 0 simply clamps every phase to 1).
  const rate = state.running ? Math.max(latestStats?.tps?.actual || state.tps.target || 0, 1) : 2.5;
  const rm = state.reducedMotion;
  const tauBirth = Math.max(1, (rm ? 0.12 : 0.40) * rate), tauDeath = Math.max(1, (rm ? 0.12 : 0.45) * rate), tauFate = Math.max(1, (rm ? 0.12 : 0.30) * rate);
  const hi = state.running && !state.viewing ? clock.tick : clock.tick + Math.max(tauBirth, tauDeath, tauFate);
  const before = clock.visTick;
  clock.visTick = Math.min(hi, Math.max(clock.prevTick, clock.visTick + dt * rate));
  stage.setClock({ visRel: clock.visTick - clock.tick, tauBirth, tauDeath, tauFate });

  pushLayout(now);           // reads layout first, before pushStats writes to the HUD's DOM
  pushStats(now);
  const animating = clock.visTick !== before;
  let rendered = false;
  if (!glLost && (stage.needsRender() || animating || state.running || sceneDirty)) {
    stage.render(dt, now);
    sceneDirty = false;
    rendered = true;
    inspector.follow();
  }
  // Adaptive quality samples only continuous rendering: when rendering resumes after an idle stretch (paused, the
  // camera settled, a fast-forward), its window starts over instead of closing on a few fresh frames.
  if (rendered && lastRendered) quality.sample(interval, lastWorkMs, now);
  else if (rendered) quality.resetWindow(now);
  lastRendered = rendered;
  inspector.tick(now);
}

// ─── picking and the inspector ──────────────────────────────────────────────────────────────────────────
// A pin follows one cell, not a grid slot. Cells never move, so once the slot no longer holds the cell that was
// pinned (empty, or a different bornTick: a daughter born into it later), that cell has died, or, in a snapshot of
// another time, is not alive there. The pin is then released with a hint instead of silently adopting the occupant.
const inspector = (() => {
  let reqId = 0, lastSent = -1e9, lastRefresh = -1e9, pendingTarget = false;
  let shownIdx = null, detail = null, anchor = null;
  let sentView = null, sentIdx = null;                     // what the latest request asked: view and cell
  let pinIdx = null, pinBorn = null, pinSeenTick = 0, pinSeenView = null;
  const target = () => (state.pinned !== null ? state.pinned : state.hover);
  const viewKey = () => (state.viewing ? state.viewing.snapId : 'live');
  function request(now) {
    const idx = target();
    if (idx === null || !worker) return;
    lastSent = now; lastRefresh = now; pendingTarget = false; sentView = viewKey(); sentIdx = idx;
    worker.postMessage({ type: MSG.INSPECT, reqId: ++reqId, idx });
  }
  // → true when the pinned cell is gone (and the pin has been released)
  function checkPin(d) {
    if (state.pinned === null || state.pinned !== pinIdx) return false;
    const view = viewKey();
    if (d && (pinBorn === null || d.bornTick === pinBorn)) {
      pinBorn = d.bornTick; pinSeenTick = d.tick; pinSeenView = view;
      return false;
    }
    const tick = d ? d.tick : state.viewing ? state.viewing.tick : clock.tick;
    const text = pinBorn !== null && pinSeenView === view
      ? `The pinned cell died · last seen at T ${fmtInt(pinSeenTick)}`
      : `The pinned cell is not alive at T ${fmtInt(tick)}`;
    queueMicrotask(() => { if (state.pinned === pinIdx) { dispatch({ type: 'pin', idx: null }); hud?.setHint(text); } });
    return true;
  }
  function show() {
    const idx = target();
    if (idx === null || !detail || detail.idx !== idx) { if (shownIdx !== null) { shownIdx = null; hud?.setInspector(null, null); } return; }
    shownIdx = idx;
    anchor = stage ? stage.projectCell(idx) : null;
    hud?.setInspector(detail, anchor);
  }
  return {
    targetChanged() {
      if (state.pinned !== pinIdx) { pinIdx = state.pinned; pinBorn = null; pinSeenView = null; }   // a new pin
      const idx = target();
      if (idx === null) { detail = null; show(); return; }
      if (detail && detail.idx !== idx) detail = null;
      pendingTarget = true;
      const now = performance.now();
      if (now - lastSent >= INSPECT_MS) request(now);
      if (!detail) show();
    },
    onResult(m) {
      if (m.reqId !== reqId) return;       // an older request
      // asked before a view switch or a target change: ask again
      if (sentView !== viewKey() || sentIdx !== target()) { pendingTarget = true; return; }
      detail = m.detail;
      if (checkPin(detail)) detail = null;
      if (detail === null && target() !== null) { if (shownIdx !== null) { shownIdx = null; hud?.setInspector(null, null); } return; }
      show();
    },
    tick(now) {
      if (target() === null) return;
      if (pendingTarget && now - lastSent >= INSPECT_MS) request(now);
      else if (now - lastRefresh >= PIN_REFRESH_MS) request(now);
    },
    follow() {
      if (shownIdx === null || !detail || !stage) return;
      const a = stage.projectCell(shownIdx);
      if (!anchor || Math.abs(a.x - anchor.x) > 0.5 || Math.abs(a.y - anchor.y) > 0.5 || a.visible !== anchor.visible) {
        anchor = a;
        // only the anchor moved (orbit, turntable): move the plate, do not rebuild its contents
        if (hud?.moveInspector) hud.moveInspector(anchor); else hud?.setInspector(detail, anchor);
      }
    },
  };
})();

function bindPointer() {
  let down = null, lastPick = -1e9, trailing = 0, lastXY = null;
  const pickAt = (x, y) => { if (sceneDead || glLost) return null; const idx = stage.pick(x, y); return idx === undefined ? null : idx; };
  const doHover = () => {
    trailing = 0;
    if (!lastXY) return;
    lastPick = performance.now();
    const idx = pickAt(lastXY.x, lastXY.y);
    if (idx !== state.hover) dispatch({ type: 'hover', idx });
  };
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || e.buttons) return;    // no hover on touch or while orbiting
    lastXY = { x: e.clientX, y: e.clientY };
    const now = performance.now();
    if (now - lastPick >= PICK_MS) doHover();
    else if (!trailing) trailing = setTimeout(doHover, PICK_MS - (now - lastPick));
  });
  canvas.addEventListener('pointerleave', () => { lastXY = null; if (state.hover !== null) dispatch({ type: 'hover', idx: null }); });
  canvas.addEventListener('pointerdown', (e) => { if (e.isPrimary) down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || !e.isPrimary) return;
    const d = down; down = null;
    if (performance.now() - d.t > TAP_MS || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_PX) return;
    const idx = pickAt(e.clientX, e.clientY);
    dispatch({ type: 'pin', idx: idx !== null && idx === state.pinned ? null : idx });   // tap again to unpin
  });
  canvas.addEventListener('pointercancel', () => { down = null; });
}

// ─── adaptive quality (mode auto) ───────────────────────────────────────────────────────────────────────
// Windows of 2 s of continuous rendering: p90 and median of the rAF intervals, and the median main-thread time our
// own frame took (measured around frame(): stage JS, HUD writes, forced layouts). Only intervals between two rendered
// frames count; a window starts over when rendering resumes after an idle stretch, and nothing is sampled for
// GRACE_MS after a scene rebuild (boot, fast-forward done, run, reset, new seed, snapshot/live/resume, tier or DPR
// change, tab shown again), when first-use GL work and full-state uploads make the frames slow for a moment.
// Slow (p90 > 20 ms in two consecutive windows):
//   • when our own frame work is ≥ 60% of the interval the main thread is the bottleneck, and fewer pixels would only
//     cost image quality: the tier drops instead (Low sheds CPU work: no shadow pass, no motes, fields at 8 Hz);
//   • otherwise the DPR steps down by 0.25, never below the auto floor (0.75; 1 on a DPR-1 screen; 0.5 only by
//     choosing Low). The next window checks the step helped (p90 at least 10% lower); if not, the tier drops;
//   • at the floor, the tier drops.
// Recovery is relative to the display: its refresh interval is the fastest steady window median seen (a display is
// assumed to run at 60 Hz or faster). After 10 s of windows at p90 ≤ 1.15 × refresh and 10 s since the last change,
// the DPR steps back up toward the tier's cap, then a demoted tier returns (up to the device's default tier). A DPR
// or tier that had to be left twice is not returned to.
// Beyond the default tier (Medium → High) needs headroom a vsync-bound 60 Hz display cannot show: p90 < 10 ms after a
// 3 s warm-up, or < 11 ms for 10 s. High is automatic on fast (≥ 90 Hz) displays only, and a choice (Q) elsewhere.
const GRACE_MS = 1000, SLOW_WINDOWS = 2, WIN_MS = 2000, GOOD_MS = 10000;
const AUTO_DPR_FLOOR = (devicePixelRatio || 1) <= 1 ? Math.min(1, devicePixelRatio || 1) : 0.75;
let lastWorkMs = 0;
const quality = (() => {
  const iv = new Float32Array(512), wk = new Float32Array(512), tmp = new Float32Array(512);
  let n = 0, winStart = 0, firstT = 0, lastChange = 0, goodSince = 0, warmDone = false;
  let graceUntil = 0, slowRun = 0, refreshMs = 1000 / 60, probe = null, dprIneffective = false;
  const demotedFrom = { high: 0, medium: 0, low: 0 };
  const dprLeft = new Map();                                   // DPR value → times auto stepped down from it
  const quant = (arr, f) => { tmp.set(arr.subarray(0, n)); const s = tmp.subarray(0, n).sort(); return s[Math.min(n - 1, Math.floor(f * n))]; };
  const floorFor = (tier) => Math.max(TIERS[tier].dprMin, AUTO_DPR_FLOOR);
  const capFor = (tier) => Math.min(devicePixelRatio || 1, TIERS[tier].dprCap);
  function restart(now) { n = 0; winStart = now; }
  function grace(now) { graceUntil = Math.max(graceUntil, now + GRACE_MS); slowRun = 0; restart(now); }
  function setTier(tier, now) {
    lastChange = now; goodSince = 0; slowRun = 0; probe = null;
    commit({ ...state, quality: { ...state.quality, tier } });   // → syncStage → onTierApplied → grace
    grace(now);
  }
  // null = back to the tier's cap. → true when the DPR actually changed
  function setDpr(tier, dpr, now) {
    const before = stage.getQuality().dpr;
    stage.setQuality({ tier, dpr });                              // the stage accepts { tier, dpr } to override its cap
    const got = stage.getQuality().dpr;
    api.dprOverridden = dpr !== null;
    lastChange = now; goodSince = 0; slowRun = 0;
    grace(now);
    state = { ...state, quality: { ...state.quality, dpr: got } };
    hud?.render(state);
    return Math.abs(got - before) > 1e-6;
  }
  const api = {
    dprOverridden: false,
    onTierApplied() { grace(performance.now()); },
    resetWindow(now) { restart(now); },
    grace,
    /** QA: the sampler's view of the display and its last decision inputs. */
    debug() { return { refreshMs, dprIneffective, probe, demotedFrom: { ...demotedFrom }, floor: AUTO_DPR_FLOOR }; },
    sample(ms, workMs, now) {
      if (state.quality.mode !== 'auto' || !stage) return;
      if (!firstT) { firstT = now; lastChange = now; grace(now); return; }   // boot is the first rebuild
      if (now < graceUntil) { restart(now); return; }
      if (ms > 0 && ms < 1000 && n < iv.length) { iv[n] = ms; wk[n] = workMs; n++; }
      if (now - winStart < WIN_MS || n < 20) return;
      const p = quant(iv, 0.9), med = quant(iv, 0.5), work = quant(wk, 0.5);
      n = 0; winStart = now;
      if (p <= 1.25 * med) refreshMs = Math.max(4, Math.min(refreshMs, med));   // a steady window: the display's pace
      const tier = state.quality.tier, ti = TIER_ORDER.indexOf(tier);
      const dpr = stage.getQuality().dpr;
      if (probe) {
        // the window after a DPR step: still slow and not clearly faster → the pixels were not the bottleneck
        const pr = probe; probe = null;
        if (p > 20 && p > 0.9 * pr.p) {
          dprIneffective = true;
          if (ti > 0) { demotedFrom[tier]++; setTier(TIER_ORDER[ti - 1], now); }   // the new tier starts at its cap
          else setDpr(tier, pr.dpr >= capFor(tier) - 1e-6 ? null : pr.dpr, now);   // Low: undo the useless step
          return;
        }
      }
      if (p > 20) {
        goodSince = 0;
        if (++slowRun < SLOW_WINDOWS) return;              // one slow window can be a burst; two are a trend
        slowRun = 0;
        const cpuBound = work >= 0.6 * med;
        if (!cpuBound && !dprIneffective && dpr - 0.25 >= floorFor(tier) - 1e-6) {
          dprLeft.set(dpr, (dprLeft.get(dpr) || 0) + 1);
          if (setDpr(tier, dpr - 0.25, now)) { probe = { dpr, p }; return; }
        }
        if (ti > 0) { demotedFrom[tier]++; setTier(TIER_ORDER[ti - 1], now); }
        return;
      }
      slowRun = 0;
      if (!warmDone && now - firstT >= 3000) {
        warmDone = true;
        if (tier === 'medium' && AUTO_TIER === 'medium' && p < 10 && demotedFrom.high < 2) { setTier('high', now); return; }
      }
      if (p > 1.15 * refreshMs) { goodSince = 0; return; }
      if (!goodSince) goodSince = now;
      if (now - goodSince < GOOD_MS || now - lastChange < GOOD_MS) return;
      const cap = capFor(tier);
      if (dpr < cap - 1e-6) {                              // first the pixels come back
        const next = Math.min(cap, dpr + 0.25);
        if ((dprLeft.get(next) || 0) < 2) { dprIneffective = false; setDpr(tier, next >= cap - 1e-6 ? null : next, now); return; }
      }
      const up = TIER_ORDER[ti + 1];
      if (!up || demotedFrom[up] >= 2) return;
      // a demoted tier comes back up to the device's default; beyond it only with real headroom (fast displays)
      if (ti + 1 <= TIER_ORDER.indexOf(AUTO_TIER) || p < 11) { dprIneffective = false; setTier(up, now); }
    },
  };
  return api;
})();

// ─── share, reduced motion, visibility, resize ──────────────────────────────────────────────────────────
async function share() {
  // During a fast-forward no frames arrive, so clock.tick is still the tick the jump started from: share its target.
  const t = state.viewing ? state.viewing.tick : (state.progress?.target ?? pendingFF ?? clock.tick);
  const q = new URLSearchParams({ seed: String(state.seed), t: String(t) });
  if (params.engine && params.engine !== 'v1') q.set('engine', params.engine);
  const url = `${location.origin}${location.pathname}?${q}`;
  try {
    await navigator.clipboard.writeText(url);
    hud?.setHint(`Link copied · seed ${state.seed} · T ${fmtInt(t)}`);
  } catch {
    hud?.setHint(`Share this link: ${url}`, 12000);
  }
}

function bindEnvironment() {
  rmQuery.addEventListener('change', (e) => { if (rmOverride === null) commit({ ...state, reducedMotion: e.matches }); });
  const onResize = () => { stage.resize(); pushLayout(performance.now(), true); sceneDirty = true; };
  new ResizeObserver(onResize).observe(canvas);
  const watchDpr = () => {
    const mq = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    mq.addEventListener('change', () => { onResize(); watchDpr(); }, { once: true });
  };
  watchDpr();
}

// Frames that arrive before the stage exists are acked at once; private copies of the latest are replayed.
function copyFrame(f) {
  return { ...f, cell: f.cell.slice(), life: f.life.slice(), idx: f.idx.slice(), events: f.events.slice(), morph: f.morph ? f.morph.slice() : null };
}

// Debug handle for QA scripts (read-only use).
window.__ee = { getState, dispatch, perf, get stats() { return latestStats; }, get clock() { return { ...clock }; }, get stage() { return stage; }, get worker() { return worker; }, get quality() { return quality.debug(); } };

boot().catch((err) => { console.error(err); minimalFallback('The specimen could not start.'); });
