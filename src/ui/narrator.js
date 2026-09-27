// src/ui/narrator.js — the specimen log's sentences (ADDENDUM §D, SPEC §5.4).
//
// Pure functions of (stats, state, ctx). Every number in a sentence is read through a key path:
//   'win.reSpecified'           → stats.win.reSpecified
//   'params.gates.neuralMid'    → ctx.params (engine PARAMS)
//   'ms.firstFates.typeCounts.2'→ ctx.milestoneStats (falls back to stats.milestoneStats)
//   'state.viewing.tick'        → AppState
//   'd.ectoPct'                 → DERIVED below (pure functions that themselves read through key paths)
//   'k.ageOldPct'               → CONST below (definitions from the Stats contract)
// A missing key throws NarratorKeyError and a non-finite number throws too, so the test catches a sentence
// that would read "undefined" or "NaN". Text parts carry no digits; every number is a 'num' part.
//
// Part = { k: 'text'|'num'|'tissue'|'rule', v: string, type?: TYPE }

import { TYPE, TYPE_NAMES, MILESTONES } from '../shared.js';
import { fmtInt, fmtPct, fmtE, fmtSig, fmtX, fmtTick } from './format.js';

const { STEM, ECTO, MESO, ENDO, NEURAL, MUSCLE, VESSEL } = TYPE;

export class NarratorKeyError extends Error {
  constructor(path, why = 'missing') { super(`narrator: ${why} key "${path}"`); this.path = path; }
}

const FMT = {
  int: fmtInt, pct: fmtPct, e1: fmtE, sig: fmtSig, x: fmtX, tick: fmtTick,
  pct3: (v) => v.toFixed(3) + '%',
};

/** Constants that are definitions in the Stats contract (ADDENDUM §B.2), not tunable parameters. */
export const CONST = { ageOldPct: 85, depthOuter: 1, turnoverPct: 15 };

/** Rules are cited by name as well as number, so a newcomer never has to look a number up. */
export const RULE_NAME = { 1: 'Rule 1 · divide', 2: 'Rule 2 · die', 3: 'Rule 3 · depth → fate' };

const pct = (a, b) => (b > 0 ? (100 * a) / b : 0);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

/** Derived placeholders: the only non-Stats names a template may use. `g` is the strict getter. */
export const DERIVED = {
  perCell: (g) => g('energy.initial') / g('seedCount'),
  energyPct: (g) => pct(g('energy.total'), g('energy.initial')),
  stemPct: (g) => pct(g('typeCounts.1'), g('cellCount')),
  ectoPct: (g) => pct(g('typeCounts.2'), g('cellCount')),
  endoPct: (g) => pct(g('typeCounts.4'), g('cellCount')),
  famPct: (g, fam) => pct(g(`plates.fate.${fam}`), g('cellCount')),
  isoCount: (g) => g(`typeCounts.${g('state.isolate')}`),
  isoPct: (g) => pct(g(`typeCounts.${g('state.isolate')}`), g('cellCount')),
  net: (g) => g('win.births') - g('win.deaths'),
  // mesoderm committing to muscle or vessel in the window (the only fates that lead to those two types)
  spec: (g) => g('win.fatesTo.6') + g('win.fatesTo.7'),
  inhSpeed: (g) => g('params.diffusion.rates.1') / g('params.diffusion.rates.0'),
  // Rule 3 band edges in depth steps (geom.bands: outer 1…e1, second e1+1…e2, inner e2+1…e3−1, core ≥ e3)
  band2From: (g) => g('geom.bands.e1') + 1,
  band3From: (g) => g('geom.bands.e2') + 1,
  band3To: (g) => g('geom.bands.e3') - 1,
  // share of a type in a milestone's captured typeCounts
  msPct: (g, key, type) => {
    const counts = [0, 1, 2, 3, 4, 5, 6, 7].map((t) => g(`ms.${key}.typeCounts.${t}`));
    return pct(counts[+type], sum(counts));
  },
  msCells: (g, key) => sum([1, 2, 3, 4, 5, 6, 7].map((t) => g(`ms.${key}.typeCounts.${t}`))),
  // share of a germ-layer family (FAMILY_OF_TYPE: 0 ecto+neural, 1 meso+muscle+vessel, 2 endo, 3 stem) at a milestone
  msFamPct: (g, key, fam) => {
    const counts = [1, 2, 3, 4, 5, 6, 7].map((t) => g(`ms.${key}.typeCounts.${t}`));
    const [stem, ecto, meso, endo, neural, muscle, vessel] = counts;
    const byFam = [ecto + neural, meso + muscle + vessel, endo, stem];
    return pct(byFam[+fam], sum(counts));
  },
};

function makeGetter(stats, state, ctx) {
  const roots = {
    params: ctx?.params ?? state?.params,
    ms: ctx?.milestoneStats ?? stats?.milestoneStats,
    state,
    k: CONST,
  };
  const g = (path) => {
    const segs = path.split('.');
    const head = segs[0];
    if (head === 'd') {
      const fn = DERIVED[segs[1]];
      if (!fn) throw new NarratorKeyError(path, 'unknown derived');
      return fn(g, ...segs.slice(2));
    }
    let obj = head in roots ? roots[head] : stats;
    const rest = head in roots ? segs.slice(1) : segs;
    for (const s of rest) {
      if (obj === null || obj === undefined || typeof obj !== 'object' || !(s in obj)) throw new NarratorKeyError(path);
      obj = obj[s];
    }
    if (obj === undefined || obj === null) throw new NarratorKeyError(path);
    return obj;
  };
  return g;
}

function makeBuilder(stats, state, ctx) {
  const g = makeGetter(stats, state, ctx);
  const n = (path, fmt = 'int') => {
    const v = g(path);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new NarratorKeyError(path, 'non-finite');
    return { k: 'num', v: FMT[fmt](v) };
  };
  const t = (type, word) => ({ k: 'tissue', v: word ?? TYPE_NAMES[type].toLowerCase(), type });
  const r = (v) => ({ k: 'rule', v });
  const rule = (i) => r(RULE_NAME[i]);
  // a depth range "12–14" (or "12" when it is a single step), both ends read through key paths
  const range = (a, b) => {
    const lo = g(a), hi = g(b);
    if (![lo, hi].every((v) => typeof v === 'number' && Number.isFinite(v))) throw new NarratorKeyError(`${a}…${b}`, 'non-finite');
    return { k: 'num', v: hi > lo ? `${fmtInt(lo)}–${fmtInt(hi)}` : fmtInt(lo) };
  };
  return { g, n, t, r, rule, range };
}

// Milestone windows: ticks since a milestone fired (Infinity if it has not).
function since(stats, ctx, key) {
  const ms = ctx?.milestoneStats ?? stats.milestoneStats;
  const m = ms && ms[key];
  return m && typeof m.tick === 'number' ? stats.tick - m.tick : Infinity;
}
const within = (s, c, key, span) => { const d = since(s, c, key); return d >= 0 && d <= span; };
const tc = (s, type) => s.typeCounts[type];
const lostPhrase = ($) => ($.g('energy.lost') > 0 ? [$.n('energy.lost', 'e1'), ' lost'] : ['none lost']);
// Deaths of cells left with no neighbour are rare (usually none in a window): only mention them when there were some.
const tipsPhrase = ($) => ($.g('win.deathsByCause.1') > 0
  ? [', ', $.n('win.deathsByCause.2'), ' were exposed tips with only one neighbour, and ', $.n('win.deathsByCause.1'), ' were cells left with no neighbour']
  : [' and ', $.n('win.deathsByCause.2'), ' were exposed tips with only one neighbour']);

// `at` (optional): the tick a sentence describes when that is not the tick it was rendered at (it stamps the log).
const T = (id, group, when, render, at = null) => ({ id, group, when, render, at });

// ─── context templates: they describe what the viewer chose and outrank the story ──────────────────────
const CONTEXT = [
  T('viewing', 'context', (s, st) => !!st?.viewing, ($, s, st) => {
    const key = st.viewing.key;
    const label = key ? (MILESTONES.find((m) => m.key === key)?.label ?? key) : null;
    return ['Viewing ', $.n('state.viewing.tick', 'tick'),
      label ? `, captured at “${label}”.` : ', a periodic snapshot.',
      ' Back to live returns to the present; Resume here carries on from this moment, and the same seed replays the same future.'];
  }),
  T('apart', 'context', (s, st) => !!st?.exploded, ($) => [
    'One plate per germ-layer family, top to bottom: ', $.n('plates.fate.0'), ' ', $.t(ECTO), ' and ', $.t(NEURAL), ', ',
    $.n('plates.fate.1'), ' ', $.t(MESO), ', ', $.t(MUSCLE), ' and ', $.t(VESSEL), ', ', $.n('plates.fate.2'), ' ', $.t(ENDO), ', ',
    $.n('plates.fate.3'), ' ', $.t(STEM), '. Put back together they nest as shells, skin to core.',
  ]),
  T('isolate', 'context', (s, st) => st?.view === 'cells' && st?.isolate >= 1 && st?.isolate <= 7, ($, s, st) => [
    $.t(st.isolate, TYPE_NAMES[st.isolate]), ' only: ', $.n('d.isoCount'), ' cells, ', $.n('d.isoPct', 'pct'),
    '% of the embryo. The rest are dimmed; choose the row again to clear.',
  ]),
  T('vDepth', 'context', (s, st) => st?.view === 'depth', ($) => [
    'Colour is the band each cell’s depth falls in now (', $.rule(3), '). The deepest cell is ', $.n('geom.dmax'),
    ' steps in: the outer band is depths ', $.range('k.depthOuter', 'geom.bands.e1'), ', the second ', $.range('d.band2From', 'geom.bands.e2'),
    ', the inner ', $.range('d.band3From', 'd.band3To'), ', and ', $.n('geom.bands.e3'), ' and deeper is core. ',
    $.n('bands.matchPct', 'pct'), '% of cells carry their band’s fate; the rest are newborns, cells waiting out hysteresis, or terminal tissues outside their band.',
  ]),
  T('vEnergy', 'context', (s, st) => st?.view === 'energy', ($) => [
    $.n('energy.ready'), ' cells hold enough energy to divide (', $.n('energy.readyStem'), ' ', $.t(STEM), ' above ', $.n('energy.thrStem'),
    ', ', $.n('energy.readyDiff'), ' others above ', $.n('energy.thrDiff'),
    '), but only ', $.n('energy.readyRoom'), ' have an empty neighbouring place to divide into (', $.rule(1),
    '); gold marks them, and the boxed-in rest wait. The mean is ', $.n('energy.mean', 'e1'),
    '; white on the ramp marks the threshold. The total never changes: ', $.n('energy.total', 'e1'), '.',
  ]),
  T('vAge', 'context', (s, st) => st?.view === 'age', ($) => [
    'Colour is the share of its lifespan each cell has used. ', $.n('age.old'), ' cells are past ', $.n('k.ageOldPct'),
    '% and will die soon unless they divide first, passing their energy to the nearest living cells (', $.rule(2),
    '). Division resets the clock, and so does a stem cell taking a fate or mesoderm committing to muscle or vessel; moving between germ layers does not.',
  ]),
  T('vMidline', 'context', (s, st) => st?.view === 'midline', ($) => [
    'The midline signal is strongest along the body’s axis, near x = ', $.n('geom.cx'), ', peaking at ', $.n('signals.maxMid', 'sig'),
    '. Outer-band cells where it passes ', $.n('params.gates.neuralMid', 'sig'), ' and A–P passes ', $.n('params.gates.neuralAP', 'sig'),
    ' become ', $.t(NEURAL), ': ', $.n('signals.neuralCompetent'), ' qualify now.',
  ]),
  T('vAP', 'context', (s, st) => st?.view === 'ap', ($) => [
    'The anterior–posterior (head–tail) signal is laid down rising toward one side of the dish, the anterior, and peaks at ',
    $.n('signals.maxAP', 'sig'), '. With the midline it gates the ', $.t(NEURAL, 'neural plate'), ': ', $.n('signals.neuralCompetent'),
    ' outer cells pass both, so, as laid down, ', $.n('geom.neural.anteriorPct', 'pct'), '% of the ', $.n('geom.neural.count'), ' neural cells lie anterior.',
  ]),
  T('vAct', 'context', (s, st) => st?.view === 'activator', ($) => [
    'The activator amplifies itself and makes its own inhibitor. Mesoderm settled for ', $.n('params.gates.mesoSpecializeAge'),
    ' ticks becomes ', $.t(MUSCLE), ' where its activator runs above ', $.n('params.gates.muscleRel', 'x'),
    '× the mean at its own depth, and ', $.t(VESSEL), ' below ', $.n('params.gates.vesselRel', 'x'), '×. Tissue-wide mean now ',
    $.n('signals.meanAct', 'sig'), '; highest in mesoderm ', $.n('signals.maxMesoAct', 'sig'), '.',
  ]),
  T('vInh', 'context', (s, st) => st?.view === 'inhibitor', ($) => [
    'The inhibitor is made where the activator is high and spreads ', $.n('d.inhSpeed', 'x'),
    '× faster, so each spot suppresses its surroundings. That spacing splits the mesoderm into ', $.n('typeCounts.6'), ' ', $.t(MUSCLE),
    ' and ', $.n('typeCounts.7'), ' ', $.t(VESSEL), ' cells. Peak now: ', $.n('signals.maxInh', 'sig'), '.',
  ]),
];

// ─── story templates (Tissue view), highest priority first ─────────────────────────────────────────────
const STORY = [
  // The intro is always shown for the first hold (3 s), so it carries Rule 1: the cleavage chapter (T1–T13) is
  // usually over before the hold ends.
  T('intro', 'story', (s) => s.tick === 0, ($, s, st) => [
    $.n('seedCount'), ' identical ', $.t(STEM), ' cells share ', $.n('energy.initial'), ' units of energy, ',
    $.n('d.perCell', 'e1'), ' each. One conservation law and three rules; two guiding signals centred on the embryo mark its midline and front. The first rule, ',
    $.rule(1), ': a cell holding more than ', $.n('energy.thrStem'), ' splits into an empty neighbouring spot, and each half keeps half.',
    st?.running ? '' : ' Press play to begin.',
  ], () => 0),
  // T1–13: every founder is still too young to divide (or to read its depth); the first birth comes later
  T('cleavage', 'story', (s) => s.tick > 0 && tc(s, STEM) === s.cellCount, ($) => [
    'The founders are too young to act yet: a cell divides only once it is older than ', $.n('params.divCooldown'), ' ticks (', $.rule(1),
    '), and reads its depth once older than ', $.n('params.diffAge'), ' (', $.rule(3), '). ', $.n('cellCount'),
    ' cells, and the total is still ', $.n('energy.total', 'e1'), '.',
  ]),
  T('firstFates', 'story', (s, st, c) => within(s, c, 'firstFates', 150), ($) => [
    'At ', $.n('ms.firstFates.tick', 'tick'), ' the first cells came of age and read their depth: ', $.n('ms.firstFates.typeCounts.2'), ' became ',
    $.t(ECTO), ' at the rim, ', $.n('ms.firstFates.typeCounts.3'), ' ', $.t(MESO), ' and ', $.n('ms.firstFates.typeCounts.4'), ' ', $.t(ENDO),
    ' beneath. Once older than ', $.n('params.diffAge'), ' ticks, every cell becomes what its depth below the surface demands (', $.rule(3), ').',
  ], (s, c) => (c?.milestoneStats ?? s.milestoneStats)?.firstFates?.tick ?? null),
  T('layers', 'story', (s, st, c) => within(s, c, 'layers', 300), ($) => [
    'Four concentric layers, skin to core: ', $.n('d.famPct.0', 'pct'), '% ', $.t(ECTO), ', ',
    $.n('d.famPct.1', 'pct'), '% ', $.t(MESO), ' and its tissues, ', $.n('d.famPct.2', 'pct'), '% ', $.t(ENDO), ', ',
    $.n('d.famPct.3', 'pct'), '% ', $.t(STEM), ' (', $.n('bands.stemCore'), ' of them in the core band). Each is a band of depth scaled to the deepest cell’s, now ',
    $.n('geom.dmax'), ' steps in.',
  ]),
  T('muscle', 'story', (s, st, c) => within(s, c, 'muscle', 400), ($) => [
    'In the mesoderm band an activator–inhibitor pattern starts to break the ring into blocks: where the activator runs above ',
    $.n('params.gates.muscleRel', 'x'), '× the mean at that depth, mesoderm becomes ', $.t(MUSCLE), ' (', $.n('typeCounts.6'),
    '); below ', $.n('params.gates.vesselRel', 'x'), '×, ', $.t(VESSEL), ' (', $.n('typeCounts.7'), ').',
  ]),
  T('neural', 'story', (s, st, c) => within(s, c, 'neural', 400), ($) => [
    'Where the midline signal passes ', $.n('params.gates.neuralMid', 'sig'), ' and the A–P signal passes ',
    $.n('params.gates.neuralAP', 'sig'), ', outer-band cells become ', $.t(NEURAL), ' instead of ', $.t(ECTO), ': ',
    $.n('geom.neural.count'), ' so far, ', $.n('geom.neural.anteriorPct', 'pct'), '% of them on the anterior side, where the A–P signal is laid down.',
  ]),
  T('gutCore', 'story', (s, st, c) => within(s, c, 'endoCore', 400) && tc(s, ENDO) > tc(s, ECTO), ($) => [
    $.t(ENDO, 'Endoderm'), ' (', $.n('d.endoPct', 'pct'), '%) now outnumbers ', $.t(ECTO), ' (', $.n('d.ectoPct', 'pct'),
    '%). The inner band runs from ', $.n('geom.bands.e2'), ' to ', $.n('geom.bands.e3'), ' cells deep and holds ',
    $.n('bands.counts.3'), ' cells; the outer band holds ', $.n('bands.counts.1'), '.',
  ]),
  T('founders', 'story', (s, st, c) => within(s, c, 'founders', 300) && s.foundersAlive === 0, ($) => [
    'The last of the ', $.n('seedCount'), ' founders has died. Every living cell was born here, and all of the energy they started with is still here: ',
    $.n('energy.total', 'e1'), '.',
  ]),
  T('balance', 'story', (s, st, c) => within(s, c, 'turnover', 300), ($, s) => [
    'Births and deaths are now within ', $.n('k.turnoverPct'), '% of each other: ', $.n('win.births'), ' and ', $.n('win.deaths'), ' in the last ',
    $.n('win.W'), ' ticks, a net ', $.n('d.net'), ' cells. Most births now replace a death',
    s.win.births > s.win.deaths ? ', and the embryo is still growing.' : '.',
  ]),
];

// ─── steady templates: when no story chapter applies, rotate through these by tick (a pure choice) ─────
const STEADY = [
  // Three kinds of fate change, counted apart by the worker: a specified cell crossing into another germ-layer family
  // (win.reSpecified), mesoderm committing to muscle or vessel (fatesTo 6 + 7), and young stem cells taking their
  // band's first fate (win.stemFates). Late in a run the crossings are a few percent of all fates.
  T('respec', 'steady', (s) => s.win.reSpecified > 0 && s.cellCount >= 100, ($, s) => [
    'In the last ', $.n('win.W'), ' ticks, ', $.n('win.reSpecified'), ' specified cells crossed into another band and took its fate (', $.rule(3), ')',
    ...(s.win.fatesTo[6] + s.win.fatesTo[7] > 0 ? [', ', $.n('d.spec'), ' ', $.t(MESO), ' cells became ', $.t(MUSCLE), ' or ', $.t(VESSEL)] : []),
    ...(s.win.stemFates > 0 ? [', and ', $.n('win.stemFates'), ' young ', $.t(STEM), ' cells took their band’s fate'] : []), '.',
  ]),
  T('turnover', 'steady', (s) => s.win.deaths > 0 && s.totals.deaths >= s.seedCount, ($) => [
    'In the last ', $.n('win.W'), ' ticks, ', $.n('win.births'), ' cells were born and ', $.n('win.deaths'),
    ' died. Every death hands its energy to the nearest living cells (', $.rule(2), '): ',
    $.n('win.recycled', 'e1'), ' units passed on, ', ...lostPhrase($), '.',
  ]),
  // once the average cell is below the division threshold this stays true for good, so it rotates with the rest
  T('energyLimited', 'steady', (s) => s.cellCount > s.seedCount && s.energy.mean < s.energy.thrDiff, ($) => [
    'The pot is spread thin: the average cell holds ', $.n('energy.mean', 'e1'), ', below the ', $.n('energy.thrDiff'),
    ' a cell other than stem needs to divide (', $.rule(1), '). Of the ', $.n('energy.ready'), ' cells still above their threshold, ',
    $.n('energy.readyStem'), ' are ', $.t(STEM), '; only ', $.n('energy.readyRoom'), ' have room to divide.',
  ]),
  T('causes', 'steady', (s) => s.win.deaths >= 5, ($) => [
    'Of ', $.n('win.deaths'), ' deaths in the last ', $.n('win.W'), ' ticks, ', $.n('win.deathsByCause.0'), ' were from old age',
    ...tipsPhrase($), ' (', $.rule(2), ').',
  ]),
  T('neuralState', 'steady', (s) => tc(s, NEURAL) >= 10, ($) => [
    'The ', $.t(NEURAL, 'neural plate'), ' holds ', $.n('geom.neural.count'), ' cells, ',
    $.n('geom.neural.anteriorPct', 'pct'), '% of them anterior, where the midline and A–P signals overlap at the surface.',
  ]),
  T('muscleState', 'steady', (s) => tc(s, MUSCLE) >= 10, ($) => [
    'The mesoderm band holds ', $.n('typeCounts.6'), ' ', $.t(MUSCLE), ' and ', $.n('typeCounts.7'), ' ', $.t(VESSEL),
    ' cells: mesoderm whose activator is above ', $.n('params.gates.muscleRel', 'x'), '× the average at its depth becomes muscle; below ',
    $.n('params.gates.vesselRel', 'x'), '×, vessel.',
  ]),
  T('layersState', 'steady', (s) => s.cellCount >= 200, ($) => [
    'Skin to core: ', $.n('d.famPct.0', 'pct'), '% ', $.t(ECTO), ' and ', $.t(NEURAL), ', ', $.n('d.famPct.1', 'pct'), '% ',
    $.t(MESO), ' family, ', $.n('d.famPct.2', 'pct'), '% ', $.t(ENDO), ', ', $.n('d.famPct.3', 'pct'), '% ', $.t(STEM),
    ' (', $.n('bands.stemCore'), ' of them in the core band), each band a fixed fraction of the deepest cell’s depth, ', $.n('geom.dmax'), ' steps.',
  ]),
  T('growth', 'steady', () => true, ($) => [
    'A cell can only divide into an empty neighbouring spot: ', $.n('win.rimBirthPct', 'pct'), '% of births in the last ', $.n('win.W'),
    ' ticks were at the outer rim; the rest filled gaps left inside by deaths. ', $.n('cellCount'), ' cells now.',
  ]),
];

const STEADY_PERIOD = 400; // ticks per steady sentence (≈ 6.7 s at 60 t/s; the 3 s hold caps faster speeds)

export const TEMPLATES = [...CONTEXT, ...STORY, ...STEADY].map((t, i) => ({ ...t, priority: i }));
const BY_ID = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));

function safeWhen(t, stats, state, ctx) {
  try { return !!t.when(stats, state, ctx); } catch { return false; }
}

/** Render one template to parts (throws NarratorKeyError on a missing key). */
export function renderTemplate(id, stats, state = {}, ctx = {}) {
  const t = BY_ID[id];
  if (!t) throw new Error(`narrator: unknown template ${id}`);
  const $ = makeBuilder(stats, state, ctx);
  return normalise(t.render($, stats, state, ctx));
}

function normalise(items) {
  const out = [];
  for (const it of items) {
    if (it === '' || it === null || it === undefined || it === false) continue;
    const p = typeof it === 'string' ? { k: 'text', v: it } : it;
    const last = out[out.length - 1];
    if (p.k === 'text' && last && last.k === 'text') last.v += p.v;
    else out.push({ ...p });
  }
  return out;
}

/** The story sentence (Tissue view narrative), ignoring the viewer's context. */
export function narrateStory(stats, state = {}, ctx = {}) {
  let t = STORY.find((x) => safeWhen(x, stats, state, ctx));
  if (!t) {
    const ok = STEADY.filter((x) => safeWhen(x, stats, state, ctx));
    t = ok[Math.floor(stats.tick / STEADY_PERIOD) % ok.length];
  }
  return { id: t.id, group: t.group, parts: renderTemplate(t.id, stats, state, ctx) };
}

/** The context sentence (viewing, apart, isolate, non-tissue views) or null. */
export function narrateContext(stats, state = {}, ctx = {}) {
  const t = CONTEXT.find((x) => safeWhen(x, stats, state, ctx));
  return t ? { id: t.id, group: t.group, parts: renderTemplate(t.id, stats, state, ctx) } : null;
}

/** ADDENDUM §G.2: the highest-priority sentence for this moment. */
export function narrate(stats, state = {}, ctx = {}) {
  return narrateContext(stats, state, ctx) ?? narrateStory(stats, state, ctx);
}

/** Plain text of parts (for aria announcements). */
export const partsText = (parts) => parts.map((p) => p.v).join('');

// ─── milestone log lines (◆), numbers from milestoneStats ─────────────────────────────────────────────
const MS_LINES = {
  seed: ($) => [$.n('seedCount'), ' ', $.t(STEM), ' cells and ', $.n('energy.initial'), ' units of energy.'],
  firstFates: ($) => [$.n('ms.firstFates.typeCounts.2'), ' ', $.t(ECTO), ', ', $.n('ms.firstFates.typeCounts.3'), ' ',
    $.t(MESO), ' and ', $.n('ms.firstFates.typeCounts.4'), ' ', $.t(ENDO), ' as the first cells read their depth.'],
  muscle: ($) => [$.n('ms.muscle.typeCounts.6'), ' ', $.t(MUSCLE), ' cells, still scattered, where the activator runs high.'],
  layers: ($) => [$.n('d.msFamPct.layers.0', 'pct'), '% ', $.t(ECTO), ' family, ', $.n('d.msFamPct.layers.1', 'pct'), '% ',
    $.t(MESO), ' family, ', $.n('d.msFamPct.layers.2', 'pct'), '% ', $.t(ENDO), ' and ', $.n('d.msFamPct.layers.3', 'pct'), '% ',
    $.t(STEM), ', at ', $.n('d.msCells.layers'), ' cells.'],
  neural: ($) => [$.n('ms.neural.typeCounts.5'), ' ', $.t(NEURAL), ' cells where the midline and A–P signals meet.'],
  endoCore: ($) => [$.t(ENDO, 'endoderm'), ' ', $.n('ms.endoCore.typeCounts.4'), ' now outnumbers ', $.t(ECTO), ' ',
    $.n('ms.endoCore.typeCounts.2'), '.'],
  turnover: ($) => ['births and deaths within ', $.n('k.turnoverPct'), '% of each other at ', $.n('d.msCells.turnover'), ' cells.'],
  founders: ($) => ['none of the ', $.n('seedCount'), ' original cells remains; ', $.n('d.msCells.founders'), ' descendants carry on.'],
};

/** Parts for a milestone's log line, e.g. "Gut core — endoderm 444 now outnumbers ectoderm 441." */
export function milestoneLine(key, stats, state = {}, ctx = {}) {
  const f = MS_LINES[key];
  if (!f) throw new Error(`narrator: unknown milestone ${key}`);
  const label = MILESTONES.find((m) => m.key === key)?.label ?? key;
  const $ = makeBuilder(stats, state, ctx);
  return normalise([{ k: 'rule', v: label }, ' — ', ...f($)]);
}

/** The same line without its "Label — " prefix, first letter capitalised: the note in the timeline popover. */
export function milestoneNote(key, stats, state = {}, ctx = {}) {
  const f = MS_LINES[key];
  if (!f) throw new Error(`narrator: unknown milestone ${key}`);
  const parts = normalise(f(makeBuilder(stats, state, ctx)));
  const p0 = parts[0];
  if (p0 && (p0.k === 'text' || p0.k === 'tissue')) p0.v = p0.v.charAt(0).toUpperCase() + p0.v.slice(1);
  return parts;
}

export const MILESTONE_LINE_KEYS = Object.keys(MS_LINES);

/** The tick a sentence's log entry is stamped with: what it describes (`at`), else the stats it was rendered from. */
function stampOf(id, stats, ctx) {
  const at = BY_ID[id]?.at;
  let v = null;
  if (at) { try { v = at(stats, ctx); } catch { v = null; } }
  return typeof v === 'number' && Number.isFinite(v) ? v : stats.tick;
}

/**
 * Stateful wrapper used by the HUD: the story sentence changes id at most every `holdMs` (3 s, 6 s under
 * reduced motion); its numbers update in place while it still applies. Once it no longer applies but is still
 * held, it keeps the numbers (and the tick) of the last moment it did, so it never quotes a moment it does not
 * describe. When the id changes, the previous sentence is returned as `frozen` so the HUD can file it in the log;
 * `tick` is the tick it describes. `waitMs` > 0 means a new sentence is due once the hold ends.
 * Context sentences follow the viewer immediately.
 */
export function createNarrator() {
  let story = null; // { id, parts, since, tick, stats }: `stats` = the last stats it applied to, `tick` = its stamp
  const start = (pick, stats, ctx, now) => ({ id: pick.id, parts: pick.parts, since: now, tick: stampOf(pick.id, stats, ctx), stats });
  return {
    reset() { story = null; },
    get storyId() { return story?.id ?? null; },
    update(stats, state, ctx, now, holdMs = 3000) {
      const pick = narrateStory(stats, state, ctx);
      let frozen = null, changed = false;
      if (!story) {
        story = start(pick, stats, ctx, now);
        changed = true;
      } else if (pick.id !== story.id && now - story.since >= holdMs) {
        frozen = { id: story.id, parts: story.parts, tick: story.tick };
        story = start(pick, stats, ctx, now);
        changed = true;
      } else {
        let parts = pick.parts;
        if (pick.id !== story.id) {
          // held: still true now → current numbers; no longer true → the last stats it described (state, e.g.
          // running, may still change its wording)
          if (safeWhen(BY_ID[story.id], stats, state, ctx)) story.stats = stats;
          try { parts = renderTemplate(story.id, story.stats, state, ctx); } catch {
            // the held sentence can no longer be told (e.g. after a reset or a resume): switch now
            story = start(pick, stats, ctx, now);
            return { story, context: narrateContext(stats, state, ctx), frozen: null, changed: true, waitMs: 0 };
          }
        } else story.stats = stats;
        story.parts = parts;
        story.tick = stampOf(story.id, story.stats, ctx);
      }
      // a different sentence is due but held: how long until it may replace this one (the HUD re-asks then,
      // even when no new stats arrive because the run is paused)
      const waitMs = pick.id !== story.id ? Math.max(0, story.since + holdMs - now) : 0;
      return { story, context: narrateContext(stats, state, ctx), frozen, changed, waitMs };
    },
  };
}

// ─── inspector provenance: one sentence from a CellDetail (ADDENDUM §C.2 "Inspector") ──────────────────
const NEVER_TICK = 0xFFFFFFFF;              // engine: prov.fateTick of a cell that never changed type
const FAM_BAND = [0, 4, 1, 2, 3, 1, 2, 2];  // the band each type belongs to (stem = core)
const TERMINAL = [NEURAL, MUSCLE, VESSEL];
const BAND_WORD = ['', 'outer band', 'second band', 'inner band', 'core'];

/**
 * "Born T 1,204 in founder 7’s line. Became endoderm at T 1,890 (was mesoderm): its depth moved into the inner band."
 * Numbers come from the CellDetail, PARAMS and seedCount only.
 */
export function cellStory(d, ctx = {}) {
  const p = ctx.params ?? {};
  const seedCount = ctx.seedCount;
  const num = (v, f = 'int') => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new NarratorKeyError('cellDetail', 'non-finite');
    return { k: 'num', v: FMT[f](v) };
  };
  const t = (type) => ({ k: 'tissue', v: TYPE_NAMES[type].toLowerCase(), type });
  const out = [];
  const founderLine = d.founder !== 255 && typeof seedCount === 'number' && d.founder < seedCount;
  if (d.bornTick === 0 && founderLine) out.push('One of the ', num(seedCount), ' founders, alive since ', num(0, 'tick'), '.');
  else {
    out.push('Born ', num(d.bornTick, 'tick'));
    if (founderLine) out.push(' in founder ', num(d.founder + 1), '’s line');
    out.push('.');
  }
  const specified = d.fateTick > 0 && d.fateTick !== NEVER_TICK && d.fateTick <= d.tick && d.fateFrom !== d.type;
  if (!specified) {
    if (d.type === STEM) {
      if (typeof p.diffAge === 'number' && d.age <= p.diffAge) out.push(' Too young to read its depth; it does once older than ', num(p.diffAge), ' ticks.');
      else if ((d.ruleBand ?? d.band) === 4) out.push(' Deep in the core band, so ', { k: 'rule', v: RULE_NAME[3] }, ' keeps it ', t(STEM), '.');
      else out.push(' Its depth points to ', t(d.ruleFate), '; hysteresis holds it until the reading persists.');
    } else out.push(' Has not changed type since it was born.');
    return normalise(out);
  }
  out.push(' Became ', t(d.type), ' at ', num(d.fateTick, 'tick'));
  const from = d.fateFrom;
  if (from !== STEM && from >= 1 && from <= 7) out.push(' (was ', t(from), ')');
  if (from === MESO && d.type === MUSCLE) {
    out.push(': its activator rose above ', ...(p.gates ? [num(p.gates.muscleRel, 'x'), '×'] : []), ' the mean at its depth.');
  } else if (from === MESO && d.type === VESSEL) {
    out.push(': its activator fell below ', ...(p.gates ? [num(p.gates.vesselRel, 'x'), '×'] : []), ' the mean at its depth.');
  } else if (d.type === NEURAL) {
    out.push(': the midline and A–P signals both passed their gates at the surface.');
  } else if (TERMINAL.includes(from)) {
    const revert = p.hysteresis?.terminalRevert;
    if (typeof revert === 'number' && revert > 0) out.push(': it sat outside its band for ', num(revert), ' ticks.');
    else out.push(': it sat outside its band too long.');
  } else if (from === STEM && typeof p.diffAge === 'number' && d.fateTick - d.bornTick <= p.diffAge + (p.hysteresis?.persist ?? 6) + 2) {
    out.push(' when it matured and read its depth (', { k: 'rule', v: RULE_NAME[3] }, ').');
  } else {
    out.push(': its depth moved into the ', BAND_WORD[FAM_BAND[d.type]], '.');
  }
  return normalise(out);
}
