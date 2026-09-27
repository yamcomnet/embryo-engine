// test/narrator.test.mjs — the specimen log's honesty contract (SPEC §5.4, ADDENDUM §D).
// Run: node --test test/
//
//  • every template renders against mock stats (and the real engine PARAMS) with no undefined / NaN / missing key
//  • every number is a 'num' part read through a key path; text parts carry no digits
//  • a missing stats key throws instead of rendering "undefined"
//  • every template is reachable; narrate() picks context over story
//  • the story sentence id changes at most every 3 s (6 s under reduced motion); its numbers update in place while it
//    still applies, and freeze at the last moment it applied once it no longer does (log stamps = what it describes)
//  • rules are cited by name; milestone popover notes; copy regressions (commas, no "0 cells" clauses)
//  • the keyboard map (src/ui/keys.js): non-US layouts (Option / AltGr punctuation, AZERTY digits), spinbutton focus

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeMockFrame, makeMockStats, makeMockCellDetail, MOCK_PARAMS, MOCK_FIELD_INFO,
} from '../dev/mock-frames.js';
import { MILESTONES, VIEWS, TYPE } from '../src/shared.js';
import {
  TEMPLATES, DERIVED, narrate, narrateStory, narrateContext, renderTemplate, createNarrator, milestoneLine, milestoneNote,
  MILESTONE_LINE_KEYS, cellStory, partsText, NarratorKeyError, RULE_NAME,
} from '../src/ui/narrator.js';

let ENGINE = null;
try { ENGINE = await import('../src/engine.js'); } catch { /* engine not landed: mock params only */ }

const PARAM_SETS = [['mock', MOCK_PARAMS, MOCK_FIELD_INFO]];
if (ENGINE?.PARAMS) PARAM_SETS.push(['engine', ENGINE.PARAMS, ENGINE.FIELD_INFO]);

// Fixtures along the mock's composition timeline (cells, tick).
const POINTS = [[37, 0], [38, 14], [51, 30], [93, 100], [229, 212], [365, 300], [818, 500], [1693, 1000], [3000, 2500], [4342, 5000], [6899, 20000]];
const FRAMES = POINTS.map(([cells, tick]) => makeMockFrame({ cells, tick, seed: 1 }));
const BASE = FRAMES.map((f) => makeMockStats(f));
const clone = (o) => JSON.parse(JSON.stringify(o));

function variants() {
  const out = BASE.map((s) => ['T' + s.tick, s]);
  const late = BASE[BASE.length - 3];
  const v = (label, fn) => { const s = clone(late); fn(s); out.push([label, s]); };
  v('lost>0', (s) => { s.energy.lost = 1.75; s.energy.total -= 1.75; });
  v('no deaths', (s) => { s.win.deaths = 0; s.win.deathsByCause = [0, 0, 0, 0]; s.win.recycled = 0; });
  v('no muscle', (s) => { s.typeCounts[TYPE.MUSCLE] = 0; });
  v('energy-limited', (s) => { s.energy.mean = 20.5; });
  v('all stem, T5', (s) => { s.tick = 5; s.typeCounts = [0, s.cellCount, 0, 0, 0, 0, 0, 0]; s.milestoneStats = { seed: s.milestoneStats.seed }; });
  v('founders just gone', (s) => { s.foundersAlive = 0; s.tick = s.milestoneStats.founders.tick + 10; });
  v('endo core window', (s) => { s.tick = s.milestoneStats.endoCore.tick + 20; s.typeCounts[TYPE.ENDO] = s.typeCounts[TYPE.ECTO] + 50; });
  return out;
}
const FIXTURES = variants();

const STATES = [
  { view: 'cells', running: false },
  { view: 'cells', running: true },
  ...VIEWS.filter((x) => x.id !== 'cells').map((x) => ({ view: x.id, running: true })),
  { view: 'cells', isolate: TYPE.MUSCLE, running: true },
  { view: 'cells', exploded: true, running: true },
  { view: 'cells', running: false, viewing: { snapId: 3, tick: 1600, key: 'endoCore' } },
  { view: 'depth', running: false, viewing: { snapId: 101, tick: 1000 } },
];

const BAD = /undefined|NaN|Infinity|null|\[object/;
function checkParts(parts, where) {
  assert.ok(Array.isArray(parts) && parts.length > 0, `${where}: empty sentence`);
  for (const p of parts) {
    assert.ok(['text', 'num', 'tissue', 'rule'].includes(p.k), `${where}: bad part kind ${p.k}`);
    assert.equal(typeof p.v, 'string', `${where}: part value is not a string`);
    assert.ok(p.v.length > 0, `${where}: empty part`);
    assert.ok(!BAD.test(p.v), `${where}: "${p.v}"`);
    if (p.k === 'tissue') assert.ok(p.type >= 1 && p.type <= 7, `${where}: tissue part without a type`);
    if (p.k === 'text') assert.ok(!/\d/.test(p.v), `${where}: digits in a text part ("${p.v}"); numbers must come from a key`);
    if (p.k === 'num') assert.ok(/\d/.test(p.v), `${where}: num part without digits ("${p.v}")`);
  }
}
const ctxFor = (s, params, fieldInfo) => ({ params, fieldInfo, milestoneStats: s.milestoneStats });

test('every template renders wherever it applies, for mock and engine PARAMS', () => {
  let rendered = 0;
  for (const [pname, params, fieldInfo] of PARAM_SETS) {
    for (const [fname, s] of FIXTURES) {
      for (const st of STATES) {
        const state = { ...st, params };
        const ctx = ctxFor(s, params, fieldInfo);
        for (const t of TEMPLATES) {
          if (!t.when(s, state, ctx)) continue;
          const parts = renderTemplate(t.id, s, state, ctx);
          checkParts(parts, `${pname}/${fname}/${st.view}/${t.id}`);
          rendered++;
        }
      }
    }
  }
  assert.ok(rendered > 200, `only ${rendered} renders`);
});

test('every template also renders on a mature embryo regardless of its condition (held sentences)', () => {
  for (const [pname, params, fieldInfo] of PARAM_SETS) {
    for (const s of BASE.filter((x) => x.tick >= 2500)) {
      const state = { view: 'cells', running: true, isolate: TYPE.NEURAL, viewing: { snapId: 1, tick: 14, key: 'firstFates' }, params };
      for (const t of TEMPLATES) checkParts(renderTemplate(t.id, s, state, ctxFor(s, params, fieldInfo)), `${pname}/T${s.tick}/${t.id}`);
    }
  }
});

test('every template is reachable', () => {
  const seen = new Set();
  for (const [, s] of FIXTURES) for (const st of STATES) {
    const ctx = ctxFor(s, MOCK_PARAMS, MOCK_FIELD_INFO);
    for (const t of TEMPLATES) if (t.when(s, { ...st, params: MOCK_PARAMS }, ctx)) seen.add(t.id);
  }
  const missing = TEMPLATES.map((t) => t.id).filter((id) => !seen.has(id));
  assert.deepEqual(missing, [], `never selected: ${missing.join(', ')}`);
  assert.ok(TEMPLATES.length >= 12, 'at least ~12 templates');
  assert.equal(new Set(TEMPLATES.map((t) => t.id)).size, TEMPLATES.length, 'template ids are unique');
});

test('a missing stats key throws instead of reading "undefined"', () => {
  const s = clone(BASE[8]);
  delete s.win.reSpecified;
  assert.throws(() => renderTemplate('respec', s, { view: 'cells' }, ctxFor(s, MOCK_PARAMS)), NarratorKeyError);
  const s2 = clone(BASE[8]);
  s2.energy.mean = NaN;
  assert.throws(() => renderTemplate('vEnergy', s2, { view: 'energy' }, ctxFor(s2, MOCK_PARAMS)), NarratorKeyError);
  assert.throws(() => renderTemplate('firstFates', BASE[0], { view: 'cells' }, ctxFor(BASE[0], MOCK_PARAMS)), NarratorKeyError, 'milestone stats not reached yet');
  const noGate = { ...MOCK_PARAMS, gates: {} };
  assert.throws(() => renderTemplate('neural', BASE[8], { view: 'cells' }, ctxFor(BASE[8], noGate)), NarratorKeyError);
});

test('derived placeholders are pure functions of stats, state and ctx', () => {
  const s = BASE[8];
  const a = partsText(renderTemplate('layersState', s, { view: 'cells' }, ctxFor(s, MOCK_PARAMS)));
  const b = partsText(renderTemplate('layersState', clone(s), { view: 'cells' }, ctxFor(clone(s), MOCK_PARAMS)));
  assert.equal(a, b);
  assert.ok(Object.keys(DERIVED).length > 5);
});

test('narrate(): context outranks story, and the story follows the embryo', () => {
  const at = (i, st) => narrate(BASE[i], { view: 'cells', ...st, params: MOCK_PARAMS }, ctxFor(BASE[i], MOCK_PARAMS)).id;
  assert.equal(at(0, {}), 'intro');
  assert.equal(at(1, {}), 'firstFates');
  assert.equal(at(8, { viewing: { snapId: 1, tick: 14, key: 'firstFates' } }), 'viewing');
  assert.equal(at(8, { exploded: true }), 'apart');
  assert.equal(at(8, { isolate: TYPE.ENDO }), 'isolate');
  const byView = { depth: 'vDepth', energy: 'vEnergy', age: 'vAge', midline: 'vMidline', ap: 'vAP', activator: 'vAct', inhibitor: 'vInh' };
  for (const [view, id] of Object.entries(byView)) assert.equal(at(8, { view }), id);
  assert.equal(narrateContext(BASE[8], { view: 'cells' }, ctxFor(BASE[8], MOCK_PARAMS)), null);
  const r = narrate(BASE[0], { view: 'cells', running: false, params: MOCK_PARAMS }, ctxFor(BASE[0], MOCK_PARAMS));
  assert.match(partsText(r.parts), /37 stem cells, alike but for a little noise, share 250,000 units/);
  // a steady embryo keeps changing sentence as ticks pass (pure rotation by tick)
  const ids = new Set();
  for (let t = 3000; t < 9000; t += 400) { const s = { ...clone(BASE[9]), tick: t }; ids.add(narrateStory(s, { view: 'cells' }, ctxFor(s, MOCK_PARAMS)).id); }
  assert.ok(ids.size >= 3, `steady rotation stuck on ${[...ids]}`);
});

test('milestone log lines render for every milestone', () => {
  assert.deepEqual([...MILESTONE_LINE_KEYS].sort(), MILESTONES.map((m) => m.key).sort());
  for (const [pname, params] of PARAM_SETS) {
    const s = BASE[8];
    for (const m of MILESTONES) {
      const parts = milestoneLine(m.key, s, { params }, ctxFor(s, params));
      checkParts(parts, `${pname}/◆${m.key}`);
      assert.equal(parts[0].v, m.label);
    }
  }
});

test('inspector provenance renders for every kind of cell', () => {
  const f = FRAMES[8];
  const kinds = new Set();
  for (let k = 0; k < f.idxCount; k += 7) {
    const d = makeMockCellDetail(f, f.idx[k]);
    if (!d) continue;
    for (const [pname, params] of PARAM_SETS) {
      const parts = cellStory(d, { params, seedCount: 37 });
      checkParts(parts, `${pname}/cell ${d.idx} type ${d.type}`);
    }
    kinds.add(`${d.type}:${d.fateFrom}`);
  }
  assert.ok(kinds.size >= 6, 'covers several fate histories');
  const founder = makeMockCellDetail(FRAMES[0], FRAMES[0].idx[0]);
  assert.match(partsText(cellStory(founder, { params: MOCK_PARAMS, seedCount: 37 })), /One of the 37 founders/);
  // the engine marks "never changed type" with 0xFFFFFFFF
  const never = { ...founder, fateTick: 0xFFFFFFFF, fateFrom: 0, age: 400, band: 4 };
  assert.match(partsText(cellStory(never, { params: MOCK_PARAMS, seedCount: 37 })), /core band/);
});

const BY_ID = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));
function simulate({ holdMs, seconds = 90, hz = 4, reducedMotion = false }) {
  const n = createNarrator();
  const changes = [];
  let t = 0, i = 0, lastId = null, lastTick = null, lastText = null;
  // cycle through fixtures whose story ids differ, as fast as the narrator is evaluated
  const pool = FIXTURES.map(([, s]) => s);
  for (; t <= seconds * 1000; t += 1000 / hz, i++) {
    const s = pool[i % pool.length];
    const st = { view: 'cells', running: true, reducedMotion, params: MOCK_PARAMS };
    const ctx = ctxFor(s, MOCK_PARAMS);
    const r = n.update(s, st, ctx, t, holdMs);
    if (r.changed) changes.push({ t, id: r.story.id, frozen: r.frozen?.id ?? null });
    checkParts(r.story.parts, `held ${r.story.id} @${t}`);
    if (!r.changed && r.story.id === lastId) {
      if (BY_ID[r.story.id].when(s, st, ctx)) {
        // still true: the numbers follow the stats (stamped with the tick it describes)
        const at = BY_ID[r.story.id].at?.(s, ctx);
        assert.equal(r.story.tick, typeof at === 'number' ? at : s.tick, `${r.story.id}: numbers update in place while it applies`);
        assert.equal(partsText(r.story.parts), partsText(renderTemplate(r.story.id, s, st, ctx)));
      } else {
        // held after it stopped applying: it keeps the last moment it described
        assert.equal(r.story.tick, lastTick, `${r.story.id}: a held sentence that no longer applies keeps its tick`);
        assert.equal(partsText(r.story.parts), lastText, `${r.story.id}: … and its numbers`);
      }
    }
    lastId = r.story.id; lastTick = r.story.tick; lastText = partsText(r.story.parts);
  }
  return changes;
}

test('story sentence id changes at most every 3 s (6 s under reduced motion)', () => {
  for (const [holdMs, reducedMotion] of [[3000, false], [6000, true]]) {
    const ch = simulate({ holdMs, reducedMotion });
    assert.ok(ch.length > 5, `the story should move on (${ch.length} changes)`);
    for (let k = 1; k < ch.length; k++) {
      const gap = ch[k].t - ch[k - 1].t;
      assert.ok(gap >= holdMs, `id changed after ${gap} ms (${ch[k - 1].id} → ${ch[k].id}), hold ${holdMs} ms`);
      assert.equal(ch[k].frozen, ch[k - 1].id, 'the previous sentence is frozen into the log');
    }
  }
});

test('context sentences follow the viewer immediately', () => {
  const n = createNarrator();
  const s = BASE[8], ctx = ctxFor(s, MOCK_PARAMS);
  const a = n.update(s, { view: 'cells', params: MOCK_PARAMS }, ctx, 0);
  assert.equal(a.context, null);
  const b = n.update(s, { view: 'depth', params: MOCK_PARAMS }, ctx, 100);
  assert.equal(b.context.id, 'vDepth');
  assert.equal(b.story.id, a.story.id, 'story unaffected');
  const c = n.update(s, { view: 'cells', exploded: true, params: MOCK_PARAMS }, ctx, 200);
  assert.equal(c.context.id, 'apart');
});

test('the intro is filed at T 0 and never quotes a later moment; first fates is dated', () => {
  const n = createNarrator();
  const st = { view: 'cells', running: true, params: MOCK_PARAMS };
  const t0 = BASE[0];
  const a = n.update(t0, { ...st, running: false }, ctxFor(t0, MOCK_PARAMS), 0);
  assert.equal(a.story.id, 'intro');
  assert.match(partsText(a.story.parts), /Rule 1 · divide/, 'the intro carries Rule 1 (the cleavage chapter is usually over before the hold ends)');
  assert.match(partsText(a.story.parts), /Press play/);
  // T 100 arrives during the 3 s hold: the intro no longer applies, so it keeps its T 0 numbers and stamp
  const s = BASE[3];
  const b = n.update(s, st, ctxFor(s, MOCK_PARAMS), 1000);
  assert.equal(b.story.id, 'intro');
  assert.equal(b.story.tick, 0);
  assert.doesNotMatch(partsText(b.story.parts), /Press play/, 'the state (running) still updates its wording');
  const c = n.update(s, st, ctxFor(s, MOCK_PARAMS), 3100);
  assert.equal(c.frozen.id, 'intro');
  assert.equal(c.frozen.tick, 0, 'filed in the log at the tick it describes');
  // first fates is past tense and dated by its milestone
  const ff = BASE[1];
  const txt = partsText(renderTemplate('firstFates', ff, st, ctxFor(ff, MOCK_PARAMS)));
  assert.match(txt, new RegExp(`^At T.${ff.milestoneStats.firstFates.tick} the first cells`));
  assert.equal(TEMPLATES.find((t) => t.id === 'firstFates').at(ff, ctxFor(ff, MOCK_PARAMS)), ff.milestoneStats.firstFates.tick);
});

test('rules are cited by name, never by number alone', () => {
  const names = new Set(Object.values(RULE_NAME));
  for (const [, s] of FIXTURES) for (const st of STATES) {
    const ctx = ctxFor(s, MOCK_PARAMS);
    for (const t of TEMPLATES) {
      if (!t.when(s, { ...st, params: MOCK_PARAMS }, ctx)) continue;
      for (const p of renderTemplate(t.id, s, { ...st, params: MOCK_PARAMS }, ctx)) {
        if (p.k === 'rule') assert.ok(names.has(p.v), `${t.id}: rule part "${p.v}" has no name`);
      }
    }
  }
});

test('milestone popover notes are the log line without its label', () => {
  for (const [pname, params] of PARAM_SETS) {
    const s = BASE[8];
    for (const key of MILESTONE_LINE_KEYS) {
      const line = partsText(milestoneLine(key, s, { params }, ctxFor(s, params)));
      const note = milestoneNote(key, s, { params }, ctxFor(s, params));
      checkParts(note, `${pname}/note ${key}`);
      const label = MILESTONES.find((m) => m.key === key).label;
      const rest = line.slice(`${label} — `.length);
      const txt = partsText(note);
      assert.equal(txt, rest.charAt(0).toUpperCase() + rest.slice(1), `${key}: note`);
      assert.ok(!/^[a-z]/.test(txt), `${key}: note starts with a capital`);
    }
  }
});

test('log copy: commas after the window, no "0 cells" clauses, "above threshold" is not "can divide"', () => {
  const s = clone(BASE[9]);
  const ctx = ctxFor(s, MOCK_PARAMS), st = { view: 'cells', params: MOCK_PARAMS };
  for (const id of ['respec', 'turnover']) assert.match(partsText(renderTemplate(id, s, st, ctx)), /^In the last \d+ ticks, /, id);
  s.win.deathsByCause = [700, 0, 184, 0]; s.win.deaths = 884;
  const none = partsText(renderTemplate('causes', s, st, ctx));
  assert.doesNotMatch(none, /\b0 (cells|were)/, none);
  assert.match(none, /184 were exposed tips/);
  s.win.deathsByCause = [700, 10, 184, 0]; s.win.deaths = 894;
  assert.match(partsText(renderTemplate('causes', s, st, ctx)), /, and 10 were cells left with no neighbour/);
  for (const [, f] of FIXTURES) for (const st2 of STATES) {
    const c2 = ctxFor(f, MOCK_PARAMS), state = { ...st2, params: MOCK_PARAMS };
    for (const t of TEMPLATES) {
      if (!t.when(f, state, c2)) continue;
      assert.doesNotMatch(partsText(renderTemplate(t.id, f, state, c2)), /can divide|ready to divide/i, `${t.id} equates above threshold with dividing`);
    }
  }
});

// ─── keyboard map (src/ui/keys.js) ────────────────────────────────────────────────────────────────────────
// Real bindKeys with a stub target and document; events carry what browsers report for each layout.
async function keyHarness(state = {}) {
  const el = (role) => ({ tagName: 'SPAN', type: undefined, isContentEditable: false, closest: (sel) => (role && sel.includes(`[role="${role}"]`) ? {} : null) });
  globalThis.document ??= { body: {}, activeElement: null };
  const { bindKeys } = await import('../src/ui/keys.js');
  let onKey = null, onPointer = null;
  const target = { addEventListener: (t, f) => { if (t === 'keydown') onKey = f; else onPointer = f; }, removeEventListener() {} };
  const out = [];
  bindKeys(target, { dispatch: (a) => out.push(a), getState: () => ({ viewing: null, ...state }) });
  const fire = (ev, focus = null) => {
    document.activeElement = focus;
    out.length = 0;
    let prevented = false;
    onKey({ defaultPrevented: false, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false,
      getModifierState: (m) => (m === 'AltGraph' ? !!ev.altGraph : false), preventDefault() { prevented = true; }, ...ev });
    return { acts: out.map((a) => a.type + (a.delta !== undefined ? `:${a.delta}` : a.id ? `:${a.id}` : '')), prevented };
  };
  return { fire, el, keyboard: () => onKey({ key: 'Tab' }), pointer: () => onPointer() };
}

test('keys: Option / AltGr punctuation and AZERTY digits reach the map; Ctrl, Cmd and Alt+letter do not', async () => {
  const { fire } = await keyHarness();
  assert.deepEqual(fire({ key: '[' }).acts, ['milestoneDelta:-1']);
  assert.deepEqual(fire({ key: '[', code: 'Digit8', altKey: true }).acts, ['milestoneDelta:-1'], 'macOS Finnish/Swedish Option+8');
  assert.deepEqual(fire({ key: ']', code: 'Digit9', altKey: true }).acts, ['milestoneDelta:1'], 'macOS Option+9');
  assert.deepEqual(fire({ key: '[', code: 'Digit8', altKey: true, ctrlKey: true }).acts, ['milestoneDelta:-1'], 'Windows AltGr (Ctrl+Alt)');
  assert.deepEqual(fire({ key: ']', code: 'Digit9', altKey: true, ctrlKey: true, altGraph: true }).acts, ['milestoneDelta:1'], 'AltGraph modifier state');
  assert.deepEqual(fire({ key: '+', code: 'Minus', altKey: true }).acts, ['speedDelta:1']);
  assert.deepEqual(fire({ key: '3', code: 'Digit3' }).acts, ['view:energy']);
  assert.deepEqual(fire({ key: '3', code: 'Digit3', shiftKey: true }).acts, ['view:energy'], 'AZERTY Shift+digit row');
  assert.deepEqual(fire({ key: '-', code: 'Digit6' }).acts, ['speedDelta:-1'], 'AZERTY 6 is minus');
  assert.deepEqual(fire({ key: '3', code: 'Numpad3' }).acts, ['view:energy']);
  // still ignored: browser / OS chords and Alt with letters, digits and named keys
  assert.deepEqual(fire({ key: '[', ctrlKey: true }).acts, [], 'Ctrl+[');
  assert.deepEqual(fire({ key: '[', metaKey: true }).acts, [], 'Cmd+[');
  assert.deepEqual(fire({ key: 'r', altKey: true }).acts, [], 'Alt+R');
  assert.deepEqual(fire({ key: '3', altKey: true }).acts, [], 'Alt+3');
  assert.deepEqual(fire({ key: 'ArrowLeft', altKey: true }).acts, [], 'Alt+← (history)');
  assert.deepEqual(fire({ key: '®', altKey: true }).acts, [], 'macOS Option+R');
});

test('keys: Space and Enter stay global on the speed spinbutton, native on buttons', async () => {
  const { fire, el, keyboard, pointer } = await keyHarness({ viewing: { snapId: 1, tick: 300 } });
  keyboard();
  assert.deepEqual(fire({ key: ' ' }, el('spinbutton')).acts, ['toggleRun'], 'spinbutton has no activation of its own');
  assert.deepEqual(fire({ key: 'Enter' }, el('spinbutton')).acts, ['resume']);
  assert.deepEqual(fire({ key: ' ' }, el('radio')).acts, [], 'a radio reached with the keyboard keeps Space');
  assert.deepEqual(fire({ key: ' ' }, { ...el(null), tagName: 'BUTTON', closest: () => ({}) }).acts, []);
  pointer();
  assert.deepEqual(fire({ key: ' ' }, { ...el(null), tagName: 'BUTTON', closest: () => ({}) }).acts, ['toggleRun'], 'after a click, Space runs');
});

// ─── honesty regressions (release review) ────────────────────────────────────────────────────────────────
test('Energy view: never more cells "can divide" than have room; the count with room is readyRoom', () => {
  for (const [label, f] of FIXTURES) {
    if (!(f.energy.ready > 0)) continue;
    const s = clone(f);
    s.energy.readyRoom = Math.min(s.energy.ready, 7);
    const txt = partsText(renderTemplate('vEnergy', s, { view: 'energy', params: MOCK_PARAMS }, ctxFor(s, MOCK_PARAMS)));
    assert.doesNotMatch(txt, /can divide|ready to divide/i, label);
    const m = txt.match(/only ([\d,]+) have an empty neighbouring place/);
    assert.ok(m, `${label}: ${txt}`);
    assert.equal(Number(m[1].replace(/,/g, '')), s.energy.readyRoom, label);
  }
});

test('re-specification sentence: band crossings, specialisation and stem fates are told apart', () => {
  const s = clone(BASE[9]);
  s.win.reSpecified = 5; s.win.fatesTo = [0, 0, 0, 0, 0, 0, 90, 60]; s.win.stemFates = 600;
  const txt = partsText(renderTemplate('respec', s, { view: 'cells' }, ctxFor(s, MOCK_PARAMS)));
  assert.match(txt, /^In the last \d+ ticks, 5 specified cells crossed into another band/);
  assert.match(txt, /150 mesoderm cells became muscle or vessel/);
  assert.match(txt, /600 young stem cells took their band’s fate/);
  assert.doesNotMatch(txt, /concentric/, 'no claim about what keeps the layers concentric');
});

test('framing: no "local rules", "no map" or "nothing else" claims in the log', () => {
  for (const [label, f] of FIXTURES) for (const st of STATES) {
    const c = ctxFor(f, MOCK_PARAMS), state = { ...st, params: MOCK_PARAMS };
    for (const t of TEMPLATES) {
      if (!t.when(f, state, c)) continue;
      const txt = partsText(renderTemplate(t.id, f, state, c));
      assert.doesNotMatch(txt, /local rules|no map|no plan|nothing else/i, `${t.id} @ ${label}`);
      assert.doesNotMatch(txt, /\b(Space|Enter)\b|\bL returns\b/, `${t.id} names keys a touch device does not have`);
    }
  }
});

test('the first muscle milestone does not claim blocks', () => {
  const s = clone(BASE[9]);
  const line = partsText(milestoneLine('muscle', s, { view: 'cells' }, ctxFor(s, MOCK_PARAMS)));
  assert.doesNotMatch(line, /block|Turing/i, line);
});
