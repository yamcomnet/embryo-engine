// src/ui/keys.js — the keyboard map (ADDENDUM §C.2 "Keyboard", SPEC §5.5 minus focal/sort/reticle keys).
//
// Space and Enter are global (run/pause, resume) unless a control that has a native activation (a button, link,
// radio, switch…) was reached with the keyboard: then they activate that control as usual. A mouse click leaves
// focus on a button, and we do not want Space to re-press that button, so we track the input modality ourselves
// (pointerdown → pointer, Tab → keyboard). Controls with no activation of their own (the speed spinbutton) keep
// Space and Enter global.
// Groups with their own arrow-key handling (radio groups, the timeline, the speed spinbutton) call
// preventDefault, and this handler then ignores the event.
//
// Modifiers: Cmd and Ctrl chords belong to the browser and the OS. Option (macOS) and AltGr (Windows, reported as
// Ctrl+Alt) are how many non-US layouts type punctuation (Finnish, Swedish, German: Option+8/9 → [ ]), so an
// Alt-modified key is still ours when it produced one of the punctuation keys in ALT_OK. Letters, digits and
// named keys stay blocked with Alt (Windows Alt+letter accelerators, Alt+Arrow history). Keys are matched on the
// character produced (e.key), never the physical key, so AZERTY's Shift+digit row reaches the stains.

import { VIEWS } from '../shared.js';

const VIEW_BY_KEY = Object.fromEntries(VIEWS.map((v) => [v.key, v.id]));
const ORBIT_DEG = 5;
const ZOOM_STEP = 0.85; // zoom{factor} multiplies the camera distance: < 1 moves closer
const REPEATABLE = new Set(['.', '>', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', '-', '_', '=', '+', '[', ']', 'PageUp', 'PageDown']);

const TEXT_INPUT = /^(text|search|email|url|tel|password|number)$/i;
function isTextField(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && TEXT_INPUT.test(el.type || 'text');
}
// Controls whose native activation Space / Enter should reach (a spinbutton has none: it stays global).
const NATIVE_ACTIVATION = 'button, a[href], input, select, textarea, summary, [role="button"], [role="radio"], [role="switch"], [role="tab"]';
const hasNativeActivation = (el) => !!(el && el !== document.body && el.closest?.(NATIVE_ACTIVATION));
// Punctuation some layouts can only type with Option / AltGr.
const ALT_OK = new Set(['[', ']', '?', '+', '-', '_', '=', '.', '>']);

export function bindKeys(target, { dispatch, getState }) {
  let modality = 'pointer';
  const onPointer = () => { modality = 'pointer'; };

  function onKeyDown(e) {
    if (e.key === 'Tab') { modality = 'keyboard'; return; }
    if (e.defaultPrevented || e.isComposing) return;
    const altGr = (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) || (e.ctrlKey && e.altKey);
    if (e.metaKey || (e.ctrlKey && !altGr)) return;
    if ((e.altKey || altGr) && !ALT_OK.has(e.key)) return;
    const el = document.activeElement;
    if (isTextField(el)) return;
    const k = e.key;
    if (e.repeat && !REPEATABLE.has(k)) return;
    const st = (getState && getState()) || {};
    const lk = k.length === 1 ? k.toLowerCase() : k;

    // The error card is up: no shortcut drives the stopped simulation, and Space / Enter reach the card's focused
    // button (Reload, or the classic version) natively.
    if (st.error) return;

    // While the help dialog is open, it owns the keyboard except for its own toggles.
    if (st.helpOpen) {
      if (k === 'Escape' || k === '?' || lk === 'h') { e.preventDefault(); dispatch({ type: 'help', open: false }); }
      else if (lk === 'm') { e.preventDefault(); dispatch({ type: 'reducedMotion', on: !st.reducedMotion }); }
      return;
    }

    if ((k === ' ' || k === 'Enter') && modality === 'keyboard' && hasNativeActivation(el)) return; // native activation

    let a = null;
    if (e.shiftKey && k.startsWith('Arrow')) {
      const dAz = k === 'ArrowLeft' ? -ORBIT_DEG : k === 'ArrowRight' ? ORBIT_DEG : 0;
      const dEl = k === 'ArrowUp' ? ORBIT_DEG : k === 'ArrowDown' ? -ORBIT_DEG : 0;
      a = { type: 'orbit', dAz, dEl };
    } else if (VIEW_BY_KEY[k]) {           // e.key only: on QWERTY Shift+digit never yields a digit; on AZERTY it must
      a = { type: 'view', id: VIEW_BY_KEY[k] };
    } else {
      switch (lk) {
        case ' ': a = { type: 'toggleRun' }; break;
        case '.': case '>': case 'ArrowRight': a = { type: 'step', n: 1 }; break;
        case 'r': a = { type: 'reset' }; break;
        case 'n': a = { type: 'newSeed' }; break;
        case '-': case '_': a = { type: 'speedDelta', delta: -1 }; break;
        case '=': case '+': a = { type: 'speedDelta', delta: 1 }; break;
        case 'x': a = { type: 'toggleExplode' }; break;
        case '[': a = { type: 'milestoneDelta', delta: -1 }; break;
        case ']': a = { type: 'milestoneDelta', delta: 1 }; break;
        case 'l': a = st.viewing ? { type: 'live' } : null; break;
        case 'Enter': a = st.viewing ? { type: 'resume' } : null; break;
        case 'c': a = { type: 'cycleCamera' }; break;
        case 'f': a = { type: 'frame' }; break;
        case 'o': a = { type: 'toggleTurntable' }; break;   // polish: turntable orbit
        case 'PageUp': a = { type: 'zoom', factor: ZOOM_STEP }; break;
        case 'PageDown': a = { type: 'zoom', factor: 1 / ZOOM_STEP }; break;
        case 'q': a = { type: 'cycleQuality' }; break;
        case 'm': a = { type: 'reducedMotion', on: !st.reducedMotion }; break;
        case '?': case 'h': a = { type: 'toggleHelp' }; break;
        case 'Escape': a = { type: 'escape' }; break;
        default: break;
      }
    }
    if (!a) return;
    e.preventDefault();
    dispatch(a);
  }

  target.addEventListener('pointerdown', onPointer, true);
  target.addEventListener('keydown', onKeyDown);
  return function unbind() {
    target.removeEventListener('pointerdown', onPointer, true);
    target.removeEventListener('keydown', onKeyDown);
  };
}

/** The keyboard table shown in the help dialog (kept next to the map so they cannot drift apart). */
export const KEY_HELP = [
  [['Space'], 'Run / pause'],
  [['.', '→'], 'Step one tick'],
  [['R'], 'Reset, same seed'],
  [['N'], 'New seed'],
  [['−', '+'], 'Slower / faster'],
  [['1', '8'], 'Stains', '–'],
  [['X'], 'Together ⇄ Apart'],
  [['[', ']'], 'Previous / next milestone'],
  [['L'], 'Back to live'],
  [['Enter'], 'Resume from the snapshot'],
  [['C'], 'Camera: specimen → close → map'],
  [['F'], 'Frame the organism and follow it'],
  [['O'], 'Turntable orbit on / off (while running)'],
  [['Shift', '←↑→↓'], 'Orbit', '+'],
  [['PgUp', 'PgDn'], 'Zoom in / out'],
  [['Q'], 'Quality: auto → high → medium → low'],
  [['M'], 'Reduced motion on / off'],
  [['?', 'H'], 'This guide'],
  [['Esc'], 'Close, unpin, back to live, stop a fast-forward, or show all tissues'],
];
