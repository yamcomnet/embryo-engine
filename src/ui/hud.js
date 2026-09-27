// src/ui/hud.js — the Darkfield HUD (ADDENDUM §C.2, API §G.2).
//
// createHud(root, { dispatch }) builds everything inside root (#hud) and returns:
//   render(state)            AppState changed (idempotent; each part re-renders only when its inputs change)
//   setStats(stats, state)   ≤ 10 Hz: composition, legend facts, stats line, timeline playhead, narrator (4 Hz)
//   setInspector(detail, anchor)  hover / pinned cell callout; anchor = stage.projectCell(idx) in CSS px
//   moveInspector(anchor)    only the anchor moved (orbit, turntable): re-place the plate without rebuilding it
//   setHint(text, ms), announce(text), setProgress(p), showFallback(reason), showError(message), destroy()
//   layout()                 { insets, rects }: the HUD's footprint (main passes it to stage.setHudLayout)
// The HUD owns the specimen log's history and the timeline UI. It never mutates state: every control
// dispatches an action (§G.4) and waits for render(state).

import {
  TYPE, TYPE_NAMES, TISSUE_HEX, VIEWS, VIEW_INDEX, SPEEDS, CAMERA_PRESETS, QUALITY_MODES, MILESTONES, BAND_LABELS, GRID,
} from '../shared.js';
import { createNarrator, narrateContext, milestoneLine, milestoneNote, cellStory, partsText } from './narrator.js';
import { fmtInt, fmtPct, fmtE, fmtSig, fmtTick, fmtSpeed, fmtX, numberWord } from './format.js';
import { RAMPS, BAND_HEX, rampCss, previewCss, fieldPos } from './ramps.js';
import { KEY_HELP } from './keys.js';

const { STEM, ECTO, MESO, ENDO, NEURAL, MUSCLE, VESSEL } = TYPE;
const MOBILE_MQ = '(max-width: 759px), (max-height: 499px) and (pointer: coarse)';
// Touch-only devices get no key names (the CSS hides <kbd> chips under the same query).
const TOUCH = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
const SUBTITLE = (n) => `${n ? numberWord(n) : 'A few'} stem cells, one fixed pot of energy, three rules and four signals.`;
const ORDER = [ECTO, NEURAL, MESO, MUSCLE, VESSEL, ENDO, STEM];   // legend: skin to core, grouped by family
const LOG_LINES = 4;                                             // live line + 3 frozen
const NARRATE_MS = 250;                                          // narrator at 4 Hz
const CAMERA_LABEL = { specimen: 'Specimen', close: 'Close', map: 'Map' };
const QUALITY_LABEL = { auto: 'Auto', high: 'High', medium: 'Medium', low: 'Low' };
const GITHUB = 'https://github.com/yamcomnet/embryo-engine';
const SVGNS = 'http://www.w3.org/2000/svg';

// Stroke icons, 16×16, currentColor.
const ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6l7.6-4.8z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.2" y="3.4" width="2.4" height="9.2" rx=".6" fill="currentColor"/><rect x="9.4" y="3.4" width="2.4" height="9.2" rx=".6" fill="currentColor"/></svg>',
  step: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 3.6v8.8l6.4-4.4z" fill="currentColor"/><rect x="10.9" y="3.6" width="1.7" height="8.8" rx=".5" fill="currentColor"/></svg>',
  reset: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.3 8.2a4.7 4.7 0 1 0 1.5-3.6"/><path d="M4.6 2.2v2.6h2.6"/></svg>',
  share: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 9.4l2.8-2.8"/><path d="M8.6 4.4l1.2-1.2a2.3 2.3 0 0 1 3.2 3.2l-1.2 1.2"/><path d="M7.4 11.6l-1.2 1.2a2.3 2.3 0 0 1-3.2-3.2l1.2-1.2"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  more: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>',
};

// ─── tiny DOM helpers ────────────────────────────────────────────────────────────────────────────────
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;             // static icon markup only
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}
const setText = (el, s) => { if (el.__t !== s) { el.__t = s; el.textContent = s; } };
const setAttr = (el, k, v) => { const s = String(v); if (el.getAttribute(k) !== s) el.setAttribute(k, s); };
const toggle = (el, cls, on) => { if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on); };
const show = (el, on) => { if (el.hidden === !!on) el.hidden = !on; };
const focusVisible = (el) => { try { return el.matches(':focus-visible'); } catch { return true; } };
const typeWord = (t) => TYPE_NAMES[t].toLowerCase();

/** Section head: small-caps title, hairline rule, optional aside (key hint or count). */
function head(text, id, ...aside) {
  return h('div', { class: 'ee-head' }, h('h2', { id }, text), h('span', { class: 'ee-head__rule', 'aria-hidden': 'true' }), ...aside);
}

/** Parts → DOM (tissue words coloured, numbers bold ink, rule names in display italic). */
function partsNodes(parts) {
  return parts.map((p) => {
    if (p.k === 'num') return h('b', { class: 'ee-n' }, p.v);
    if (p.k === 'tissue') return h('span', { class: `ee-tw ee-tw--${p.type}` }, p.v);
    if (p.k === 'rule') return h('em', { class: 'ee-rule' }, p.v);
    return document.createTextNode(p.v);
  });
}
const partsKey = (parts) => parts.map((p) => p.k[0] + p.v).join('\u0001');

/** Roving tabindex + arrow keys for a group of buttons. `select` makes selection follow focus (radios). */
function roving(container, selector, { select = null, keys = 'both' } = {}) {
  container.addEventListener('keydown', (e) => {
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    const items = [...container.querySelectorAll(selector)].filter((b) => !b.disabled && !b.hidden && b.offsetParent !== null);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const fwd = keys === 'h' ? ['ArrowRight'] : keys === 'v' ? ['ArrowDown'] : ['ArrowRight', 'ArrowDown'];
    const back = keys === 'h' ? ['ArrowLeft'] : keys === 'v' ? ['ArrowUp'] : ['ArrowLeft', 'ArrowUp'];
    let j = null;
    if (fwd.includes(e.key)) j = (i + 1) % items.length;
    else if (back.includes(e.key)) j = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    if (j === null) return;
    e.preventDefault();
    for (const b of items) b.tabIndex = -1;
    items[j].tabIndex = 0;
    items[j].focus({ preventScroll: true });
    items[j].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (select) select(items[j]);
  });
}
function syncRoving(items, activeIndex) {
  const k = activeIndex >= 0 ? activeIndex : 0;
  items.forEach((b, i) => { const t = i === k ? 0 : -1; if (b.tabIndex !== t) b.tabIndex = t; });
}

function resolveRoot(root) {
  if (root && root.id === 'hud') return root;
  const existing = document.getElementById('hud');
  if (existing) return existing;
  const el = h('div', { id: 'hud' });
  (root || document.body).append(el);
  return el;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
export function createHud(root, { dispatch } = {}) {
  const hud = resolveRoot(root);
  hud.textContent = '';
  hud.classList.add('ee-hud');
  // the ? button beckons until the guide has been opened once (remembered per browser)
  let guideSeen = false;
  try { guideSeen = localStorage.getItem('ee.guide.seen') === '1'; } catch { /* private mode: it beckons each visit */ }
  hud.classList.toggle('is-guide-new', !guideSeen);
  const send = (a) => { if (dispatch) dispatch(a); };
  const cleanups = [];
  const listen = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };

  let st = {};                 // last AppState
  let stats = null;            // last Stats
  let liveTick = 0;            // last tick seen while not viewing a snapshot
  let lastLiveStatsTick = -1;  // the same, -1 until the first live stats (a share link's first push is no jump)
  let seedSeen = null;
  const narrator = createNarrator();
  let history = [];            // frozen log lines, newest first: { kind:'story'|'ms', key, tick, parts }
  let live = null;             // { id, parts, group }
  let lastNarrate = -Infinity;
  let lastAria = -Infinity;
  let pendingMs = new Map();   // milestone key → tick, waiting for its milestoneStats to arrive
  let msKnown = null;          // Map key → tick of milestones already reflected in the log
  let progressExplicit = null; // setProgress() value (state.progress also works)
  let seenMask = 0;            // tissues that have been above 0 in this run (live): the legend says "not yet" until then

  // ─── title ───────────────────────────────────────────────────────────────────────────────────────────
  const metaVersion = h('span', {}, 'Engine v1.0');
  const metaSeed = h('span', {}, 'Seed —');
  const subtitle = h('p', { class: 'ee-sub' }, SUBTITLE(0));
  const title = h('header', { class: 'ee-title' },
    h('h1', { class: 'ee-wordmark' }, h('span', {}, 'Embryo'), ' ', h('em', {}, 'Engine')),
    h('p', { class: 'ee-meta' }, h('span', {}, 'Darkfield'), metaVersion, metaSeed),
    subtitle);

  // ─── specimen log ────────────────────────────────────────────────────────────────────────────────────
  const logStatus = h('span', { class: 'ee-status' }, h('i', { class: 'ee-status__dot', 'aria-hidden': 'true' }), h('span', {}, 'preparing'));
  const logToggle = h('button', { class: 'ee-log__toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'ee-log-list', 'aria-label': 'Show earlier log lines' }, h('span', { html: ICON.more }));
  const logList = h('ol', { class: 'ee-log__list', id: 'ee-log-list' });
  const logSec = h('section', { class: 'ee-log', 'aria-labelledby': 'ee-log-h' }, head('Specimen log', 'ee-log-h', logStatus, logToggle), logList);
  function setLogExpanded(on) {
    toggle(logSec, 'is-expanded', on);
    setAttr(logToggle, 'aria-expanded', !!on);
    setAttr(logToggle, 'aria-label', on ? 'Hide earlier log lines' : 'Show earlier log lines');
  }
  listen(logToggle, 'click', () => setLogExpanded(!logSec.classList.contains('is-expanded')));
  // on phones the whole log line is the toggle, both ways (a click never follows a scroll of the expanded list)
  listen(logList, 'click', (e) => { if (mobile && !e.target.closest('a, button')) setLogExpanded(!logSec.classList.contains('is-expanded')); });

  // ─── legend: composition (tissue) or a field ramp ────────────────────────────────────────────────────
  const legendTitle = h('h2', { id: 'ee-legend-h' }, 'Composition');
  const legendAside = h('span', { class: 'ee-head__aside' });
  const barSegs = ORDER.map((t) => h('i', { class: 'ee-bar__seg', style: `background:${TISSUE_HEX[t]}` }));
  const bar = h('div', { class: 'ee-bar', role: 'img', 'aria-label': 'Composition' }, barSegs);
  const rowEls = {};
  const rowButtons = ORDER.map((t) => {
    const count = h('span', { class: 'ee-row__n' }, '—');
    const pct = h('span', { class: 'ee-row__p' }, '');
    const b = h('button', {
      class: `ee-row ee-row--${t}`, type: 'button', 'aria-pressed': 'false', tabindex: '-1', dataset: { type: t },
      'aria-label': TYPE_NAMES[t], onclick: () => send(isolateAction(t)),
    }, h('i', { class: `ee-sw ${t === STEM ? 'ee-sw--round' : ''}`, style: `--c:${TISSUE_HEX[t]}`, 'aria-hidden': 'true' }),
    h('span', { class: 'ee-row__name' }, TYPE_NAMES[t]), count, pct);
    rowEls[t] = { b, count, pct };
    return b;
  });
  // §G.4 names the payload `isolate{type|null}`, which collides with the action's own `type` key, so the tissue
  // travels as `isolate` (and `tissue`, an alias). Clicking the isolated row again clears it.
  function isolateAction(t) {
    const next = st.isolate === t ? null : t;
    return { type: 'isolate', isolate: next, tissue: next };
  }
  const rowList = h('div', { class: 'ee-rows', role: 'group', 'aria-label': 'Isolate a tissue; press again to show all' }, rowButtons);
  roving(rowList, '.ee-row', { keys: 'both' });   // ←/→ move too: they must never fall through to "step" 
  const tissueBox = h('div', { class: 'ee-legend__tissue' }, bar, rowList);
  const fieldBox = h('div', { class: 'ee-legend__field', hidden: true });
  const legendSec = h('section', { class: 'ee-legend', 'aria-labelledby': 'ee-legend-h' },
    h('div', { class: 'ee-head' }, legendTitle, h('span', { class: 'ee-head__rule', 'aria-hidden': 'true' }), legendAside),
    tissueBox, fieldBox);

  // not a landmark of its own: its two sections are already the named regions "Specimen log" and "Composition"
  const leftCard = h('div', { class: 'ee-card ee-left' }, logSec, legendSec);

  // ─── stains rail, layers, camera ─────────────────────────────────────────────────────────────────────
  const STAIN_TITLE = { ap: 'Anterior–posterior (head–tail) signal' };
  const stainBtns = VIEWS.map((v) => h('button', {
    class: 'ee-stain', type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', 'aria-keyshortcuts': v.key,
    title: STAIN_TITLE[v.id] ?? null, 'aria-description': STAIN_TITLE[v.id] ?? null,
    dataset: { view: v.id }, onclick: () => send({ type: 'view', id: v.id }),
  }, h('i', { class: 'ee-radio', 'aria-hidden': 'true' }), h('span', { class: 'ee-stain__name' }, v.label),
  h('i', { class: 'ee-stain__ramp', style: `background:${previewCss(v.id)}`, 'aria-hidden': 'true' }),
  h('kbd', { 'aria-hidden': 'true' }, v.key)));
  const stainGroup = h('div', { class: 'ee-stains', role: 'radiogroup', 'aria-labelledby': 'ee-stains-h' },
    h('p', { class: 'ee-sublabel', 'aria-hidden': 'true' }, 'Cells'), stainBtns.slice(0, 4),
    h('p', { class: 'ee-sublabel', 'aria-hidden': 'true' }, 'Signals'), stainBtns.slice(4));
  roving(stainGroup, '.ee-stain', { select: (b) => send({ type: 'view', id: b.dataset.view }) });
  const stainsBlock = h('div', { class: 'ee-block ee-block--stains' }, head('Stains', 'ee-stains-h', h('kbd', { class: 'ee-head__aside', 'aria-hidden': 'true' }, '1–8')), stainGroup);

  const segBtn = (label, data, onclick) => h('button', { class: 'ee-seg__b', type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', dataset: data, onclick },
    h('i', { class: 'ee-radio', 'aria-hidden': 'true' }), h('span', {}, label));
  const layerBtns = [
    segBtn('Together', { on: '0' }, () => send({ type: 'explode', on: false })),
    segBtn('Apart', { on: '1' }, () => send({ type: 'explode', on: true })),
  ];
  const layerGroup = h('div', { class: 'ee-seg', role: 'radiogroup', 'aria-labelledby': 'ee-layers-h' }, layerBtns);
  roving(layerGroup, '.ee-seg__b', { select: (b) => send({ type: 'explode', on: b.dataset.on === '1' }) });
  const layersBlock = h('div', { class: 'ee-block' }, head('Layers', 'ee-layers-h', h('kbd', { class: 'ee-head__aside', 'aria-hidden': 'true' }, 'X')), layerGroup);

  const camBtns = CAMERA_PRESETS.map((p) => segBtn(CAMERA_LABEL[p] ?? p, { preset: p }, () => send({ type: 'camera', preset: p })));
  const camGroup = h('div', { class: 'ee-seg ee-seg--3', role: 'radiogroup', 'aria-labelledby': 'ee-camera-h' }, camBtns);
  roving(camGroup, '.ee-seg__b', { select: (b) => send({ type: 'camera', preset: b.dataset.preset }) });
  const reframe = h('button', { class: 'ee-link', type: 'button', hidden: true, 'aria-keyshortcuts': 'F', onclick: () => send({ type: 'frame' }) }, 'Re-frame and follow ', h('kbd', { 'aria-hidden': 'true' }, 'F'));
  const cameraBlock = h('div', { class: 'ee-block' }, head('Camera', 'ee-camera-h', h('kbd', { class: 'ee-head__aside', 'aria-hidden': 'true' }, 'C')), camGroup, reframe);

  const rail = h('section', { class: 'ee-card ee-rail', 'aria-label': 'Display: stains, layers and camera' }, stainsBlock, layersBlock, cameraBlock);

  // ─── transport ───────────────────────────────────────────────────────────────────────────────────────
  const btn = (cls, label, icon, onclick, extra = {}) => h('button', { class: `ee-btn ${cls}`, type: 'button', 'aria-label': label, title: extra.title ?? label, html: icon, onclick, ...extra.attrs });
  const playBtn = btn('ee-btn--play', 'Run', ICON.play, () => send({ type: 'toggleRun' }), { title: 'Run / pause · Space', attrs: { 'aria-pressed': 'false', 'aria-keyshortcuts': 'Space' } });
  const stepBtn = btn('', 'Step one tick', ICON.step, () => send({ type: 'step', n: 1 }), { title: 'Step one tick · .', attrs: { 'aria-keyshortcuts': '.' } });
  const resetBtn = btn('', 'Reset to tick 0, same seed', ICON.reset, () => send({ type: 'reset' }), { title: 'Reset, same seed · R', attrs: { 'aria-keyshortcuts': 'R' } });
  const slower = h('button', { class: 'ee-btn ee-btn--ghost', type: 'button', 'aria-label': 'Slower', title: 'Slower · −', onclick: () => send({ type: 'speedDelta', delta: -1 }), html: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' });
  const faster = h('button', { class: 'ee-btn ee-btn--ghost', type: 'button', 'aria-label': 'Faster', title: 'Faster · +', onclick: () => send({ type: 'speedDelta', delta: 1 }), html: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8M8 4v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' });
  const speedVal = h('b', {}, '60');
  const speedUnit = h('small', {}, 't/s');
  const speedSpin = h('span', {
    class: 'ee-speed__val', role: 'spinbutton', tabindex: '0', 'aria-label': 'Speed', title: 'Ticks per second: one tick is one step of the rules', 'aria-valuemin': '0',
    'aria-valuemax': String(SPEEDS.length - 1), 'aria-valuenow': '3', 'aria-valuetext': '60 ticks per second',
  }, speedVal, speedUnit);
  const speedActual = h('span', { class: 'ee-speed__actual', hidden: true });
  listen(speedSpin, 'keydown', (e) => {
    const map = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    if (map[e.key]) { e.preventDefault(); send({ type: 'speedDelta', delta: map[e.key] }); }
    else if (e.key === 'Home') { e.preventDefault(); send({ type: 'speed', index: 0 }); }
    else if (e.key === 'End') { e.preventDefault(); send({ type: 'speed', index: SPEEDS.length - 1 }); }
  });
  const speedGroup = h('div', { class: 'ee-speed', role: 'group', 'aria-label': 'Speed' }, slower, speedSpin, faster, speedActual);
  const playGroup = h('div', { class: 'ee-tp__play', role: 'group', 'aria-label': 'Playback' }, playBtn, stepBtn, resetBtn);

  // timeline
  const tlDecades = h('div', { class: 'ee-tl__decades', 'aria-hidden': 'true' });
  const tlPast = h('i', { class: 'ee-tl__past' });
  const tlAxis = h('div', { class: 'ee-tl__axis', 'aria-hidden': 'true' }, tlPast);
  const tlMarks = h('div', { class: 'ee-tl__marks' });
  // the playhead moves at 10 Hz: a full-width wrapper translated by x% (of its own width = the track), so each
  // push is a compositor-only transform, never a layout
  const tlHead = h('i', { class: 'ee-tl__headpos', 'aria-hidden': 'true' }, h('i', { class: 'ee-tl__head' }));
  const tlViewing = h('i', { class: 'ee-tl__viewing', 'aria-hidden': 'true', hidden: true });
  const tlAwait = h('button', { class: 'ee-tl__await', type: 'button', tabindex: '-1', 'aria-describedby': 'ee-pop' });
  const tlTrack = h('div', { class: 'ee-tl__track' }, tlAxis, tlMarks, tlViewing, tlHead);
  const timeline = h('div', { class: 'ee-tl', role: 'group', 'aria-label': 'Milestones on a log-time axis' }, tlDecades, h('div', { class: 'ee-tl__row' }, tlTrack, tlAwait));
  roving(timeline, '.ee-tl__mark, .ee-tl__await', { keys: 'h' });

  // stats line
  const sTick = h('b', {}, 'T 0');
  const sCells = h('span', {}, '0');
  const sSigma = h('b', {}, '—');
  const sCons = h('span', { class: 'ee-stat__cons' }, 'conserved');
  const sBirth = h('span', {}, '0.0');
  const sDeath = h('span', {}, '0.0');
  const statLine = h('p', { class: 'ee-statline' },
    h('span', { class: 'ee-stat' }, sTick),
    h('span', { class: 'ee-stat' }, sCells, ' cells'),
    h('span', { class: 'ee-stat ee-stat--sigma', title: 'Total energy, conserved by the law' }, 'Σ ', sSigma, ' ', sCons),
    h('span', { class: 'ee-stat ee-stat--rates', title: 'Per tick, averaged over the last 200 ticks' }, 'births ', sBirth, '/t · deaths ', sDeath, '/t'));

  const shareBtn = btn('ee-btn--ghost', 'Copy a link to this seed and tick', ICON.share, () => send({ type: 'share' }), { title: 'Copy link' });
  const helpBtn = h('button', { class: 'ee-btn ee-btn--help', type: 'button', 'aria-label': 'Guide and settings', title: 'Guide and settings · ?', 'aria-haspopup': 'dialog', 'aria-keyshortcuts': '?', onclick: () => send({ type: 'help', open: true }) }, h('span', { 'aria-hidden': 'true' }, '?'));
  const moreBtn = h('button', { class: 'ee-btn ee-btn--more', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'ee-drawer', 'aria-label': 'More controls' },
    h('span', { class: 'ee-btn__txt', 'aria-hidden': 'true' }, 'More'), h('span', { class: 'ee-btn__ico', html: ICON.more }));
  const chips = h('div', { class: 'ee-chips' });
  const drawerActs = h('div', { class: 'ee-drawer__acts' },
    h('button', { class: 'ee-action', type: 'button', 'aria-haspopup': 'dialog', onclick: () => send({ type: 'help', open: true }) }, h('span', { class: 'ee-action__q', 'aria-hidden': 'true' }, '?'), 'Guide and settings'),
    h('button', { class: 'ee-action', type: 'button', onclick: () => send({ type: 'share' }) }, 'Copy link'));
  const drawer = h('div', { class: 'ee-drawer', id: 'ee-drawer', hidden: true });
  listen(moreBtn, 'click', () => {
    const on = drawer.hidden;
    show(drawer, on);
    setAttr(moreBtn, 'aria-expanded', on);
    toggle(transport, 'is-open', on);
    if (on) setLogExpanded(false);   // the expanded log would sit over the drawer
  });

  const TRANSPORT_LABEL = 'Playback and timeline', TRANSPORT_LABEL_M = 'Playback, timeline and display';
  const transport = h('section', { class: 'ee-card ee-transport', 'aria-label': TRANSPORT_LABEL },
    h('div', { class: 'ee-tp__ctl' }, playGroup, h('span', { class: 'ee-vr', 'aria-hidden': 'true' }), speedGroup),
    h('div', { class: 'ee-tp__time' }, timeline, statLine),
    h('div', { class: 'ee-tp__aux' }, shareBtn, helpBtn, moreBtn),
    chips, drawer);

  // ─── overlays: banner, toast, progress, inspector, popover, live region, cards ──────────────────────
  const bannerTick = h('b', {}, '');
  const bannerLabel = h('span', {}, '');
  const banner = h('div', { class: 'ee-card ee-banner', role: 'status', hidden: true },
    h('span', { class: 'ee-banner__k' }, 'Viewing'), bannerTick, h('span', { class: 'ee-banner__sep', 'aria-hidden': 'true' }, '·'), bannerLabel,
    h('span', { class: 'ee-banner__acts' },
      h('button', { class: 'ee-action', type: 'button', 'aria-keyshortcuts': 'L', onclick: () => send({ type: 'live' }) }, 'Back to live ', h('kbd', { 'aria-hidden': 'true' }, 'L')),
      h('button', { class: 'ee-action ee-action--primary', type: 'button', 'aria-keyshortcuts': 'Enter', onclick: () => send({ type: 'resume' }) }, 'Resume here ', h('kbd', { 'aria-hidden': 'true' }, '⏎'))));

  const toast = h('div', { class: 'ee-toast', role: 'status', hidden: true });
  let toastTimer = 0;

  // Fast-forward (share link): the bar is the progressbar; the card also carries the time left and a Stop button (a
  // progressbar's children are presentational, so the button sits beside it, not inside).
  const progText = h('span', {}, '');
  const progPct = h('b', {}, '');
  const progFill = h('i', {});
  const progEta = h('span', { class: 'ee-progress__eta' }, '');
  const progStop = h('button', { class: 'ee-action ee-progress__stop', type: 'button', 'aria-keyshortcuts': 'Space Escape',
    title: TOUCH ? 'Stop here' : 'Stop here · Space or Esc', onclick: () => send({ type: 'pause' }) }, 'Stop', h('kbd', { 'aria-hidden': 'true' }, 'Space'));
  const progBar = h('div', { class: 'ee-progress__meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Fast-forward' },
    h('div', { class: 'ee-progress__row' }, progText, progPct), h('div', { class: 'ee-progress__bar' }, progFill));
  const progress = h('div', { class: 'ee-card ee-progress', hidden: true }, progBar, h('div', { class: 'ee-progress__foot' }, progEta, progStop));

  // inspector callout
  const leader = document.createElementNS(SVGNS, 'svg');
  leader.setAttribute('class', 'ee-insp__leader');
  leader.setAttribute('aria-hidden', 'true');
  const leaderLine = document.createElementNS(SVGNS, 'polyline');
  const leaderDot = document.createElementNS(SVGNS, 'circle');
  leaderDot.setAttribute('r', '3');
  const leaderRing = document.createElementNS(SVGNS, 'circle');
  leaderRing.setAttribute('r', '6.5');
  leaderRing.setAttribute('class', 'ee-insp__ring');
  leader.append(leaderLine, leaderRing, leaderDot);
  const iType = h('span', { class: 'ee-insp__type' });
  const iSw = h('i', { class: 'ee-sw', 'aria-hidden': 'true' });
  const iXY = h('span', { class: 'ee-insp__xy' });
  const iTick = h('span', { class: 'ee-insp__tick' });
  const iClose = h('button', { class: 'ee-btn ee-btn--x', type: 'button', 'aria-label': 'Unpin cell', html: ICON.close, hidden: true, onclick: () => send({ type: 'pin', idx: null }) });
  const iDepth = h('dd', {});
  const iEnergyBar = h('i', { class: 'ee-meter__fill' });
  const iEnergyTxt = h('span', {});
  const iLifeBar = h('i', { class: 'ee-meter__fill' });
  const iLifeTxt = h('span', {});
  const iSignals = h('dd', { class: 'ee-insp__sigs' });
  const iStory = h('p', { class: 'ee-insp__story' });
  const meter = (fill, txt, mark) => h('dd', { class: 'ee-insp__meter' }, h('span', { class: 'ee-meter' }, fill, mark ? h('i', { class: 'ee-meter__mark', style: `left:${mark}%` }) : null), txt);
  const inspPlate = h('div', { class: 'ee-card ee-insp__plate', role: 'group', 'aria-label': 'Cell inspector' },
    h('div', { class: 'ee-insp__head' }, iSw, iType, iXY, iTick, iClose),
    h('dl', { class: 'ee-insp__rows' },
      h('div', {}, h('dt', {}, 'Depth'), iDepth),
      h('div', {}, h('dt', {}, 'Energy'), meter(iEnergyBar, iEnergyTxt, 50)),
      h('div', {}, h('dt', {}, 'Life'), meter(iLifeBar, iLifeTxt, 85)),
      h('div', {}, h('dt', {}, 'Signals'), iSignals)),
    iStory);
  const insp = h('aside', { class: 'ee-insp', 'aria-label': 'Cell inspector', hidden: true }, leader, inspPlate);
  let inspDetail = null, inspAnchor = null;
  let plateSize = null;        // the plate's size, measured once per content change (not per anchor move)
  let panelRects = null;       // the panels' rects from the last footprint() (see rectOf)

  const pop = h('div', { class: 'ee-card ee-pop', id: 'ee-pop', role: 'tooltip', hidden: true });
  const popCanvas = h('canvas', { class: 'ee-pop__thumb', width: '256', height: '256' });
  const popTitle = h('b', { class: 'ee-pop__t' });
  const popTick = h('span', { class: 'ee-pop__tick' });
  const popNote = h('p', { class: 'ee-pop__note' });
  const popHint = h('span', { class: 'ee-pop__hint' });
  const popBar = h('div', { class: 'ee-bar ee-pop__bar', 'aria-hidden': 'true' });
  const popRow = h('div', { class: 'ee-pop__row' }, popTitle, popTick);
  const popBody = h('div', { class: 'ee-pop__body' }, popRow, popNote, popBar, popHint);
  pop.append(popCanvas, popBody);

  const live1 = h('div', { class: 'ee-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const overlay = h('div', { class: 'ee-overlay', hidden: true });

  // help dialog
  const dialog = h('dialog', { id: 'help', class: 'ee-card ee-help', 'aria-labelledby': 'ee-help-h' });
  let helpBuiltFor = '';
  let returnFocus = null;
  listen(dialog, 'cancel', (e) => { e.preventDefault(); send({ type: 'help', open: false }); });
  listen(dialog, 'close', () => { if (st.helpOpen) send({ type: 'help', open: false }); });
  listen(dialog, 'click', (e) => { if (e.target === dialog) send({ type: 'help', open: false }); }); // backdrop click
  listen(dialog, 'keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...dialog.querySelectorAll('button, a[href], [tabindex="0"]')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // ─── left panel fit (desktop) ──────────────────────────────────────────────────────────────────────────
  // The legend never shrinks; when the panel is taller than the room it has, the older log lines give way, one
  // whole entry at a time from the oldest; then the live line is clamped; the panel scrolls only as a last resort.
  let fitRaf = 0;
  function fitLeft() {
    fitRaf = 0;
    const olds = [...logList.querySelectorAll('.ee-entry.is-old')];
    for (const li of olds) li.classList.remove('is-fit-hidden');
    logSec.classList.remove('is-tight');
    if (mobile || leftCard.hidden) return;             // the phone log has its own collapsed / expanded layout
    const over = () => leftCard.scrollHeight > leftCard.clientHeight + 1;
    for (let i = olds.length - 1; i >= 0 && over(); i--) olds[i].classList.add('is-fit-hidden');
    const txt = over() && logList.querySelector('.ee-entry.is-live .ee-entry__text');
    if (txt) {
      // clamp the live line to the lines that fit (at least 3); what is clipped stays in the DOM for screen readers
      const lh = parseFloat(getComputedStyle(txt).lineHeight) || 19;
      const lines = Math.round(txt.scrollHeight / lh);
      const keep = Math.max(3, lines - Math.ceil((leftCard.scrollHeight - leftCard.clientHeight) / lh));
      if (keep < lines) { logSec.style.setProperty('--clamp', String(keep)); logSec.classList.add('is-tight'); }
    }
  }
  function fitLeftSoon() { if (!fitRaf) fitRaf = requestAnimationFrame(fitLeft); }
  const fitRO = typeof ResizeObserver === 'function' ? new ResizeObserver(fitLeftSoon) : null;
  if (fitRO) { fitRO.observe(leftCard); fitRO.observe(legendSec); fitRO.observe(logList); cleanups.push(() => fitRO.disconnect()); }

  // ─── assemble + responsive re-flow ───────────────────────────────────────────────────────────────────
  const top = h('div', { class: 'ee-top' }, title);
  const col = h('div', { class: 'ee-col' }, top, leftCard);
  // DOM (and Tab) order follows the screen: title and log, then the viewing banner and progress at top centre, then
  // the rail and the transport
  hud.append(col, banner, progress, rail, transport, toast, insp, pop, live1, overlay, dialog);

  const mq = window.matchMedia(MOBILE_MQ);
  const mqShort = window.matchMedia('(max-height: 499px)');
  let mobile = null;
  function layout() {
    toggle(hud, 'is-short', mqShort.matches);
    const m = mq.matches;
    if (m === mobile) return;
    mobile = m;
    toggle(hud, 'is-mobile', m);
    setAttr(transport, 'aria-label', m ? TRANSPORT_LABEL_M : TRANSPORT_LABEL);
    if (m) {
      top.append(logSec, banner, progress);
      chips.append(stainGroup);
      drawer.append(drawerActs, legendSec, layersBlock, cameraBlock);   // the guide first, then the colour key
      show(leftCard, false); show(rail, false);
    } else {
      leftCard.append(logSec, legendSec);
      rail.before(banner, progress);
      stainsBlock.append(stainGroup);
      rail.append(stainsBlock, layersBlock, cameraBlock);
      drawerActs.remove();
      show(leftCard, true); show(rail, true);
      show(drawer, false); setAttr(moreBtn, 'aria-expanded', false); toggle(transport, 'is-open', false);
      setLogExpanded(false);
    }
    plateSize = null; panelRects = null;
    if (inspDetail) placeInspector();
    fitLeftSoon();
  }
  layout();
  listen(mq, 'change', layout);
  listen(mqShort, 'change', layout);
  let resizeRaf = 0;
  listen(window, 'resize', () => {
    plateSize = null; panelRects = null;
    if (inspDetail) placeInspector();
    hidePop();
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => renderTimeline(true));
  });

  // ═══ render(state) ═══════════════════════════════════════════════════════════════════════════════════
  const memo = {};
  const changed = (key, val) => { if (memo[key] === val) return false; memo[key] = val; return true; };

  function render(state) {
    st = state || {};
    toggle(hud, 'is-reduced', !!st.reducedMotion);
    toggle(hud, 'is-viewing', !!st.viewing);
    toggle(hud, 'is-q-low', st.quality?.tier === 'low');

    // title
    if (changed('seed', st.seed)) setText(metaSeed, st.seed === undefined || st.seed === null ? 'Seed —' : `Seed ${st.seed}`);
    if (changed('ver', st.engineVersion)) setText(metaVersion, st.engineVersion ? `Engine v${String(st.engineVersion).replace(/^(\d+\.\d+)\.0$/, '$1')}` : 'Engine v1.0');
    if (changed('seedCount', st.seedCount)) setText(subtitle, SUBTITLE(st.seedCount));

    // new run → clear the log
    if (st.seed !== seedSeen) {
      if (seedSeen !== null) resetLog();
      seedSeen = st.seed;
    }

    // run state
    if (st.running && st.ready && !st.viewing && !st.progress) maybeFirstHint();
    if (changed('running', !!st.running)) {
      playBtn.innerHTML = st.running ? ICON.pause : ICON.play;
      setAttr(playBtn, 'aria-pressed', !!st.running);
      playBtn.title = st.running ? 'Pause · Space' : 'Run · Space';
    }
    renderStatus();
    // the run controls wait for the engine and the 3D scene: a run before the scene exists would play out unseen
    const live = !!st.ready && !!st.stageReady && !st.error;
    if (changed('ctlLive', live)) {
      for (const b of [playBtn, stepBtn, resetBtn]) b.disabled = !live;
      const i = st.speedIndex ?? 3;
      slower.disabled = i <= 0 || !live; faster.disabled = i >= SPEEDS.length - 1 || !live;
      if (!liveLi) renderLog();            // the placeholder line says what is still loading
    }

    // speed
    if (changed('speed', st.speedIndex)) {
      const i = st.speedIndex ?? 3, tps = SPEEDS[i];
      setText(speedVal, fmtSpeed(tps));
      toggle(speedUnit, 'is-hidden', tps === 0);
      setAttr(speedSpin, 'aria-valuenow', i);
      setAttr(speedSpin, 'aria-valuetext', tps === 0 ? 'as fast as possible' : `${fmtSpeed(tps)} ticks per second`);
      const ok = !!st.ready && !!st.stageReady && !st.error;
      slower.disabled = i <= 0 || !ok; faster.disabled = i >= SPEEDS.length - 1 || !ok;
    }

    // stains
    const viewChanged = changed('view', st.view);
    if (viewChanged) {
      const vi = VIEW_INDEX[st.view] ?? 0;
      stainBtns.forEach((b, i) => setAttr(b, 'aria-checked', i === vi));
      syncRoving(stainBtns, vi);
    }
    // the field legends read FIELD_INFO: rebuild when it arrives, not only when the view changes
    const infoChanged = changed('fieldInfo', st.fieldInfo ?? null);
    if (viewChanged || infoChanged) renderLegendMode();
    if (changed('isolate', st.isolate ?? null)) {
      for (const t of ORDER) {
        setAttr(rowEls[t].b, 'aria-pressed', st.isolate === t);
        toggle(rowEls[t].b, 'is-dim', st.isolate >= 1 && st.isolate !== t);
      }
      const k = ORDER.indexOf(st.isolate);
      syncRoving(rowButtons, k);
      toggle(bar, 'is-isolating', st.isolate >= 1);
      barSegs.forEach((s, i) => toggle(s, 'is-dim', st.isolate >= 1 && ORDER[i] !== st.isolate));
    }

    // layers + camera
    if (changed('exploded', !!st.exploded)) {
      layerBtns.forEach((b) => setAttr(b, 'aria-checked', (b.dataset.on === '1') === !!st.exploded));
      syncRoving(layerBtns, st.exploded ? 1 : 0);
    }
    if (changed('camera', st.camera)) {
      const ci = CAMERA_PRESETS.indexOf(st.camera);
      camBtns.forEach((b, i) => setAttr(b, 'aria-checked', i === ci));
      syncRoving(camBtns, ci);
    }
    show(reframe, st.autoFrame === false);

    // viewing banner
    const v = st.viewing;
    if (changed('viewing', v ? `${v.snapId}:${v.tick}:${v.key ?? ''}` : '')) {
      show(banner, !!v);
      if (v && mobile) setLogExpanded(false);
      if (v) {
        setText(bannerTick, fmtTick(v.tick));
        setText(bannerLabel, v.key ? (MILESTONES.find((m) => m.key === v.key)?.label ?? v.key) : 'Snapshot');
      }
      lastNarrate = -Infinity;  // re-narrate now
      renderTimeline(true);
    }

    // milestones → log lines, timeline (main replaces these arrays when they change, so identity is enough to skip)
    if (st.milestones !== memo.msRef || st.snapshots !== memo.snRef) {
      memo.msRef = st.milestones; memo.snRef = st.snapshots;
      trackMilestones(st.milestones);
      if (changed('msSig', milestoneSig(st.milestones) + '|' + snapshotSig(st.snapshots))) renderTimeline(true);
    }

    // context sentence follows the viewer immediately (view, apart, isolate, viewing)
    const ctxKey = `${st.view}|${!!st.exploded}|${st.isolate ?? ''}|${v ? v.snapId : ''}`;
    if (changed('ctxKey', ctxKey) && stats) narrateNow(true);

    // progress, help, errors
    renderProgress();
    renderHelp();
    if (st.error && changed('error', st.error)) showError(st.error);
    if (!st.error && memo.error) { memo.error = null; if (overlay.dataset.kind === 'error') { show(overlay, false); overlay.textContent = ''; } }

    // pinned state of the inspector
    if (changed('pinned', st.pinned ?? null)) {
      const pinned = inspDetail && st.pinned === inspDetail.idx;
      show(iClose, !!pinned);
      toggle(insp, 'is-pinned', !!pinned);
      if (st.pinned === null || st.pinned === undefined) { if (st.hover === null || st.hover === undefined) setInspector(null, null); }
    }
  }

  function renderStatus() {
    const s = st.error ? 'stopped' : !st.ready || !st.stageReady ? 'preparing' : st.viewing ? 'snapshot' : (st.progress || progressExplicit) ? 'fast-forward' : st.running ? 'live' : 'paused';
    if (changed('status', s)) {
      setText(logStatus.lastChild, s);
      logStatus.dataset.s = s;
    }
  }

  // ─── specimen log ────────────────────────────────────────────────────────────────────────────────────
  function resetLog() {
    history = []; live = null; narrator.reset(); pendingMs.clear(); msKnown = null; lastNarrate = -Infinity; seenMask = 0;
    renderLog();
  }

  function milestoneSig(ms) { return (ms || []).map((m) => `${m.key}:${m.tick ?? ''}:${m.snapId ?? ''}:${m.thumb ? 1 : 0}`).join(','); }
  function snapshotSig(sn) { return (sn || []).map((s) => `${s.snapId}:${s.tick}`).join(','); }

  function trackMilestones(ms) {
    if (!ms) return;
    const now = new Map(ms.filter((m) => typeof m.tick === 'number').map((m) => [m.key, m.tick]));
    const firstSight = msKnown === null;
    // first sight (fresh page or share link): log what has been reached, oldest first, but say nothing
    if (firstSight) msKnown = new Map();
    const quiet = firstSight || fastForwarding();   // a fast-forward gets one summary at its end
    for (const [key, tick] of [...now].sort((a, b) => a[1] - b[1])) {
      if (msKnown.get(key) === tick) continue;
      msKnown.set(key, tick);
      pendingMs.set(key, tick);
      if (key !== 'seed' && !quiet) queueMilestoneAnnounce(key, tick);
    }
    // milestones removed (resume from an earlier snapshot deletes later ones): forget them, and their log lines
    for (const key of [...msKnown.keys()]) {
      if (now.has(key)) continue;
      msKnown.delete(key); pendingMs.delete(key);
      history = history.filter((e) => !(e.kind === 'ms' && e.key === key));
      msAnnounce = msAnnounce.filter((x) => x.key !== key);
    }
    flushMilestones();
  }

  // Worker messages for milestones that fire together arrive a frame or two apart: gather them for 400 ms and say
  // them in one sentence, so one never cuts off another.
  let msAnnounce = [], msAnnounceTimer = 0;
  function queueMilestoneAnnounce(key, tick) {
    msAnnounce.push({ key, tick, label: MILESTONES.find((m) => m.key === key)?.label ?? key });
    clearTimeout(msAnnounceTimer);
    msAnnounceTimer = setTimeout(() => {
      msAnnounceTimer = 0;
      const list = msAnnounce; msAnnounce = [];
      if (!list.length || fastForwarding()) return;     // a fast-forward started meanwhile: its summary says it
      const tick = Math.max(...list.map((x) => x.tick));
      announce(`${list.length > 1 ? 'Milestones reached' : 'Milestone reached'}: ${list.map((x) => x.label).join(', ')} (${fmtTick(tick)})`, 'milestone');
    }, 400);
  }

  function flushMilestones() {
    if (!stats || !pendingMs.size) return;
    let added = false;
    for (const [key, tick] of [...pendingMs].sort((a, b) => a[1] - b[1])) {
      const ctx = narrCtx();
      let parts;
      try { parts = milestoneLine(key, stats, st, ctx); } catch { continue; } // wait for its milestoneStats
      pendingMs.delete(key);
      history = history.filter((e) => !(e.kind === 'ms' && e.key === key));
      history.push({ kind: 'ms', key, tick, parts });
      added = true;
    }
    if (added) { history.sort(byTickDesc); history.length = Math.min(history.length, 24); renderLog(); }
  }
  // newest first; at the same tick the milestone line sits above the story line
  function byTickDesc(a, b) { return b.tick - a.tick || (a.kind === b.kind ? 0 : a.kind === 'ms' ? -1 : 1); }

  const narrCtx = () => ({ params: st.params, fieldInfo: st.fieldInfo, milestoneStats: stats?.milestoneStats });

  let narrateTimer = 0, holdTimer = 0;
  function narrateNow(force = false) {
    if (!stats || !st.params) return;
    const now = performance.now();
    if (!force && now - lastNarrate < NARRATE_MS) {
      // trailing call, so the sentence matches the last stats (e.g. right after a pause)
      if (!narrateTimer) narrateTimer = setTimeout(() => { narrateTimer = 0; narrateNow(true); }, NARRATE_MS - (now - lastNarrate) + 5);
      return;
    }
    clearTimeout(narrateTimer); narrateTimer = 0;
    lastNarrate = now;
    const ctx = narrCtx();
    let next;
    try {
      if (st.viewing) next = narrateContext(stats, st, ctx);
      else {
        const res = narrator.update(stats, st, ctx, now, st.reducedMotion ? 6000 : 3000);
        clearTimeout(holdTimer); holdTimer = 0;
        if (res.waitMs > 0) holdTimer = setTimeout(() => { holdTimer = 0; narrateNow(true); }, res.waitMs + 20);
        if (res.frozen) {
          // stamped with the tick it describes; kept in time order with the milestone lines
          history.push({ kind: 'story', key: res.frozen.id, tick: res.frozen.tick, parts: res.frozen.parts });
          history.sort(byTickDesc);
          history.length = Math.min(history.length, 24);
        }
        next = res.context ?? res.story;
        if (res.frozen) renderLog();
      }
    } catch (err) {
      if (!narrateNow.warned) { narrateNow.warned = true; console.warn('[hud] narrator:', err.message); }
      return;
    }
    if (!next) return;
    const idChanged = !live || live.id !== next.id;
    // a story sentence carries the tick it describes; a context sentence describes the stats on screen
    live = { id: next.id, group: next.group, parts: next.parts, tick: next.group === 'context' ? stats.tick : next.tick };
    renderLiveLine(idChanged);
    // Only what the viewer caused is spoken (a new view, Apart, isolate, a snapshot): the rotating story would talk
    // over everything, all run long. It stays readable in the log.
    if (idChanged && next.group === 'context') announce(partsText(next.parts), 'context');
    else if (idChanged) annQueue = annQueue.filter((q) => q.kind !== 'context');   // back to the story: drop a stale view
  }

  let liveLi = null;
  function renderLiveLine(fresh) {
    if (!liveLi || fresh) { renderLog(); return; }
    const p = liveLi.querySelector('.ee-entry__text');
    const key = partsKey(live.parts);
    if (p.__k !== key) { p.__k = key; p.replaceChildren(...partsNodes(live.parts)); }
    setText(liveLi.querySelector('.ee-entry__t'), fmtTick(live.tick ?? (stats ? stats.tick : 0)));
  }

  function entryLi(e, cls) {
    const text = h('p', { class: 'ee-entry__text' }, partsNodes(e.parts));
    text.__k = partsKey(e.parts);
    return h('li', { class: `ee-entry ${cls}` },
      h('span', { class: 'ee-entry__t' }, fmtTick(e.tick)),
      h('i', { class: `ee-entry__node ${e.kind === 'ms' ? 'is-ms' : ''}`, 'aria-hidden': 'true' }),
      text);
  }

  function renderLog() {
    const items = [];
    if (live) {
      liveLi = entryLi({ kind: 'story', tick: live.tick ?? (stats ? stats.tick : 0), parts: live.parts }, `is-live ${live.group === 'context' ? 'is-context' : ''} is-new`);
      items.push(liveLi);
    } else {
      liveLi = null;
      items.push(h('li', { class: 'ee-entry is-live is-placeholder' }, h('span', { class: 'ee-entry__t' }, ''), h('i', { class: 'ee-entry__node', 'aria-hidden': 'true' }),
        h('p', { class: 'ee-entry__text' }, st.error ? 'The simulation stopped.' : st.ready && !st.stageReady ? 'Loading the 3D scene…' : 'Preparing the specimen…')));
    }
    const liveTickNow = stats ? stats.tick : 0;
    history.filter((e) => st.viewing || e.tick <= liveTickNow).slice(0, mobile ? 8 : LOG_LINES - 1)
      .forEach((e, i) => items.push(entryLi(e, `is-old is-old-${i + 1}`)));
    logList.replaceChildren(...items);
    if (liveLi) requestAnimationFrame(() => liveLi && liveLi.classList.remove('is-new'));
    fitLeftSoon();
  }

  // ─── legend ──────────────────────────────────────────────────────────────────────────────────────────
  let field = null; // { view, facts: {key: el}, marks..., hist }
  function renderLegendMode() {
    const view = st.view || 'cells';
    const isTissue = view === 'cells';
    show(tissueBox, isTissue);
    show(fieldBox, !isTissue);
    if (isTissue) {
      setText(legendTitle, 'Composition');
      field = null;
      fieldBox.textContent = '';
    } else buildField(view);
    if (stats) updateLegend();
    fitLeftSoon();
  }

  function fieldInfoFor(view) {
    const ch = VIEWS[VIEW_INDEX[view]]?.channel;
    return (st.fieldInfo || []).find((f) => f.channel === ch || f.key === view) || null;
  }

  function factRow(label, cls = '') {
    const dd = h('dd', {}, '—');
    return [h('div', { class: `ee-fact ${cls}` }, h('dt', {}, label), dd), dd];
  }

  function buildField(view) {
    fieldBox.textContent = '';
    field = { view, facts: {} };
    const facts = h('dl', { class: 'ee-facts' });
    const addFact = (key, label, cls) => { const [row, dd] = factRow(label, cls); facts.append(row); field.facts[key] = dd; };
    const label = VIEWS[VIEW_INDEX[view]]?.label ?? view;

    if (view === 'depth') {
      setText(legendTitle, 'Depth bands');
      const rows = [1, 2, 3, 4].map((b) => {
        const range = h('span', { class: 'ee-row__range' });
        const count = h('span', { class: 'ee-row__n' });
        const row = h('div', { class: 'ee-row ee-row--static' },
          h('i', { class: `ee-sw ${b === 4 ? 'ee-sw--round' : ''}`, style: `--c:${BAND_HEX[b]}`, 'aria-hidden': 'true' }),
          h('span', { class: 'ee-row__name' }, BAND_LABELS[b], h('span', { class: 'ee-row__fate' }, ` → ${typeWord([0, ECTO, MESO, ENDO, STEM][b])}`)), range, count);
        return { row, range, count };
      });
      field.bands = rows;
      fieldBox.append(h('p', { class: 'ee-legend__what' }, 'Steps from the outside, as fractions of the deepest cell’s depth'),
        h('div', { class: 'ee-rows ee-rows--static' }, rows.map((r) => r.row)), facts);
      addFact('dmax', 'Deepest cell now');
      addFact('match', 'Carry their band’s fate');
      return;
    }

    let stops, what, ticks = [], gates = [];
    const info = fieldInfoFor(view);
    if (view === 'energy') {
      stops = RAMPS.energy; what = 'Energy ÷ division threshold';
      ticks = [[0, '0'], [0.5, '1 · threshold'], [1, '2+']];
      setText(legendTitle, 'Energy');
    } else if (view === 'age') {
      stops = RAMPS.age; what = 'Share of lifespan used';
      ticks = [[0, '0'], [0.5, '½'], [1, 'end']];
      gates = [{ pos: 0.85, label: 'old, soon to die', v: 0.85 }];
      setText(legendTitle, 'Age');
    } else {
      stops = Object.hasOwn(RAMPS, view) ? RAMPS[view] : RAMPS.midline;   // a bad id gives a wrong legend, never a throw
      const dom = info?.domain ?? [0, 1];
      what = `${label} signal · ${info?.scale === 'sqrt' ? '√ scale' : 'linear'}`;
      ticks = [[0, fmtSig(dom[0])], [1, fmtSig(dom[1])]];
      if (info?.scale === 'sqrt') ticks.splice(1, 0, [fieldPos(dom[1] / 4, info), fmtSig(dom[1] / 4)]);
      else ticks.splice(1, 0, [0.5, fmtSig(dom[1] / 2)]);
      gates = (info?.gates ?? []).map((g) => ({ ...g, pos: fieldPos(g.v, info) }));
      setText(legendTitle, label);
    }
    fieldBox.append(h('p', { class: 'ee-legend__what' }, what));

    if (view === 'energy') {
      const bins = Array.from({ length: 24 }, (_, i) => h('i', { style: `--c:${sampleRamp(RAMPS.energy, (i + 0.5) / 24)}` }));
      field.hist = bins;
      fieldBox.append(h('div', { class: 'ee-hist', 'aria-hidden': 'true' }, bins));
    }
    // caret and gates are full-width layers translated by x% of the ramp: moving them is a transform, not a layout
    const caret = h('i', { class: 'ee-ramp__caretpos', hidden: true }, h('i', { class: 'ee-ramp__caret' }));
    field.caret = caret;
    const gateEls = gates.map((g) => {
      const el = h('i', { class: 'ee-ramp__gate', style: `transform:translateX(${(g.pos * 100).toFixed(2)}%)` });
      const val = h('b', {}, typeof g.v === 'number' ? `${typeof g.rel === 'number' ? '≈ ' : ''}${fmtSig(g.v)}` : '');
      const label = String(g.label ?? '').replace(/^./, (c) => c.toUpperCase());
      const key = h('li', {}, h('i', { 'aria-hidden': 'true' }), h('span', {}, label), val);
      return { g, el, val, key };
    });
    field.gates = gateEls;
    fieldBox.append(
      h('div', { class: 'ee-ramp' }, h('i', { class: 'ee-ramp__bar', style: `background:${rampCss(stops)}` }), gateEls.map((x) => x.el), caret),
      h('div', { class: 'ee-ramp__ticks', 'aria-hidden': 'true' }, ticks.map(([p, t]) => h('span', { style: `left:${(p * 100).toFixed(2)}%` }, t))),
      ...(gateEls.length ? [h('ul', { class: 'ee-gates' }, gateEls.map((x) => x.key))] : []),
      facts);
    field.info = info;

    if (view === 'energy') {
      addFact('ready', 'Above threshold'); addFact('readyStem', 'Stem above threshold'); addFact('readyDiff', 'Others above threshold');
      addFact('room', 'With room to divide now', 'ee-fact--gold'); addFact('mean', 'Mean energy');
    }
    else if (view === 'age') { addFact('old', 'Past 85% of lifespan'); addFact('deaths', 'Deaths by age, last window'); }
    else if (view === 'midline' || view === 'ap') { addFact('max', 'Peak now'); addFact('competent', 'Outer cells past both gates'); addFact('neural', 'Neural cells'); }
    else if (view === 'activator') { addFact('max', 'Peak now'); addFact('mean', 'Tissue mean'); addFact('mesoMax', 'Highest in mesoderm'); addFact('muscle', 'Muscle · vessel'); }
    else if (view === 'inhibitor') { addFact('max', 'Peak now'); addFact('muscle', 'Muscle · vessel'); }
  }

  function sampleRamp(stops, t) {
    let i = 0;
    while (i < stops.length - 2 && stops[i + 1][0] < t) i++;
    const [p0, c0] = stops[i], [p1, c1] = stops[i + 1];
    const f = Math.min(1, Math.max(0, (t - p0) / (p1 - p0 || 1)));
    const a = parseInt(c0.slice(1), 16), b = parseInt(c1.slice(1), 16);
    const mix = (s) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
    return `rgb(${mix(16)},${mix(8)},${mix(0)})`;
  }

  function updateLegend() {
    const s = stats;
    const n = s.cellCount || 0;
    if (!field) {
      setText(legendAside, `${fmtInt(n)} cells`);
      let acc = 0;
      ORDER.forEach((t, i) => {
        const c = s.typeCounts[t] || 0;
        const w = n ? (100 * c) / n : 0;
        const g = w.toFixed(2);
        if (barSegs[i].__g !== g) { barSegs[i].__g = g; barSegs[i].style.flexGrow = g; }
        toggle(barSegs[i], 'is-zero', c === 0);
        acc += c;
        const r = rowEls[t];
        const none = t !== STEM && c === 0 && !(seenMask & (1 << t));   // not formed yet in this run: no "0 · 0%" row
        setText(r.count, none ? 'not yet' : fmtInt(c));
        setText(r.pct, none ? '' : `${fmtPct(w)}%`);
        toggle(r.b, 'is-none', none);
      });
      // accessible text: the rows keep a fixed name (a focused control that renames itself is re-announced by
      // screen readers); the numbers live in a description refreshed at 1 Hz, and the bar's label at 1 Hz
      throttle1Hz('bar', writeBarLabel);
      throttle1Hz('rows', writeRowDescriptions);
      return;
    }
    const f = field.facts;
    const set = (k, v) => { if (f[k]) setText(f[k], v); };
    switch (field.view) {
      case 'depth': {
        const { e1, e2, e3 } = s.geom.bands;
        const span = (a, b) => (b > a ? `${a}–${b}` : `${a}`);
        const ranges = [span(1, e1), span(e1 + 1, e2), span(e2 + 1, e3 - 1), `≥ ${e3}`];
        field.bands.forEach((r, i) => { setText(r.range, ranges[i]); setText(r.count, fmtInt(s.bands.counts[i + 1] || 0)); });
        setText(legendAside, `${fmtInt(s.geom.dmax)} deep`);
        set('dmax', `${fmtInt(s.geom.dmax)} steps`);
        set('match', `${fmtPct(s.bands.matchPct)}%`);
        break;
      }
      case 'energy': {
        const hs = s.energy.histStem, hd = s.energy.histDiff;
        let max = 1;
        for (let i = 0; i < 24; i++) max = Math.max(max, (hs[i] || 0) + (hd[i] || 0));
        field.hist.forEach((b, i) => {
          const v = `scaleY(${Math.max(0.03, Math.sqrt(((hs[i] || 0) + (hd[i] || 0)) / max)).toFixed(3)})`;
          if (b.__v !== v) { b.__v = v; b.style.transform = v; }
        });
        setText(legendAside, `Σ ${fmtE(s.energy.total)}`);
        set('ready', fmtInt(s.energy.ready));
        set('readyStem', `${fmtInt(s.energy.readyStem)} · > ${fmtInt(s.energy.thrStem)}`);
        set('readyDiff', `${fmtInt(s.energy.readyDiff)} · > ${fmtInt(s.energy.thrDiff)}`);
        set('room', typeof s.energy.readyRoom === 'number' ? fmtInt(s.energy.readyRoom) : '—');
        set('mean', fmtE(s.energy.mean));
        break;
      }
      case 'age':
        setText(legendAside, `${fmtInt(n)} cells`);
        set('old', fmtInt(s.age.old));
        set('deaths', fmtInt(s.win.deathsByCause[0]));
        break;
      default: {
        const key = { midline: 'maxMid', ap: 'maxAP', activator: 'maxAct', inhibitor: 'maxInh' }[field.view];
        const max = s.signals[key];
        const info = field.info;
        if (info) {
          show(field.caret, true);
          field.caret.style.transform = `translateX(${(fieldPos(max, info) * 100).toFixed(2)}%)`;
          field.caret.firstChild.title = `peak now ${fmtSig(max)}`;
        }
        // relative gates (activator) move with the live tissue mean
        for (const { g, el, val } of field.gates) {
          if (typeof g.rel === 'number' && info) {
            const v = g.rel * s.signals.meanAct;       // at the tissue-wide mean; the rule uses each depth's own mean
            el.style.transform = `translateX(${(fieldPos(v, info) * 100).toFixed(2)}%)`;
            setText(val, `≈ ${fmtSig(v)}`);
          }
        }
        setText(legendAside, info ? `0–${fmtSig(info.domain[1])}` : '');
        set('max', fmtSig(max));
        set('competent', fmtInt(s.signals.neuralCompetent));
        set('neural', fmtInt(s.typeCounts[NEURAL]));
        set('mean', fmtSig(s.signals.meanAct));
        set('mesoMax', fmtSig(s.signals.maxMesoAct));
        set('muscle', `${fmtInt(s.typeCounts[MUSCLE])} · ${fmtInt(s.typeCounts[VESSEL])}`);
      }
    }
  }
  // ─── accessible labels at 1 Hz, leading + trailing (the last skipped update is always written) ──────────
  const lastAt = {}, trailing = {};
  function throttle1Hz(key, fn) {
    const t = performance.now(), since = t - (lastAt[key] ?? -1e9);
    if (since >= 1000) { clearTimeout(trailing[key]); trailing[key] = 0; lastAt[key] = t; fn(); return; }
    if (!trailing[key]) trailing[key] = setTimeout(() => { trailing[key] = 0; lastAt[key] = performance.now(); fn(); }, 1000 - since + 5);
  }
  function writeNow(key, fn) { clearTimeout(trailing[key]); trailing[key] = 0; lastAt[key] = performance.now(); fn(); }
  function writeBarLabel() {
    const s = stats;
    if (!s) return;
    const n = s.cellCount || 0;
    setAttr(bar, 'aria-label', `Composition: ${ORDER.map((t) => `${typeWord(t)} ${fmtPct(n ? (100 * s.typeCounts[t]) / n : 0)}%`).join(', ')}`);
  }
  function writeRowDescriptions() {
    const s = stats;
    if (!s) return;
    const n = s.cellCount || 0;
    for (const t of ORDER) {
      const b = rowEls[t].b;
      if (b === document.activeElement) continue;      // never change what a focused row says
      const c = s.typeCounts[t] || 0;
      setAttr(b, 'aria-description', t !== STEM && c === 0 && !(seenMask & (1 << t)) ? 'not formed yet' : `${fmtInt(c)} cells, ${fmtPct(n ? (100 * c) / n : 0)} percent`);
    }
  }
  function writeCanvasLabel() {
    const s = stats;
    const c = document.getElementById('stage');
    if (!s || !c) return;
    const n = s.cellCount || 1;
    const top = [1, 2, 3, 4, 5, 6, 7].map((t) => [t, s.typeCounts[t]]).filter(([, c2]) => c2 > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
    setAttr(c, 'aria-label', `Tick ${fmtInt(s.tick)}, ${fmtInt(s.cellCount)} cells: ${top.map(([t, c2]) => `${fmtPct((100 * c2) / n)}% ${typeWord(t)}`).join(', ')}.`);
  }

  // ─── timeline ────────────────────────────────────────────────────────────────────────────────────────
  let axisMax = 20000;
  let trackW = 0;
  const trackRO = typeof ResizeObserver === 'function'
    ? new ResizeObserver((es) => { const w = Math.round(es[es.length - 1].contentRect.width); if (w !== trackW) { trackW = w; renderTimeline(true); } })
    : null;
  if (trackRO) { trackRO.observe(tlTrack); cleanups.push(() => trackRO.disconnect()); }
  let markEls = [];
  const u = (t) => Math.log10(1 + Math.max(0, t)) / Math.log10(1 + axisMax);
  const DECADES = [[0, '0'], [10, '10'], [100, '100'], [1000, '1k'], [10000, '10k'], [100000, '100k'], [1000000, '1M']];

  function renderTimeline(rebuild = false) {
    const newMax = Math.max(20000, 1.25 * liveTick);
    const axisChanged = newMax > axisMax * 1.02 || newMax < axisMax / 1.02;
    if (axisChanged) axisMax = newMax;
    if (rebuild || axisChanged) {
      tlDecades.replaceChildren(...DECADES.filter(([t]) => t <= axisMax).map(([t, l]) => h('span', { style: `left:${(u(t) * 100).toFixed(2)}%` }, l)));
      const focusedKey = document.activeElement?.dataset?.mk;
      const marks = [];
      for (const m of st.milestones || []) {
        if (typeof m.tick !== 'number') continue;
        marks.push({ kind: 'ms', key: m.key, tick: m.tick, snapId: m.snapId, label: m.label, thumb: m.thumb });
      }
      for (const s of st.snapshots || []) {
        if (s.kind === 'milestone' || marks.some((m) => m.snapId === s.snapId)) continue;
        marks.push({ kind: 'kf', key: `kf${s.snapId}`, tick: s.tick, snapId: s.snapId, label: 'Snapshot' });
      }
      marks.sort((a, b) => a.tick - b.tick);
      const stageKey = (st.milestones || []).filter((m) => typeof m.tick === 'number').sort((a, b) => b.tick - a.tick)[0]?.key;
      markEls = marks.map((m) => {
        const viewing = st.viewing && st.viewing.snapId === m.snapId;
        const b = h('button', {
          class: `ee-tl__mark ee-tl__mark--${m.kind} ${viewing ? 'is-viewing' : ''} ${m.key === stageKey ? 'is-stage' : ''}`,
          type: 'button', tabindex: '-1', dataset: { mk: m.key },
          'aria-label': `${m.label}, ${fmtTick(m.tick)}${m.snapId ? ', view snapshot' : ''}`,
          'aria-describedby': 'ee-pop', 'aria-current': viewing ? 'true' : null,
          style: `left:${(u(m.tick) * 100).toFixed(3)}%`,
          onclick: () => viewMark(m),
          // focus opens the popover only when it came from the keyboard: a tap re-focuses the rebuilt mark, and
          // the popover would then stay over the banner's buttons
          onpointerenter: () => showPop(b, m), onpointerleave: hidePop, onfocus: () => { if (focusVisible(b)) showPop(b, m); }, onblur: hidePop,
        }, h('i', { 'aria-hidden': 'true' }));
        b.__m = m;
        return b;
      });
      tlMarks.replaceChildren(...markEls);
      // milestones that fire close together would stack on a log axis: keep a minimum gap (the popover and the
      // accessible name carry the exact tick)
      const W = trackW || (trackW = tlTrack.clientWidth);   // kept by a ResizeObserver: no layout read per rebuild
      if (W > 0) {
        const gap = mobile ? 24 : 12;   // phones: the mark's full 24 px target, so neighbours never overlap
        let last = -Infinity;
        for (const b of markEls) {
          if (b.__m.kind !== 'ms') continue;
          const x = Math.max(u(b.__m.tick) * W, last + gap);
          last = x;
          b.style.left = `${x.toFixed(1)}px`;
        }
      }
      const rov = [...markEls, tlAwait];
      const vi = markEls.findIndex((b) => b.classList.contains('is-viewing'));
      const fi = markEls.findIndex((b) => b.dataset.mk === focusedKey);
      syncRoving(rov, vi >= 0 ? vi : fi >= 0 ? fi : Math.max(0, markEls.length - 1));
      if (fi >= 0) markEls[fi].focus();
      const awaiting = (st.milestones || []).filter((m) => typeof m.tick !== 'number');
      show(tlAwait, awaiting.length > 0);
      setText(tlAwait, mobile ? `+${awaiting.length}` : `${awaiting.length} to come`);
      setAttr(tlAwait, 'aria-label', `${awaiting.length} ${awaiting.length === 1 ? 'milestone' : 'milestones'} still to come: ${awaiting.map((m) => m.label).join(', ')}`);
      tlAwait.onpointerenter = () => showAwaiting(awaiting); tlAwait.onpointerleave = hidePop;
      tlAwait.onfocus = () => { if (focusVisible(tlAwait)) showAwaiting(awaiting); }; tlAwait.onblur = hidePop;
      tlAwait.onclick = () => showAwaiting(awaiting);
    }
    const x = u(liveTick) * 100;
    const hx = `translateX(${x.toFixed(3)}%)`, px = `scaleX(${(x / 100).toFixed(5)})`;
    if (tlHead.__x !== hx) { tlHead.__x = hx; tlHead.style.transform = hx; }
    if (tlPast.__x !== px) { tlPast.__x = px; tlPast.style.transform = px; }
    if (st.viewing) {
      show(tlViewing, true);
      const vx = `${(u(st.viewing.tick) * 100).toFixed(3)}%`;
      if (tlViewing.__x !== vx) { tlViewing.__x = vx; tlViewing.style.left = vx; }
    } else show(tlViewing, false);
  }

  function viewMark(m) {
    if (!m.snapId && m.kind === 'ms') return;
    hidePop();
    if (m.kind === 'ms') send({ type: 'milestone', key: m.key, snapId: m.snapId });
    else send({ type: 'viewSnapshot', snapId: m.snapId });
  }

  // clicking the bare track snaps to the nearest snapshot
  listen(tlTrack, 'pointerdown', (e) => {
    if (e.target.closest('.ee-tl__mark') || !markEls.length) return;
    const r = tlTrack.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    let best = null, bd = Infinity;
    for (const b of markEls) { const d = Math.abs(u(b.__m.tick) - x); if (d < bd && b.__m.snapId) { bd = d; best = b.__m; } }
    if (best && bd < 0.06) viewMark(best);
  });

  function placePop(anchorEl) {
    show(pop, true);
    const a = anchorEl.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const vw = window.innerWidth;
    let left = a.left + a.width / 2 - pw / 2;
    left = Math.max(8, Math.min(vw - pw - 8, left));
    const topPx = Math.max(8, transport.getBoundingClientRect().top - ph - 10);
    // phones: the viewing banner already names the milestone; never cover its Back to live / Resume buttons
    if (mobile && !banner.hidden) {
      const bb = banner.getBoundingClientRect();
      if (topPx < bb.bottom && topPx + ph > bb.top) { show(pop, false); return; }
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${topPx}px`;
    pop.style.setProperty('--arrow', `${a.left + a.width / 2 - left}px`);
  }

  function showPop(anchorEl, m) {
    const thumb = m.thumb ?? (st.milestones || []).find((x) => x.key === m.key)?.thumb;
    toggle(pop, 'has-thumb', !!thumb || m.kind === 'ms');
    const ctx = popCanvas.getContext('2d');
    ctx.fillStyle = '#050605';
    ctx.fillRect(0, 0, 256, 256);
    if (thumb) { ctx.imageSmoothingEnabled = false; ctx.drawImage(thumb, 0, 0, 256, 256); }
    show(popCanvas, m.kind === 'ms');
    toggle(popCanvas, 'is-empty', !thumb);
    setText(popTitle, m.label);
    setText(popTick, fmtTick(m.tick));
    // the milestone's own log line and its captured composition (milestoneStats), or a keyframe note
    popNote.textContent = '';
    popNote.__t = undefined;
    popBar.hidden = true;
    if (m.kind === 'ms') {
      let parts = null;
      try { parts = milestoneNote(m.key, stats, st, narrCtx()); } catch { parts = null; }
      if (parts) popNote.replaceChildren(...partsNodes(parts));
      else popNote.textContent = MILESTONES.find((x) => x.key === m.key)?.awaiting ?? '';
      const tcs = stats?.milestoneStats?.[m.key]?.typeCounts;
      if (tcs) {
        const total = ORDER.reduce((a, t) => a + (tcs[t] || 0), 0) || 1;
        popBar.replaceChildren(...ORDER.filter((t) => tcs[t] > 0).map((t) => h('i', { style: `background:${TISSUE_HEX[t]};flex-grow:${(100 * tcs[t]) / total}` })));
        popBar.hidden = false;
      }
    } else popNote.textContent = 'A periodic snapshot of the run.';
    setText(popHint, m.snapId ? (st.viewing && st.viewing.snapId === m.snapId ? 'Viewing now' : TOUCH ? 'Tap to view' : 'Click to view · Enter') : 'No snapshot kept');
    popRow.replaceChildren(popTitle, popTick);
    pop.replaceChildren(popCanvas, popBody);
    placePop(anchorEl);
  }

  function showAwaiting(awaiting) {
    toggle(pop, 'has-thumb', false);
    // its own title node: the shared popTitle must stay in the milestone popover's row
    const list = h('ul', { class: 'ee-pop__list' }, awaiting.map((m) => h('li', {}, h('b', {}, m.label), ` ${m.awaiting}`)));
    pop.replaceChildren(h('div', { class: 'ee-pop__body' }, h('div', { class: 'ee-pop__row' }, h('b', { class: 'ee-pop__t' }, 'Still to come')), list));
    placePop(tlAwait);
  }
  function hidePop() { show(pop, false); }

  // ─── stats line ──────────────────────────────────────────────────────────────────────────────────────
  function updateStatLine(s) {
    setText(sTick, fmtTick(s.tick));
    setText(sCells, fmtInt(s.cellCount));
    setText(sSigma, fmtE(s.energy.total));
    const lost = s.energy.lost > 0;
    setText(sCons, lost ? `· ${fmtE(s.energy.lost)} lost` : 'conserved');
    toggle(statLine, 'is-lost', lost);
    const W = s.win.W || 1;
    setText(sBirth, (s.win.births / W).toFixed(1));
    setText(sDeath, (s.win.deaths / W).toFixed(1));
    // speed: show the measured rate when it differs by more than 5% (MAX always shows it)
    const tgt = SPEEDS[st.speedIndex ?? 3] ?? s.tps.target;
    const act = s.tps.actual;
    const differs = st.running && !st.viewing && act > 0 && (tgt === 0 || Math.abs(act - tgt) / tgt > 0.05);
    show(speedActual, differs);
    if (differs) setText(speedActual, `actual ${fmtInt(act)}`);
  }

  // More ticks between two stats pushes than the run could have made (≈0.6 s of running, stats come at 10 Hz).
  function jumpTicks(s) {
    const target = SPEEDS[st.speedIndex ?? 3];
    const rate = Math.max(s.tps?.actual || 0, target || 0);
    return 20 + (target === 0 ? Math.max(3000, 1.5 * rate) : 0.6 * rate);
  }

  // ═══ setStats ═════════════════════════════════════════════════════════════════════════════════════════
  function setStats(s, state) {
    if (state && state !== st) render(state);
    if (!s) return;
    stats = s;
    let jumped = false;
    // Compare with the last tick seen *live*: stats pushed while a snapshot is on screen carry the snapshot's tick,
    // and a resume from it must still read as going back in time.
    if (!st.viewing) {
      const prevLive = lastLiveStatsTick;
      if (prevLive >= 0 && s.tick < prevLive) {
        // reset or resume from an earlier snapshot: the future replays, so drop what the log said about it
        history = history.filter((e) => e.tick <= s.tick);
        narrator.reset(); live = null; lastNarrate = -Infinity; seenMask = 0;
        renderLog();
        jumped = true;
      } else if (prevLive >= 0 && s.tick - prevLive > jumpTicks(s)) {
        // a fast-forward (share link) jumped ahead: the held sentence describes a moment that was skipped
        narrator.reset(); live = null; lastNarrate = -Infinity;
        jumped = true;
      }
      lastLiveStatsTick = s.tick;
      liveTick = s.tick;
      for (let t = 1; t < 8; t++) if (s.typeCounts[t] > 0) seenMask |= 1 << t;
    }
    updateStatLine(s);
    updateLegend();
    if (liveLi && live && live.group === 'context') setText(liveLi.querySelector('.ee-entry__t'), fmtTick(s.tick));
    renderTimeline(false);
    flushMilestones();
    narrateNow(false);
    renderStatus();
    // after a jump, or while paused / stepping (stats are rare then), screen readers get the exact state now
    if (jumped || (!st.running && !st.progress)) { writeNow('canvas', writeCanvasLabel); writeNow('bar', writeBarLabel); }
    else throttle1Hz('canvas', writeCanvasLabel);
  }

  // ═══ inspector ═══════════════════════════════════════════════════════════════════════════════════════
  // The depth line agrees with the Depth legend: the band word is the band Rule 3 applies (after the ±1 hysteresis
  // margin), with a note when the cell's depth itself lies in the next band; terminal tissues keep their fate in their
  // home band and show no arrow.
  const HOME_BAND = { [NEURAL]: 1, [MUSCLE]: 2, [VESSEL]: 2 };
  function depthParts(d, P) {
    const dmax = stats?.geom?.dmax;
    const rb = typeof d.ruleBand === 'number' && d.ruleBand > 0 ? d.ruleBand : d.band;
    const word = (b) => (BAND_LABELS[b] ?? '—').replace(/ band$/, '').toLowerCase();
    const out = [h('b', {}, fmtInt(d.depth)), dmax ? ` of ${fmtInt(dmax)} · ` : ' · ', word(rb)];
    const heldNote = rb !== d.band && d.band > 0 ? ` · held by hysteresis (its depth is in the ${word(d.band)}${d.band === 4 ? '' : ' band'})` : '';
    const tw = (t) => h('span', { class: `ee-tw ee-tw--${t}` }, typeWord(t));
    const home = HOME_BAND[d.type];
    if (home) {
      const revert = P.hysteresis?.terminalRevert;
      if (rb === home || !(revert > 0)) out.push(' · ', tw(d.type), ', terminal (kept)');
      else {
        const left = Math.max(0, revert - (d.pending ?? 0));
        out.push(' → ', d.ruleFate ? tw(d.ruleFate) : '—', ` in ${fmtInt(left)} ${left === 1 ? 'tick' : 'ticks'}`);
      }
      out.push(heldNote);
      return out;
    }
    out.push(' → ', d.ruleFate ? tw(d.ruleFate) : '—', heldNote);
    if (d.ruleFate && d.ruleFate !== d.type) {
      // why it has not switched yet: too young to read its depth, or the reading has not persisted long enough
      const young = typeof P.diffAge === 'number' && d.age <= P.diffAge;
      const persist = P.hysteresis?.persist;
      if (young) out.push(` · waits until older than ${fmtInt(P.diffAge)} ticks`);
      else if (typeof persist === 'number' && typeof d.pending === 'number') out.push(` · switches after ${fmtInt(persist)} ticks in a row (${fmtInt(Math.min(d.pending, persist))} so far)`);
      else out.push(' · waiting');
    }
    return out;
  }

  function setInspector(detail, anchor) {
    inspDetail = detail || null;
    inspAnchor = anchor || null;
    if (!inspDetail) { show(insp, false); return; }
    const d = inspDetail;
    const P = st.params || {};
    setText(iType, TYPE_NAMES[d.type] ?? '—');
    iSw.style.setProperty('--c', TISSUE_HEX[d.type] ?? '#888');
    toggle(iSw, 'ee-sw--round', d.type === STEM);
    iType.className = `ee-insp__type ee-tw--${d.type}`;
    setText(iXY, `(${d.x}, ${d.y})`);
    setText(iTick, fmtTick(d.tick));
    iDepth.replaceChildren(...depthParts(d, P));
    const r = d.threshold > 0 ? d.energy / d.threshold : 0;
    iEnergyBar.style.width = `${Math.min(100, r * 50).toFixed(1)}%`;
    // above its threshold (and past the cooldown) is not enough: Rule 1 also needs an empty neighbouring place
    const canDivide = !!d.ready && d.hasRoom === true;
    toggle(iEnergyBar, 'is-ready', canDivide);
    const tag = !d.ready ? ''
      : d.hasRoom === true ? h('span', { class: 'ee-insp__tag is-room', title: 'Above its threshold, past its cooldown, and next to an empty place: it divides on its next turn' }, ' can divide')
        : d.hasRoom === false ? h('span', { class: 'ee-insp__tag', title: 'Above its division threshold, but every neighbouring place is taken: it waits' }, ' above · boxed in')
          : h('span', { class: 'ee-insp__tag', title: 'Above its division threshold; it divides when a neighbouring place is empty' }, ' above');
    iEnergyTxt.replaceChildren(h('b', {}, fmtE(d.energy)), ` / ${fmtInt(d.threshold)}`, tag);
    const f = d.maxAge > 0 ? d.age / d.maxAge : 0;
    iLifeBar.style.width = `${Math.min(100, f * 100).toFixed(1)}%`;
    toggle(iLifeBar, 'is-old', f > 0.85);
    iLifeTxt.replaceChildren(h('b', {}, fmtInt(d.age)), ` / ${fmtInt(d.maxAge)}`);
    iSignals.replaceChildren(...[['act', d.act], ['inh', d.inh], ['mid', d.mid], ['A–P', d.ap]]
      .map(([k, v]) => h('span', { class: 'ee-sig' }, h('i', {}, k), ' ', h('b', {}, fmtSig(v)))));
    let story = [];
    try { story = cellStory(d, { params: P, seedCount: st.seedCount }); } catch { story = []; }
    iStory.replaceChildren(...partsNodes(story));
    const pinned = st.pinned === d.idx;
    show(iClose, pinned);
    toggle(insp, 'is-pinned', pinned);
    if (mobile && insp.hidden) setLogExpanded(false);   // the plate and the expanded log would stack on a phone
    show(insp, true);
    plateSize = null;
    placeInspector();
  }
  function moveInspector(anchor) {
    inspAnchor = anchor || null;
    if (inspDetail && !insp.hidden) placeInspector();
  }

  function placeInspector() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const a = inspAnchor;
    const plate = inspPlate;
    if (mobile) {
      // no leader line on a phone, but the ring stays on the cell so the pinned one is marked in the scene
      leader.style.display = '';
      leaderLine.style.display = 'none'; leaderDot.style.display = 'none';
      const ringOn = !!(a && a.visible !== false);
      leaderRing.style.display = ringOn ? '' : 'none';
      if (ringOn) { leaderRing.setAttribute('cx', a.x); leaderRing.setAttribute('cy', a.y); }
      plate.style.left = ''; plate.style.right = '';
      const tp = transport.getBoundingClientRect().top;
      plate.style.bottom = `${Math.max(8, vh - tp + 8)}px`;
      if (hud.classList.contains('is-short')) {
        // landscape: a side panel between the log bar and the sheet, so the specimen stays in view
        const lb = logSec.getBoundingClientRect().bottom;
        plate.style.top = `${Math.round(Math.max(8, lb + 8))}px`;
      } else plate.style.top = '';
      return;
    }
    leaderLine.style.display = ''; leaderDot.style.display = ''; leaderRing.style.display = '';
    plate.style.bottom = '';
    if (!plateSize) plateSize = { w: plate.offsetWidth || 300, h: plate.offsetHeight || 180 };
    const pw = plateSize.w, ph = plateSize.h;
    if (!a || a.visible === false) {
      // anchor off screen: dock above the rail's bottom-right corner, no leader
      leader.style.display = 'none';
      plate.style.left = `${vw - pw - 28}px`;
      plate.style.top = `${Math.max(12, rectOf('transport').top - ph - 16)}px`;
      return;
    }
    leader.style.display = '';
    const D = 34, Hs = 26;                     // diagonal run and horizontal run of the leader, px
    const bottomLimit = rectOf('transport').top - 12;
    const sy = a.y - D - 18 > 12 ? -1 : 1;
    const ey = a.y + sy * D;
    const topPx = Math.max(12, Math.min(bottomLimit - ph, ey - 18));
    // side panels only matter where they overlap the plate vertically
    const overlapsY = (r) => r.width > 0 && topPx < r.bottom && topPx + ph > r.top;
    const lr = rectOf('left'), rr = rectOf('rail');
    const minX = overlapsY(lr) ? lr.right + 12 : 12;
    const maxX = overlapsY(rr) ? rr.left - 12 : vw - 12;
    let sx;
    if (a.x + D + Hs + pw <= maxX) sx = 1;
    else if (a.x - D - Hs - pw >= minX) sx = -1;
    else sx = maxX - a.x >= a.x - minX ? 1 : -1;
    const ex = a.x + sx * D;
    const px = ex + sx * Hs;
    let left = sx > 0 ? px : px - pw;
    left = Math.max(Math.min(minX, vw - pw - 12), Math.min(Math.max(maxX - pw, 12), left));
    plate.style.left = `${left}px`;
    plate.style.top = `${topPx}px`;
    const endX = sx > 0 ? left : left + pw;
    leaderLine.setAttribute('points', `${a.x},${a.y} ${ex},${ey} ${endX},${ey}`);
    leaderDot.setAttribute('cx', a.x); leaderDot.setAttribute('cy', a.y);
    leaderRing.setAttribute('cx', a.x); leaderRing.setAttribute('cy', a.y);
  }

  // ═══ hint, announce, progress ═══════════════════════════════════════════════════════════════════════
  // Once per viewer (this browser), the first time a run starts: how to inspect, and where the guide is.
  // A hint someone else set in the last 1.5 s (e.g. "Resumed from…") wins; an older one ("Press Space to start")
  // is out of date once the run starts. The viewer is marked as having seen it only when it was shown.
  let firstHintDone = false, lastHintAt = -1e9, firstHintTimer = 0;
  function maybeFirstHint() {
    if (firstHintDone) return;
    firstHintDone = true;
    let seen = false;
    try { seen = localStorage.getItem('ee.hint.inspect') === '1'; } catch { seen = false; }
    if (seen) return;
    const text = mobile ? 'Tap a cell to inspect it · More → Guide explains the colours' : 'Hover a cell to inspect it · click to pin · ? for the guide';
    firstHintTimer = setTimeout(() => {
      if (st.viewing || st.helpOpen || performance.now() - lastHintAt < 1500) return;
      try { localStorage.setItem('ee.hint.inspect', '1'); } catch { /* private mode: it shows again next visit */ }
      setHint(text, 6000);
    }, 600);
  }

  function setHint(text, ms = 6000) {
    lastHintAt = performance.now();
    clearTimeout(toastTimer);
    if (!text) { toggle(toast, 'is-in', false); show(toast, false); return; }
    toast.textContent = text;
    show(toast, true);
    requestAnimationFrame(() => toggle(toast, 'is-in', true));
    if (ms > 0) toastTimer = setTimeout(() => { toggle(toast, 'is-in', false); toastTimer = setTimeout(() => show(toast, false), 260); }, ms);
  }

  // The polite live region speaks one message at a time: a milestone stays for at least ~1 s + 0.3 s a word before
  // anything replaces it, and milestones go ahead of other messages. A context sentence (the view the user just
  // chose) replaces a waiting or showing older one at once: only the view the user is on now matters. So two
  // milestones never overwrite each other, and nothing important is cut off.
  let lastAnnounce = '', lastAnnounceAt = 0;
  let annQueue = [], annTimer = 0, annWriteTimer = 0, annFreeAt = 0, annShownKind = '';
  function announce(text, kind = 'status') {
    if (!text) return;
    const t = performance.now();
    if (text === lastAnnounce && t - lastAnnounceAt < 3000) return; // de-duplicate (main may announce milestones too)
    lastAnnounce = text; lastAnnounceAt = t;
    if (kind === 'context') annQueue = annQueue.filter((q) => q.kind !== 'context');
    const item = { text, kind };
    if (kind === 'milestone') { const i = annQueue.findIndex((q) => q.kind !== 'milestone'); annQueue.splice(i < 0 ? annQueue.length : i, 0, item); }
    else annQueue.push(item);
    if (kind === 'context' && annShownKind !== 'milestone') { clearTimeout(annTimer); annTimer = 0; }   // the user moved on
    pumpAnnounce();
  }
  function pumpAnnounce() {
    if (annTimer || !annQueue.length) return;
    const head = annQueue[0];
    const wait = head.kind === 'context' && annShownKind !== 'milestone' ? 0 : Math.max(0, annFreeAt - performance.now());
    annTimer = setTimeout(() => {
      annTimer = 0;
      const next = annQueue.shift();
      if (!next) return;
      const words = next.text.split(/\s+/).length;
      annFreeAt = performance.now() + Math.min(9000, 1000 + 300 * words);
      annShownKind = next.kind;
      clearTimeout(annWriteTimer);
      if (live1.textContent === next.text) {           // the same words again: clear first so they are re-read
        live1.textContent = '';
        annWriteTimer = setTimeout(() => { live1.textContent = next.text; }, 30);
      } else live1.textContent = next.text;
      pumpAnnounce();
    }, wait);
  }

  function setProgress(p) { progressExplicit = p || null; renderProgress(); }
  // A fast-forward (share link) is summed up once, half a second after it ends: the milestones it passed can still
  // be arriving from the worker, and none of them is announced on its own.
  let ffTarget = null, ffEndTimer = 0;
  function fastForwarding() { return !!(st.progress || progressExplicit) || ffTarget !== null; }
  // Time left from the rate between successive progress messages (smoothed); "≈ 2 h 20 min left".
  let ffLast = null, ffRate = 0;
  const fmtLeft = (sec) => {
    if (!(sec > 0) || !Number.isFinite(sec)) return '';
    if (sec < 2) return 'almost there';
    if (sec < 60) return `≈ ${Math.round(sec)} s left`;
    const m = Math.round(sec / 60);
    if (m < 60) return `≈ ${m} min left`;
    const hr = Math.floor(m / 60), mm = m % 60;
    return `≈ ${hr} h${mm ? ` ${mm} min` : ''} left`;
  };
  function renderProgress() {
    const p = progressExplicit || st.progress || null;
    show(progress, !!p);
    toggle(hud, 'is-ff', !!p);
    renderStatus();
    if (!p) {
      ffLast = null; ffRate = 0;
      if (ffTarget !== null && !ffEndTimer) {
        ffEndTimer = setTimeout(() => {
          ffEndTimer = 0;
          const reached = (st.milestones || []).filter((m) => typeof m.tick === 'number' && m.key !== 'seed').length;
          const at = stats && !st.viewing ? stats.tick : ffTarget;
          ffTarget = null;
          announce(`Fast-forwarded to ${fmtTick(at)}; ${reached} ${reached === 1 ? 'milestone' : 'milestones'} reached`, 'milestone');
        }, 500);
      }
      return;
    }
    clearTimeout(ffEndTimer); ffEndTimer = 0;
    ffTarget = p.target ?? ffTarget ?? 0;
    const pct = p.target > 0 ? Math.min(100, (100 * p.tick) / p.target) : 0;
    const now = performance.now();
    if (ffLast && p.tick > ffLast.tick && now > ffLast.t) {
      const r = ((p.tick - ffLast.tick) * 1000) / (now - ffLast.t);
      ffRate = ffRate ? ffRate + 0.3 * (r - ffRate) : r;
    }
    if (!ffLast || p.tick !== ffLast.tick) ffLast = { tick: p.tick, t: now };
    setText(progText, `Fast-forwarding to ${fmtTick(p.target)}`);
    // long jumps show a decimal, so the number visibly moves
    setText(progPct, p.target > 100000 && pct < 99.95 ? `${(Math.floor(pct * 10) / 10).toFixed(1)}%` : `${Math.floor(pct)}%`);
    setText(progEta, ffRate > 0 ? fmtLeft((p.target - p.tick) / ffRate) : '');
    progFill.style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
    setAttr(progBar, 'aria-valuenow', Math.floor(pct));
    setAttr(progBar, 'aria-valuetext', `${fmtTick(p.tick)} of ${fmtTick(p.target)}`);
  }

  // ═══ cards: fallback and error ══════════════════════════════════════════════════════════════════════
  function card(kind, ...kids) {
    overlay.dataset.kind = kind;
    overlay.replaceChildren(h('div', { class: 'ee-card ee-overlay__card', role: 'alertdialog', 'aria-labelledby': 'ee-ov-h', 'aria-describedby': 'ee-ov-d' }, ...kids));
    show(overlay, true);
    const f = overlay.querySelector('a, button');
    if (f) f.focus();
  }
  function showFallback(reason) {
    // 'webgl2' / 'module-worker' = the browser lacks a capability; anything else = the 3D scene failed to load
    const missing = !reason || reason === 'webgl2' || reason === 'module-worker';
    card('fallback',
      h('p', { class: 'ee-overlay__mark' }, h('span', {}, 'Embryo'), ' ', h('em', {}, 'Engine')),
      h('h2', { id: 'ee-ov-h' }, missing ? 'This version needs WebGL 2 and module workers.' : 'The 3D scene could not load.'),
      h('p', { id: 'ee-ov-d' }, missing
        ? 'Your browser can still run the original 2D version, with the same rules as they were in v0.9.'
        : 'This is often a network hiccup: reload to try again, or open the original 2D version.',
      reason ? h('span', { class: 'ee-overlay__reason' }, ` (${reason})`) : ''),
      h('div', { class: 'ee-overlay__acts' },
        missing ? null : h('button', { class: 'ee-action ee-action--primary', type: 'button', onclick: () => location.reload() }, 'Reload'),
        h('a', { class: `ee-action ${missing ? 'ee-action--primary' : ''}`, href: './classic.html' }, 'Open the classic 2D version →')));
  }
  function showError(message) {
    card('error',
      h('p', { class: 'ee-overlay__mark' }, h('span', {}, 'Embryo'), ' ', h('em', {}, 'Engine')),
      h('h2', { id: 'ee-ov-h' }, 'The simulation stopped.'),
      h('p', { id: 'ee-ov-d', class: 'ee-overlay__msg' }, String(message || 'Unknown error')),
      h('div', { class: 'ee-overlay__acts' },
        h('button', { class: 'ee-action ee-action--primary', type: 'button', onclick: () => location.reload() }, 'Reload'),
        h('a', { class: 'ee-action', href: './classic.html' }, 'Classic 2D version')));
    renderStatus();
  }

  // ═══ help dialog ════════════════════════════════════════════════════════════════════════════════════
  function renderHelp() {
    const open = !!st.helpOpen;
    if (open) {
      const sig = [st.engineVersion, st.seed, st.seedCount, !!st.params, st.quality?.mode, st.quality?.tier, st.quality?.dpr, !!st.reducedMotion].join('|');
      if (sig !== helpBuiltFor) {
        const scroll = dialog.querySelector('.ee-help__body')?.scrollTop ?? 0;
        const hadFocus = dialog.contains(document.activeElement) ? document.activeElement.dataset.fid : null;
        buildHelp();
        helpBuiltFor = sig;
        const body = dialog.querySelector('.ee-help__body');
        if (body && dialog.open) body.scrollTop = scroll;   // a rebuild while open keeps the reader's place
        if (hadFocus) dialog.querySelector(`[data-fid="${hadFocus}"]`)?.focus({ preventScroll: true });
      }
      if (!dialog.open) {
        returnFocus = document.activeElement;
        try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
        if (!guideSeen) {
          guideSeen = true;
          hud.classList.remove('is-guide-new');
          try { localStorage.setItem('ee.guide.seen', '1'); } catch { /* private mode */ }
        }
        // focus the scrolling body, from the top: arrow keys, Page Down and Space then read the guide in order
        const b = dialog.querySelector('.ee-help__body');
        if (b) { b.focus({ preventScroll: true }); b.scrollTop = 0; } else dialog.querySelector('#ee-help-h')?.focus();
      }
    } else if (dialog.open) {
      dialog.close();
      if (returnFocus && returnFocus.isConnected) returnFocus.focus(); else helpBtn.focus();
      returnFocus = null;
    }
  }

  function buildHelp() {
    const P = st.params || {};
    const E0 = P.totalEnergy;
    const fi = st.fieldInfo || [];
    const n = (v, f = fmtInt) => (typeof v === 'number' && Number.isFinite(v) ? h('b', { class: 'ee-n' }, f(v)) : h('b', { class: 'ee-n' }, '—'));
    const tw = (t, w) => h('span', { class: `ee-tw ee-tw--${t}` }, w ?? typeWord(t));
    const pc = (v) => (typeof v === 'number' ? `${fmtX(v * 100)}%` : '—');
    const section = (id, heading, ...kids) => h('section', { class: 'ee-help__sec', 'aria-labelledby': id }, h('h3', { id }, heading), ...kids);
    const radio = (label, on, fid, onclick) => h('button', { class: 'ee-seg__b', type: 'button', role: 'radio', 'aria-checked': String(!!on), tabindex: on ? '0' : '-1', dataset: { fid }, onclick },
      h('i', { class: 'ee-radio', 'aria-hidden': 'true' }), h('span', {}, label));

    const qMode = st.quality?.mode ?? 'auto';
    const qButtons = QUALITY_MODES.map((m) => radio(QUALITY_LABEL[m] ?? m, m === qMode, `q-${m}`, () => send({ type: 'quality', mode: m })));
    const qGroup = h('div', { class: 'ee-seg ee-seg--4', role: 'radiogroup', 'aria-labelledby': 'ee-q-l' }, qButtons);
    roving(qGroup, '.ee-seg__b', { select: (b) => send({ type: 'quality', mode: b.dataset.fid.slice(2) }) });
    const rmSwitch = h('button', { class: 'ee-switch', type: 'button', role: 'switch', 'aria-checked': String(!!st.reducedMotion), dataset: { fid: 'rm' }, 'aria-labelledby': 'ee-rm-l', onclick: () => send({ type: 'reducedMotion', on: !st.reducedMotion }) }, h('i', { 'aria-hidden': 'true' }));

    const views = VIEWS.map((v) => {
      const info = fi.find((f) => f.channel === v.channel) || null;
      const what = {
        cells: 'Cell type',
        depth: 'The band a cell’s depth falls in now',
        energy: 'Energy ÷ division threshold',
        age: 'Share of lifespan used',
        midline: 'Positional signal, strongest along the body’s axis',
        ap: 'Anterior–posterior (head–tail) position signal, rising toward the anterior',
        activator: 'Turing activator: amplifies itself',
        inhibitor: 'Turing inhibitor: made by the activator, spreads faster',
      }[v.id] ?? `${v.label} signal`;
      const scale = {
        cells: 'seven tissues',
        depth: 'outer · second · inner · core',
        energy: '0–2, white = threshold, gold = room to divide now',
        age: '0–1, old past 85%',
      }[v.id] ?? (info ? `0–${fmtSig(info.domain[1])}, ${info.scale === 'sqrt' ? '√' : 'linear'}${info.gates?.length ? ' · ' + info.gates.map((g) => g.label).join(' · ') : ''}` : '—');
      return h('tr', {}, h('td', {}, h('kbd', {}, v.key)), h('th', { scope: 'row' }, h('i', { class: 'ee-stain__ramp', style: `background:${previewCss(v.id)}`, 'aria-hidden': 'true' }), v.label), h('td', {}, what), h('td', { class: 'ee-help__mono' }, scale));
    });

    const keys = KEY_HELP.map(([ks, what, joiner]) => h('div', { class: 'ee-help__key' },
      h('dt', {}, ks.flatMap((k, i) => (i ? [h('span', { class: 'ee-help__join' }, joiner ?? ' / '), h('kbd', {}, k)] : [h('kbd', {}, k)]))), h('dd', {}, what)));

    const close = h('button', { class: 'ee-btn ee-btn--x', type: 'button', 'aria-label': 'Close guide', html: ICON.close, dataset: { fid: 'close' }, onclick: () => send({ type: 'help', open: false }) });
    const sc = st.seedCount;
    dialog.replaceChildren(
      h('header', { class: 'ee-help__top' },
        h('div', {},
          h('p', { class: 'ee-meta' }, h('span', {}, 'Field guide'), h('span', {}, st.engineVersion ? `Engine v${st.engineVersion}` : 'Engine v1.0'), h('span', {}, `Seed ${st.seed ?? '—'}`)),
          h('h2', { id: 'ee-help-h', tabindex: '-1' }, 'How to read the ', h('em', {}, 'specimen'))),
        close),
      h('div', { class: 'ee-help__body', tabindex: '0', role: 'region', 'aria-label': 'Guide contents', dataset: { fid: 'body' } },
        section('ee-h-why', 'A humble experiment',
          h('p', {}, 'This began as a thought experiment with ambitions. If the universe is a computation, what does its game board look like, and how little do you have to put on it before something starts behaving like life? The hypothesis: give a grid one law borrowed from physics (energy is never created or destroyed), add a few rules a cell can follow, press play, and see whether an embryo turns up uninvited.'),
          h('p', {}, 'The early universes were less embryo, more cautionary tale. v0.1 stalled at 74 cells. v0.3 went extinct. v0.5 misplaced 75% of its energy, and v0.6 lost the lot. Life only held on in v0.7, once metabolism was abolished and dividing became the only cost of living. The lesson, learned nine times over: every drop of energy needs somewhere to go.'),
          h('p', {}, 'Then the humbling part. An audit of v0.9 found that its perfect conservation had a leak, its vessels were a numerical checkerboard, its muscle could never form, and its tidy layers were drawn mostly around holes left by the dead. v1.0 fixed the maths and kept the receipts: ',
            h('a', { class: 'ee-help__inline', href: './classic.html' }, 'the old version'), ' is still one click away, artifacts and all.'),
          h('p', {}, 'So: an honest toy, not an embryo. Cells never move, the head–tail axis is handed to them, and Rule 3 decides the order of the layers. It proves nothing about whether we live in a simulation. But some of what you see does organise itself: Turing spots carving muscle blocks, a body whose size is set by its energy budget, a stem core that keeps renewing itself. If someone out there is running us, we hope they are enjoying the show as much as we enjoy this one.')),
        section('ee-h-what', 'What you’re looking at',
          h('p', {}, 'A simulated embryo, lit like a darkfield specimen: only light scattered by living tissue reaches you, so cells glow against black. The dish holds a ',
            n(GRID), ' × ', n(GRID), ' grid of places a cell can occupy, wrapped at the edges like a torus. The run began with ', n(sc), ' ', tw(STEM), ' cells, alike but for a little random noise in their lifespans and activator levels, and a fixed ',
            n(E0), ' units of energy. Every cell, colour, glow, label and number is drawn from the running simulation. One tick is one step: every cell applies the rules once.')),
        section('ee-h-rules', 'The law, three rules and four signals',
          h('dl', { class: 'ee-help__rules' },
            h('div', {}, h('dt', {}, h('em', { class: 'ee-rule' }, 'Law'), ' Energy is conserved'),
              h('dd', {}, 'Nothing creates or destroys it. Each pair of neighbours evens out ', h('b', { class: 'ee-n' }, pc(P.shareRate)), ' of their difference every tick; a dividing cell splits it in half; a dying cell hands all of it to the nearest living cells',
                P.death?.orphanRadius ? [' within ', n(P.death.orphanRadius), ' steps'] : '', ', or, if none are that close, to every living cell equally. Σ in the time bar is the running total.')),
            h('div', {}, h('dt', {}, h('em', { class: 'ee-rule' }, 'Rule 1'), ' Divide'),
              h('dd', {}, 'A ', tw(STEM), ' cell holding more than ', n(P.divThreshStem), ' energy (any other cell: more than ', n(P.divThreshDiff), ') that is older than ', n(P.divCooldown),
                ' ticks splits in two if a neighbouring place is empty: the daughter, a new stem cell, takes it, and each keeps half. Boxed-in cells wait.')),
            h('div', {}, h('dt', {}, h('em', { class: 'ee-rule' }, 'Rule 2'), ' Die'),
              h('dd', {}, 'A cell dies at the end of its lifespan, when it has no living neighbour, or, now and then, when it is an exposed tip with a single neighbour',
                P.death?.tipP ? [' (', h('b', { class: 'ee-n' }, pc(P.death.tipP)), ' a tick)'] : '', '. Its energy goes on to the living.')),
            h('div', {}, h('dt', {}, h('em', { class: 'ee-rule' }, 'Rule 3'), ' Depth → fate'),
              h('dd', {}, 'Every ', tw(STEM), ', ', tw(ECTO), ', ', tw(MESO), ' or ', tw(ENDO), ' cell older than ', n(P.diffAge), ' ticks continuously becomes what its depth demands. Depth is counted in steps from the outside, and the bands are fractions of the depth of the embryo’s deepest cell: the outer ',
                h('b', { class: 'ee-n' }, pc(P.bandFrac?.ecto)), ' is ', tw(ECTO), ' (', tw(NEURAL), ' where the midline and A–P signals both pass ', n(P.gates?.neuralMid, fmtSig), '), to ',
                h('b', { class: 'ee-n' }, pc(P.bandFrac?.meso)), ' ', tw(MESO), ', to ', h('b', { class: 'ee-n' }, pc(P.bandFrac?.endo)), ' ', tw(ENDO), ', and deeper becomes ', tw(STEM),
                '. Mesoderm that holds for ', n(P.gates?.mesoSpecializeAge), ' ticks becomes ', tw(MUSCLE), ' where its activator runs above ', n(P.gates?.muscleRel, fmtX), '× the mean at its depth, or ',
                tw(VESSEL), ' below ', n(P.gates?.vesselRel, fmtX), '×. ', tw(NEURAL, 'Neural'), ', muscle and vessel cells keep their fate',
                P.hysteresis?.terminalRevert ? [' unless they sit outside their band for ', n(P.hysteresis.terminalRevert), ' ticks'] : '', '.')),
            h('div', {}, h('dt', {}, h('em', { class: 'ee-rule' }, 'Signals'), ' Four fields'),
              h('dd', {}, 'Four fields diffuse and fade across the dish, empty places included. The midline signal is laid down along a line through the embryo’s centre, and the A–P (anterior–posterior, head–tail) signal rises toward one side of the dish, the anterior; ',
                tw(NEURAL, 'neural'), ' cells add to both, ', tw(MESO, 'mesoderm'), ' and ', tw(MUSCLE, 'muscle'), ' add to A–P. The activator amplifies itself and makes an inhibitor that spreads ',
                n(P.diffusion?.rates ? P.diffusion.rates[1] / P.diffusion.rates[0] : NaN, fmtX), '× faster: together they form spots and stripes on their own.'))),
          h('p', { class: 'ee-help__note' }, 'Holes left inside by deaths are not surfaces; only the outside counts. Hysteresis keeps cells on a band boundary from flickering between fates. The founders all take a fate before the embryo is thick enough to have a core: the core first forms from buried endoderm (and early muscle) turning back into stem, then renews itself by division.'),
          h('p', { class: 'ee-help__note' }, 'What is local and what is not: Rules 1 and 2 involve only a cell and its neighbours. Rule 3’s depth, its band edges and the muscle and vessel reference are measured over the whole embryo, and the midline and A–P signals are positional information laid down around the embryo’s centre, with the anterior fixed to one side of the dish. The order of the layers is what Rule 3 assigns. What organises itself is the activator pattern and the muscle blocks it carves, the embryo’s size, its turnover and the stem core.')),
        section('ee-h-read', 'Reading the 3D',
          h('dl', { class: 'ee-help__read' },
            h('div', {}, h('dt', {}, 'Height'), h('dd', {}, 'Depth below the outer surface: deeper cells stand taller, on a rounded dome scaled to the depth of the deepest cell, with a small step at each Rule 3 band edge. An encoding, not anatomy; the Map camera is flat.')),
            h('div', {}, h('dt', {}, 'Colour'), h('dd', {}, 'The selected stain; the legend on the left explains it.')),
            h('div', {}, h('dt', {}, 'Glow'), h('dd', {}, 'Energy, in the Tissue stain, tinted by the tissue’s colour. It is linear for ordinary cells, but pale tissues (stem, endoderm) glow brighter than dark ones (neural, mesoderm, ectoderm) at the same energy, so compare energies in the Energy stain. The very full seed cells at the start are eased off; they blaze, then cool as they divide.')),
            h('div', {}, h('dt', {}, 'Width'), h('dd', {}, 'Energy toward the division threshold, full at the threshold. To divide, a cell must also be older than ', n(P.divCooldown), ' ticks and have an empty neighbouring place.')),
            h('div', {}, h('dt', {}, 'Shape'), h('dd', {}, 'Round pebbles are stem cells; flatter tiles have taken a fate.')),
            h('div', {}, h('dt', {}, 'Easing'), h('dd', {}, 'Colours ease over about a tenth of a second so nothing strobes. Hover a cell for its exact values; click to pin it.')),
            h('div', {}, h('dt', {}, 'Props'), h('dd', {}, 'The dish, stage, objective lens, illuminator ring and dust specks are decoration.')))),
        section('ee-h-views', 'Stains',
          h('table', { class: 'ee-help__table' }, h('thead', {}, h('tr', {}, h('td', {}, 'Key'), h('th', { scope: 'col' }, 'Stain'), h('th', { scope: 'col' }, 'Colour shows'), h('th', { scope: 'col' }, 'Scale'))), h('tbody', {}, views))),
        (() => { const el = section('ee-h-keys', 'Keyboard', h('dl', { class: 'ee-help__keys' }, keys)); el.classList.add('ee-help__sec--keys'); return el; })(),
        section('ee-h-set', 'Settings',
          h('div', { class: 'ee-help__set' },
            h('div', { class: 'ee-help__setrow' }, h('span', { id: 'ee-q-l', class: 'ee-help__setl' }, 'Quality ', h('kbd', {}, 'Q')), qGroup,
              h('span', { class: 'ee-help__mono ee-help__now' }, st.quality?.tier ? `now ${st.quality.tier}${st.quality.dpr ? ` · DPR ${st.quality.dpr}` : ''}` : '')),
            h('div', { class: 'ee-help__setrow' }, h('span', { id: 'ee-rm-l', class: 'ee-help__setl' }, 'Reduced motion ', h('kbd', {}, 'M')), rmSwitch,
              h('span', { class: 'ee-help__now' }, st.reducedMotion ? 'On: no glides, flights or flashes' : 'Off')),
            h('div', { class: 'ee-help__setrow' }, h('span', { class: 'ee-help__setl' }, 'Run'),
              h('button', { class: 'ee-action', type: 'button', dataset: { fid: 'seed' }, onclick: () => send({ type: 'newSeed' }) }, 'New seed ', h('kbd', { 'aria-hidden': 'true' }, 'N')),
              h('button', { class: 'ee-action', type: 'button', dataset: { fid: 'share' }, onclick: () => send({ type: 'share' }) }, 'Copy link to this moment')))),
        section('ee-h-ver', 'This version',
          h('p', {}, 'Engine ', h('b', { class: 'ee-n' }, st.engineVersion ?? '1.0.0'), '. What changed since v0.9:'),
          h('ul', { class: 'ee-help__list' },
            h('li', {}, 'Energy is conserved exactly. v0.9 lost some whenever a cell died with no neighbour.'),
            h('li', {}, 'The inhibitor diffuses stably. v0.9’s flipped between two values every tick in a one-cell checkerboard.'),
            h('li', {}, 'Real activator–inhibitor kinetics, so mesoderm breaks into muscle blocks. v0.9 never formed muscle.'),
            h('li', {}, 'Depth is measured from the outside only and re-read continuously, with hysteresis. v0.9 counted every hole as a surface and fixed each fate once, so most of its layering was a numerical artifact.'),
            h('li', {}, 'The body’s centre is computed correctly on the wrapped grid, and runs are seeded: the same seed grows the same embryo.')),
          h('p', { class: 'ee-help__links' },
            h('a', { href: './classic.html' }, 'See v0.9, with its numerical artifacts →'),
            h('a', { href: GITHUB, target: '_blank', rel: 'noopener' }, 'Source on GitHub →')))));
  }

  // ═══ destroy ════════════════════════════════════════════════════════════════════════════════════════
  function destroy() {
    clearTimeout(toastTimer); clearTimeout(narrateTimer); clearTimeout(holdTimer);
    clearTimeout(annTimer); clearTimeout(annWriteTimer); clearTimeout(msAnnounceTimer); clearTimeout(ffEndTimer); clearTimeout(firstHintTimer);
    cancelAnimationFrame(fitRaf);
    for (const k of Object.keys(trailing)) clearTimeout(trailing[k]);
    for (const c of cleanups) c();
    if (dialog.open) dialog.close();
    hud.textContent = '';
    hud.classList.remove('ee-hud', 'is-mobile', 'is-reduced', 'is-viewing', 'is-q-low', 'is-short', 'is-ff', 'is-guide-new');
  }

  // The panels' rects from the last footprint() (main reads it at 5 Hz, in its read phase), so placing the inspector
  // while the camera moves forces no layout; measured afresh when there is none yet or it is stale.
  const PANEL_EL = { left: () => leftCard, rail: () => rail, transport: () => transport };
  function rectOf(k) {
    const r = panelRects && performance.now() - panelRects.at < 400 ? panelRects[k] : undefined;
    if (r) return r;
    const el = PANEL_EL[k]();
    return el.hidden ? { left: 0, top: window.innerHeight, right: 0, bottom: 0, width: 0, height: 0 } : el.getBoundingClientRect();
  }

  // ═══ layout: the HUD's footprint, for the stage ═════════════════════════════════════════════════════
  // `rects`: every visible panel (scene notes keep clear of them). `insets`: the panels that frame the view on each
  // side; the stage centres the specimen in what they leave free. Viewport CSS px (the canvas fills the viewport).
  function footprint() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const rects = [];
    const add = (el) => {
      if (!el || el.hidden) return null;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return null;
      rects.push(r);
      return r;
    };
    const rTitle = add(title), rLeft = add(leftCard), rRail = add(rail), rTp = add(transport);
    panelRects = { left: rLeft, rail: rRail, transport: rTp, at: performance.now() };
    const rBan = add(banner), rProg = add(progress);
    add(toast);
    if (!insp.hidden) add(inspPlate);
    if (!pop.hidden) add(pop);
    const bottom = rTp ? Math.max(0, vh - rTp.top) : 0;
    let insets;
    if (mobile) {
      const rLog = add(logSec);                       // on mobile the log line sits in the top block
      let right = 0;
      if (hud.classList.contains('is-short') && !insp.hidden && insp.classList.contains('is-pinned')) {
        const rp = inspPlate.getBoundingClientRect();   // landscape: the pinned plate is a side panel
        if (rp.width > 0) right = Math.max(0, vw - rp.left);
      }
      // the phone's top block also holds the viewing banner and the fast-forward card when they show
      insets = { left: 0, right, top: Math.max(rTitle ? rTitle.bottom : 0, rLog ? rLog.bottom : 0, rBan ? rBan.bottom : 0, rProg ? rProg.bottom : 0), bottom };
    } else {
      insets = { left: Math.max(rLeft ? rLeft.right : 0, rTitle ? rTitle.right : 0), right: rRail ? Math.max(0, vw - rRail.left) : 0, top: 0, bottom };
    }
    return { insets, rects };
  }

  renderLog();
  renderTimeline(true);
  return { render, setStats, setInspector, moveInspector, setHint, announce, setProgress, showFallback, showError, layout: footprint, destroy };
}
