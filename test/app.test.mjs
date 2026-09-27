// test/app.test.mjs — small app contracts that run without a browser:
//  • view ids from URLs and actions are own keys only (?view=toString must not reach the HUD and crash boot)
//  • with the error card up, no keyboard shortcut drives the stopped simulation, and Space reaches the card's button
//  • the scene dock (src/ui/dock.js): what it shows, when Orbit is idle, when the one-time Apart nudge is due, and
//    that its keys (X, C, O, F) reach their actions and are listed in the guide
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isViewId, viewIdFrom, VIEWS, MILESTONES } from '../src/shared.js';
import { dockModel, orbitTurning, orbitIdleReason, apartHintDue } from '../src/ui/dock.js';

test('view ids: own ids and keys only', () => {
  for (const bad of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf', '', '9', '0', 'Cells', null, undefined, 3]) {
    assert.equal(isViewId(bad), false, String(bad));
    assert.equal(viewIdFrom(bad), bad === 3 ? 'energy' : null, String(bad));
  }
  for (const v of VIEWS) {
    assert.equal(isViewId(v.id), true);
    assert.equal(viewIdFrom(v.id), v.id);
    assert.equal(viewIdFrom(v.key), v.id);
  }
});

test('keys: with the error card up, shortcuts do nothing and Space / Enter stay native', async () => {
  globalThis.document ??= { body: {}, activeElement: null };
  const { bindKeys } = await import('../src/ui/keys.js');
  let onKey = null;
  const target = { addEventListener: (t, f) => { if (t === 'keydown') onKey = f; }, removeEventListener() {} };
  const out = [];
  bindKeys(target, { dispatch: (a) => out.push(a), getState: () => ({ error: 'The simulation stopped.', viewing: null }) });
  const button = { tagName: 'BUTTON', closest: () => ({}) };
  for (const key of [' ', 'Enter', 'r', 'n', '[', ']', '.', 'ArrowRight', '?', 'Escape', '3']) {
    document.activeElement = button;
    let prevented = false;
    out.length = 0;
    onKey({ key, defaultPrevented: false, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false,
      getModifierState: () => false, preventDefault() { prevented = true; } });
    assert.deepEqual(out, [], `${JSON.stringify(key)} dispatched`);
    assert.equal(prevented, false, `${JSON.stringify(key)} was prevented (the focused Reload button would not activate)`);
  }
});

test('scene dock: the model follows the state, and Orbit idles exactly when the stage does not turn', () => {
  const live = { turntable: true, running: true, autoFrame: true, viewing: null, reducedMotion: false, camera: 'specimen', exploded: false };
  assert.deepEqual(dockModel(live), { apart: false, camera: 'specimen', orbit: true, orbitIdle: false, orbitNote: '', frame: false });
  assert.equal(orbitTurning(live), true);
  // each reason the turntable holds still, in the words the button gives (no key names: touch devices have none)
  const idle = [
    [{ running: false }, 'Turns while the run plays'],
    [{ viewing: { snapId: 1, tick: 300 } }, 'Turns again back at live'],
    [{ autoFrame: false }, 'Resumes when you press Frame'],
    [{ camera: 'map' }, 'Not in the Map view'],
    [{ reducedMotion: true }, 'Held still by reduced motion'],
  ];
  for (const [patch, why] of idle) {
    const s = { ...live, ...patch };
    assert.equal(orbitTurning(s), false, JSON.stringify(patch));
    assert.equal(orbitIdleReason(s), why);
    const m = dockModel(s);
    assert.equal(m.orbit, true);
    assert.equal(m.orbitIdle, true);
    assert.doesNotMatch(why, /\b(Space|Enter|Esc|[OF])\b/, 'no key names');
  }
  // off: not idle and no reason; Frame shows only once the camera was taken; an unknown preset falls back
  const off = dockModel({ ...live, turntable: false });
  assert.equal(off.orbit, false); assert.equal(off.orbitIdle, false); assert.equal(off.orbitNote, '');
  assert.equal(dockModel({ ...live, autoFrame: false }).frame, true);
  assert.equal(dockModel({ ...live, camera: 'toString' }).camera, 'specimen');
  assert.equal(dockModel({ ...live, exploded: true }).apart, true);
});

test('scene dock: the Apart nudge waits for Four layers, live, and never after Apart was used', () => {
  const reached = MILESTONES.map((m) => ({ key: m.key, tick: m.key === 'seed' || m.key === 'layers' ? 300 : null }));
  const ok = { ready: true, stageReady: true, error: null, exploded: false, viewing: null, progress: null, helpOpen: false, milestones: reached };
  assert.equal(apartHintDue(ok, false), true);
  assert.equal(apartHintDue(ok, true), false, 'seen in this browser');
  assert.equal(apartHintDue({ ...ok, milestones: reached.map((m) => (m.key === 'layers' ? { ...m, tick: null } : m)) }, false), false, 'not reached yet');
  for (const patch of [{ exploded: true }, { viewing: { snapId: 2, tick: 300 } }, { progress: { tick: 10, target: 3000 } }, { helpOpen: true }, { stageReady: false }, { error: 'x' }]) {
    assert.equal(apartHintDue({ ...ok, ...patch }, false), false, JSON.stringify(patch));
  }
});

test('keys: X, C, O and F reach the scene dock’s actions, and the guide lists them', async () => {
  globalThis.document ??= { body: {}, activeElement: null };
  const { bindKeys, KEY_HELP } = await import('../src/ui/keys.js');
  let onKey = null;
  const target = { addEventListener: (t, f) => { if (t === 'keydown') onKey = f; }, removeEventListener() {} };
  const out = [];
  bindKeys(target, { dispatch: (a) => out.push(a.type), getState: () => ({ viewing: null }) });
  document.activeElement = null;
  for (const [key, type] of [['x', 'toggleExplode'], ['c', 'cycleCamera'], ['o', 'toggleTurntable'], ['f', 'frame'], ['X', 'toggleExplode']]) {
    out.length = 0;
    onKey({ key, defaultPrevented: false, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: key === 'X', repeat: false,
      getModifierState: () => false, preventDefault() {} });
    assert.deepEqual(out, [type], key);
  }
  const listed = new Set(KEY_HELP.flatMap(([ks]) => ks));
  for (const k of ['X', 'C', 'O', 'F']) assert.ok(listed.has(k), `the guide's keyboard table lists ${k}`);
  // "Orbit" is the dock's turntable button, so only O may carry that name (Shift + arrows turn the camera)
  assert.deepEqual(KEY_HELP.filter(([, label]) => /^Orbit\b/.test(label)).map(([ks]) => ks.join('+')), ['O']);
});
