// src/shared.js — constants and contracts shared by the engine, worker, scene and UI.
// No DOM, no three. Everything here is a cross-module contract: change it only with a note to every module owner.

export const GRID = 200;
export const N = GRID * GRID;
export const DX = [1, -1, 0, 0]; // neighbour direction d: (x + DX[d], y + DY[d]), toroidal
export const DY = [0, 0, 1, -1];

export const TYPE = { EMPTY: 0, STEM: 1, ECTO: 2, MESO: 3, ENDO: 4, NEURAL: 5, MUSCLE: 6, VESSEL: 7 };
export const TYPE_NAMES = ['', 'Stem', 'Ectoderm', 'Mesoderm', 'Endoderm', 'Neural', 'Muscle', 'Vessel'];
export const TYPE_SHORT = ['', 'Stem', 'Ecto', 'Meso', 'Endo', 'Neural', 'Muscle', 'Vessel'];
// Tissue palette (sRGB). Worst-case pairwise ΔE under deutan/protan/tritan simulation = 17.0.
export const TISSUE_HEX = ['#000000', '#F2EEDF', '#4A94F0', '#F0604A', '#F2B544', '#8E5CFF', '#FF7AB8', '#34C28A'];

// Germ-layer families = the plates of the "Apart" (exploded) view, top (0) → bottom (3).
export const FAMILY_OF_TYPE = [-1, 3, 0, 1, 2, 0, 1, 1]; // stem→3, ecto/neural→0, meso/muscle/vessel→1, endo→2
// The Apart plates hold every cell of a family: the stem plate carries rim newborns as well as the core.
export const FAMILY_LABELS = ['Ectoderm + Neural', 'Mesoderm + Muscle + Vessel', 'Endoderm', 'Stem'];

// Rule 3 bands. band 0 = empty; 1..4 = the germ layer the rule assigns at a cell's current depth.
export const BAND = { NONE: 0, ECTO: 1, MESO: 2, ENDO: 3, STEM: 4 };
export const BAND_LABELS = ['', 'Outer band', 'Second band', 'Inner band', 'Core'];
export const RULE_FATE_OF_BAND = [0, TYPE.ECTO, TYPE.MESO, TYPE.ENDO, TYPE.STEM];

export const VIEWS = [
  { id: 'cells',     key: '1', label: 'Tissue',    group: 'view' },
  { id: 'depth',     key: '2', label: 'Depth',     group: 'view' },
  { id: 'energy',    key: '3', label: 'Energy',    group: 'view' },
  { id: 'age',       key: '4', label: 'Age',       group: 'view' },
  { id: 'midline',   key: '5', label: 'Midline',   group: 'signal', channel: 2 },
  { id: 'ap',        key: '6', label: 'A–P',       group: 'signal', channel: 3 },
  { id: 'activator', key: '7', label: 'Activator', group: 'signal', channel: 0 },
  { id: 'inhibitor', key: '8', label: 'Inhibitor', group: 'signal', channel: 1 },
];
export const VIEW_INDEX = Object.fromEntries(VIEWS.map((v, i) => [v.id, i]));
/** A known view id (own property only: `toString`, `__proto__` and friends are not views). */
export const isViewId = (id) => typeof id === 'string' && Object.hasOwn(VIEW_INDEX, id);
/** A view from a URL or an action: its id or its key ('1'..'8'); anything else → null. */
export const viewIdFrom = (v) => (isViewId(v) ? v : (VIEWS.find((x) => x.key === String(v))?.id ?? null));

export const SPEEDS = [7.5, 15, 30, 60, 120, 240, 480, 0]; // ticks per second; 0 = as fast as possible
export const DEFAULT_SPEED_INDEX = 3;                        // 60 t/s

export const CAMERA_PRESETS = ['specimen', 'close', 'map']; // specimen = hero 3/4 view; close = macro on the organism; map = top-down flat honest 2D
export const QUALITY_MODES = ['auto', 'high', 'medium', 'low'];

// Worker message types
export const MSG = {
  // main → worker
  INIT: 'init', RUN: 'run', PAUSE: 'pause', STEP: 'step', RESET: 'reset', SPEED: 'speed',
  ACK: 'ack', FIELDS: 'fields', INSPECT: 'inspect',
  VIEW_SNAPSHOT: 'viewSnapshot', LIVE: 'live', RESUME: 'resume', FAST_FORWARD: 'fastForward',
  // worker → main
  READY: 'ready', FRAME: 'frame', MILESTONE: 'milestone', SNAPSHOTS: 'snapshots',
  INSPECT_RESULT: 'inspectResult', PROGRESS: 'progress', ERROR: 'error',
};

// Event records: Int32Array, EV_WORDS words each: [kind | idx<<8, tick, a, b]
//   BIRTH: idx = daughter, a = parent idx, b = dir d (daughter = parent + (DX[d], DY[d]))
//   DEATH: idx = dead cell, a = deadType | recipientMask<<4 | cause<<8, b = round(recycledEnergy * 1000)
//   FATE:  idx = cell,      a = fromType | toType<<4 | min(depth,255)<<12, b = band (1..4)
export const EV = { BIRTH: 1, DEATH: 2, FATE: 3 };
export const EV_WORDS = 4;
export const MAX_EVENTS_PER_FRAME = 4096;
export const DEATH_CAUSE = ['age', 'isolated', 'tip', 'crowded'];

// Frame texture layouts (RGBA8, GRID×GRID, row-major idx = y*GRID + x)
//  cell: R type (0..7) | G band (0 empty, 1..4 = BAND) |
//        B depth (distance to the exterior; live 1..254; empty: 0 = exterior, 255 = interior gap) |
//        A round(255 * clamp(log2(1 + E) / E_LOG_SCALE, 0, 1))
//  life: R round(255 * clamp(age / maxAge, 0, 1)) | G evBits | B evAge (ticks since last event at frame.tick, ≤ 255) | A reserved (0)
//  evBits: bits0-1 kind (0 none, 1 birth, 2 death, 3 fate) · bits2-3 birth dir d · bits4-6 prevType
//          (type that died / type before the fate change) · bit7 readyToDivide
//  morph: Float32Array(4N) interleaved RGBA = [activator, inhibitor, midline, ap]
export const E_LOG_SCALE = 13;
export const encodeEnergy = (e) => Math.round(255 * Math.min(1, Math.max(0, Math.log2(1 + e) / E_LOG_SCALE)));
export const decodeEnergy = (a8) => Math.pow(2, (a8 / 255) * E_LOG_SCALE) - 1;

// Milestones: detected by the worker from real state, each fires once per run (snapshot + thumbnail).
// `when` documents the condition; the worker implements it.
export const MILESTONES = [
  { key: 'seed',       label: 'Seed',          awaiting: '',                                          when: 'T0' },
  { key: 'firstFates', label: 'First fates',   awaiting: 'when the first stem cells read their depth', when: 'any non-stem cell' },
  { key: 'muscle',     label: 'Muscle',        awaiting: 'when ten mesoderm cells have turned to muscle', when: 'muscle ≥ 10' },
  { key: 'layers',     label: 'Four layers',   awaiting: 'when all four germ bands are populated',      when: 'cells ≥ 200, ecto ≥ 5%, meso-family ≥ 5%, endo ≥ 5%, stem ≥ 1%' },
  { key: 'neural',     label: 'Neural plate',  awaiting: 'where the midline and A–P signals meet',      when: 'neural ≥ 10' },
  { key: 'endoCore',   label: 'Gut core',      awaiting: 'when endoderm outnumbers ectoderm',           when: 'cells ≥ 500 and endo > ecto' },
  { key: 'turnover',   label: 'Turnover',      awaiting: 'when births and deaths come within 15%',      when: 'tick > 1000 and |births − deaths| < 0.15·births over the last 500 ticks' },
  { key: 'founders',   label: 'Founders gone', awaiting: 'when every original cell has died',           when: 'foundersAlive === 0' },
];
