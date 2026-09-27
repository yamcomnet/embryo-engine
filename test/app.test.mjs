// test/app.test.mjs — small app contracts that run without a browser:
//  • view ids from URLs and actions are own keys only (?view=toString must not reach the HUD and crash boot)
//  • with the error card up, no keyboard shortcut drives the stopped simulation, and Space reaches the card's button
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isViewId, viewIdFrom, VIEWS } from '../src/shared.js';

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
