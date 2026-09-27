// src/scene/labels.js — CSS2D-style annotation layer: scientific-figure callouts (a 3px dot on the anchor, a 1px
// leader running diagonally then horizontally, a small-caps label with a mono value). World anchors are projected
// every rendered frame; notes are decluttered by priority. Default styles are injected once with zero specificity
// (:where), so the HUD stylesheet can override any of them.
//
// A `group` of notes (the Apart plate callouts) is laid out as a set: every member shows, or the group steps down
// to a more compact layout — full names beside each anchor, then short names, then a tidy column of short names
// (a common left edge, rows at least a line apart, leaders bent at 45°, or steeper when that leaves no room; the
// whole column slides up or down to clear the HUD, and on past a panel its text would graze), then the same column
// packed a line apart, or a little closer, into whatever free band holds it (a short viewport, where rows spaced like
// their anchors fit nowhere). Last resorts, rather than hide a member: the column let onto the plates (on the
// anchors' right, else their left), else each row wherever it fits; only a row that fits nowhere is hidden.
// Nothing hops. A layout that no longer fits gives way at once, but a more generous one (or a column nearer its
// anchors) only takes over once it has fitted, with HYST px to spare, for DWELL ms on end, and never within DWELL of
// the last change. A count is measured at a reserved width (a digit more than it has), so a count ticking past
// 999 or 9,999 does not, by itself, change what fits. A resize, a HUD change, the web fonts arriving or a camera
// flight ask for the choice to be made afresh once the view has settled, so a view reached one way ends up laid out
// as a fresh load of it would be.
import { Vector3 } from 'three';

const STYLE_ID = 'ee-note-style';
const CSS = `
:where(.ee-notes){position:absolute;inset:0;pointer-events:none;overflow:hidden;contain:strict}
:where(.ee-note){position:absolute;left:0;top:0;width:0;height:0;opacity:0;transition:opacity .28s ease;will-change:transform,opacity}
:where(.ee-note.is-on){opacity:1}
:where(.ee-notes.is-still .ee-note){transition:none}
:where(.ee-note.ee-note--ruler){visibility:hidden;will-change:auto}
:where(.ee-note__dot){position:absolute;left:-2.5px;top:-2.5px;width:5px;height:5px;border-radius:50%;box-sizing:border-box;
  background:#ECE7DC;border:1px solid rgba(5,6,5,.75)}
:where(.ee-note__lead){position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible}
:where(.ee-note__lead polyline){fill:none;stroke:#ECE7DC99;stroke-width:1;vector-effect:non-scaling-stroke}
:where(.ee-note__txt){position:absolute;top:0;white-space:nowrap;transform:translateY(-50%);display:flex;align-items:baseline;gap:.55em;
  color:#ECE7DC;text-shadow:0 0 6px rgba(0,0,0,.9),0 0 2px rgba(0,0,0,.9)}
:where(.ee-note__k){font:600 10.5px/1 'Instrument Sans',system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase}
:where(.ee-note__v){font:400 11px/1 'JetBrains Mono',ui-monospace,monospace;color:#C9C3B8;font-variant-numeric:tabular-nums}
:where(.ee-note__sw){display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:.1em;align-self:center}
:where(.ee-note.is-landmark .ee-note__txt){opacity:.7}
`;

const D = 16;      // diagonal leg (px)
const L = 24;      // horizontal leg (px)
const GAP = 6;     // leader end → text
const HALF = 9;    // half the height a text line keeps clear (px)
const EDGE = 2;    // a note's distance from the screen's edges (px)
const EDGE_G = 6;  // a group's (its last-resort layout keeps EDGE)
const D_COL = 10, L_COL = 12;   // a group's column: a shorter leader
const PITCH = 20;  // a column's row pitch (px): a line's 18 px and a gap
// a column's row spacings: 0 = like its anchors (rows at least PITCH apart); packed, PITCH apart, then closer (the
// text is 11 px tall: 16 px still leaves a clear gap between lines)
const PACK = new Float64Array([0, PITCH, 16]);
const ROWS = 6;    // a group's column variant (g.v, see `colS`) meaning none: each row on its own (squeezeRows)
const HYST = 12;   // spare room (px) a more generous group layout needs before it replaces the current one
const DWELL = 1000;   // ms it must go on fitting first; also the least time between two changes that are not forced
const SETTLE = 600;   // ms after a resize, a HUD change or the fonts before the choice is made afresh …
const STILL = 400;    // … once nothing it lays out has changed for this long (ms): no count (a run is playing), and
const EPS = 0.05;     // … no anchor or plate by more than this (px): the view has settled (a turntable is still)
const MOVED = 16;     // px an anchor may stray from where the last fresh choice saw it (farther: a flight, a preset)
const PROBE = 100;    // ms between two looks for a more generous layout (or a column nearer its anchors)
const STEP = 4;    // a column's vertical search step (px)
const SLOPES = new Float64Array([1, 0.5]);   // a column leader's leg per px of drop: 45°, then steeper (~63°)
const MAXG = 8;    // members per group
// group layouts, most generous first (see the header)
const MODES = ['full', 'short', 'column', 'packed', 'squeeze'];
const M_FULL = 0, M_SHORT = 1, M_COLUMN = 2, M_PACKED = 3, M_SQUEEZE = 4;
// a group's clocks (performance.now() ms; 0 = not running), in its `tm`: a fresh choice was asked for (and the ask
// last seen from outside the group), the anchors, plates or counts last changed, the layout last changed, a nearer
// column (or, per mode, a more generous layout: `since`) began to fit, the next look for either
const T_TRIG = 0, T_SEEN = 1, T_MOVE = 2, T_SWITCH = 3, T_NEAR = 4, T_PROBE = 5;
const SVGNS = 'http://www.w3.org/2000/svg';

/** `onInvalidate`: called when the notes need laying out again with nothing else changed (the fonts loaded). */
export function createLabels(root, { max = 6, onInvalidate = null } = {}) {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const layer = document.createElement('div');
  layer.className = 'ee-notes';
  layer.setAttribute('aria-hidden', 'true');
  root.appendChild(layer);

  const notes = new Map();     // key → note
  const order = [];            // notes sorted by priority (rebuilt when the set changes)
  const groups = new Map();    // name → group
  let groupsDirty = false;     // a group's member list needs rebuilding (membership or priority changed)
  const accepted = new Float32Array(4 * 2 * 16);   // accepted rects (label + leader bbox) for declutter
  const ndc = new Vector3();
  let maxNotes = max;
  let lastW = 0, lastH = 0, frame = 0;
  // The HUD changed or the fonts loaded (the canvas size is compared in update()): groups are to choose their layout
  // afresh once the view settles (a discrete event, a few a minute at most, never frame to frame).
  let trig = false;
  // When the notes next need an update although nothing else asks for a render (a group's pending fresh choice or
  // upgrade), performance.now() ms; Infinity = never. The stage renders once it is due.
  const wake = new Float64Array([Infinity]);
  // Text widths, cached by what decides them: the text, the value's shape (tabular digits: every digit is as wide
  // as '0'; commas and arrows are not) and whether the swatch shows. A value that ticks from 1,204 to 1,219 then
  // costs no layout read. A group member's count is measured at its reserved shape instead (see reserve()).
  // Widths are read off a hidden ruler note (so a text that is not showing, a group's other name, has a width too).
  // They depend on the web fonts: the cache is dropped whenever fonts finish loading (and group layouts are chosen
  // afresh once the view settles: one picked with the fallback font's wider text is no reason to keep a smaller
  // one). `ready` alone can come too early: a face is fetched only once text first asks for it.
  const widths = new Map();
  const ruler = makeRuler();
  const onFonts = () => { widths.clear(); for (const n of order) n.measured = false; trig = true; onInvalidate?.(); };
  document.fonts?.ready?.then(onFonts);
  document.fonts?.addEventListener?.('loadingdone', onFonts);

  function makeRuler() {
    const el = document.createElement('div');
    el.className = 'ee-note ee-note--ruler';
    const txt = document.createElement('span');
    txt.className = 'ee-note__txt';
    const sw = document.createElement('i');
    sw.className = 'ee-note__sw';
    const k = document.createElement('b');
    k.className = 'ee-note__k';
    const v = document.createElement('span');
    v.className = 'ee-note__v';
    txt.append(sw, k, v);
    el.append(txt);
    layer.appendChild(el);
    return { txt, sw, k, v };
  }
  function widthOf(n, text) {
    const value = n.resv || n.value;
    const key = `${text}|${value.replace(/\d/g, '0')}|${n.swatch ? 1 : 0}`;
    let w = widths.get(key);
    if (w === undefined) {
      ruler.k.textContent = text;
      ruler.v.textContent = value; ruler.v.style.display = value ? '' : 'none';
      ruler.sw.style.display = n.swatch ? '' : 'none';
      w = ruler.txt.offsetWidth || text.length * 8;
      if (widths.size > 256) widths.clear();
      widths.set(key, w);
    }
    return w;
  }

  /** A group member's count, `value`, is measured as `resDigits` zeros grouped in thousands (n.resv): one digit
   *  more than it had when last set, kept until it outgrows that or falls two digits below it. So a count wavering
   *  round 1,000 or climbing past it never widens its label, and none flips its group's layout. Other values (none
   *  or not a plain count) are measured as they are. Returns true when the reserved shape changed. */
  function reserve(n, value) {
    let d = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 48 && c <= 57) d++;
      else if (c !== 44) { d = 0; break; }                 // not a plain count (digits and thousands commas)
    }
    let r = n.resDigits;
    if (!d) r = 0;
    else if (d > r || d + 2 < r) r = d + 1;
    if (r === n.resDigits) return false;
    n.resDigits = r;
    let s = '';
    for (let i = r; i > 0; i--) s += i % 3 === 0 && i !== r ? ',0' : '0';
    n.resv = s;
    return true;
  }

  /** Same width in tabular digits: the same length, and the same characters wherever either is not a digit. */
  function sameShape(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const ca = a.charCodeAt(i), cb = b.charCodeAt(i);
      if (ca !== cb && !(ca >= 48 && ca <= 57 && cb >= 48 && cb <= 57)) return false;
    }
    return true;
  }

  function makeNote(key) {
    const el = document.createElement('div');
    el.className = 'ee-note';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'ee-note__lead');
    const pl = document.createElementNS(SVGNS, 'polyline');
    svg.appendChild(pl);
    const dot = document.createElement('i');
    dot.className = 'ee-note__dot';
    const txt = document.createElement('span');
    txt.className = 'ee-note__txt';
    const sw = document.createElement('i');
    sw.className = 'ee-note__sw';
    const k = document.createElement('b');
    k.className = 'ee-note__k';
    const v = document.createElement('span');
    v.className = 'ee-note__v';
    sw.style.display = 'none';     // empty slots take no room (nor a flex gap) until set() fills them
    v.style.display = 'none';
    txt.append(sw, k, v);
    el.append(svg, dot, txt);
    layer.appendChild(el);
    return {
      key, el, pl, txt, sw, k, v, world: new Vector3(), priority: 9, active: false, on: false,
      text: '', short: '', shown: '', value: '', swatch: '', landmark: false, group: null, fixedSide: 0,
      wFull: 0, wShort: 0, measured: false, x: 0, y: 0, resDigits: 0, resv: '', minW: 0,
      side: 0, a: 0, lead: 0, yt: 0,            // the drawn leader (see setLeader)
    };
  }

  // Scratch (typed, so the hot paths read and pass no boxed numbers): anchors on screen and the candidate layout per
  // group member (placed, side, leg, lead, text line relative to the anchor); index MAXG = the note being placed
  // outside any group. `tb`, `lb`: the text box and the leader's box (or segment) under test, [x0, y0, x1, y1].
  const gx = new Float64Array(MAXG + 1), gy = new Float64Array(MAXG + 1), gLive = new Uint8Array(MAXG);
  const cOn = new Uint8Array(MAXG), cS = new Int8Array(MAXG + 1), cA = new Float64Array(MAXG + 1);
  const cLead = new Float64Array(MAXG + 1), cY = new Float64Array(MAXG + 1);
  const tb = new Float64Array(4), lb = new Float64Array(4);

  // The leader (from cS/cA/cLead/cY[i]): a leg `a` px across and to the text line's height `yt` (relative to the
  // anchor), then `lead` px level.
  function setLeader(n, i) {
    const side = cS[i], a = cA[i], lead = cLead[i], yt = cY[i];
    if (n.side === side && n.a === a && n.lead === lead && n.yt === yt) return;
    n.side = side; n.a = a; n.lead = lead; n.yt = yt;
    const s = side > 0 ? 1 : -1;
    n.pl.setAttribute('points', `0,0 ${s * a},${yt} ${s * (a + lead)},${yt}`);
    if (s > 0) { n.txt.style.left = `${a + lead + GAP}px`; n.txt.style.right = ''; }
    else { n.txt.style.left = ''; n.txt.style.right = `${a + lead + GAP}px`; }
    n.txt.style.top = `${yt}px`;
  }
  function showText(n, text) {
    if (n.shown !== text) { n.shown = text; n.k.textContent = text; }
  }
  /** Text set to the left of its anchor is right-aligned: its box keeps the width it was laid out at (the count at
   *  its reserved width), so the name stays put as the count grows; `w` 0 = its natural width. */
  function boxWidth(n, w) {
    if (n.minW !== w) { n.minW = w; n.txt.style.minWidth = w ? `${w}px` : ''; }
  }
  function setOn(n, on) {
    if (on !== n.on) { n.on = on; n.el.classList.toggle('is-on', on); }
  }
  /** The note to its anchor (gx/gy[i]). */
  function moveTo(n, i) {
    const x = gx[i], y = gy[i];
    if (Math.abs(n.x - x) > 0.25 || Math.abs(n.y - y) > 0.25) {
      n.x = x; n.y = y;
      n.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
    }
  }

  // Horizontal leg long enough for the label to clear the organism's screen ellipse (scientific-figure style).
  function leadFor(x, yl, s, av, width) {
    if (!av || !Number.isFinite(av.x) || !Number.isFinite(av.y) || !(av.rx >= 0) || !(av.ry >= 0)) return L;
    const dy = (yl - av.y) / Math.max(1, av.ry);
    if (Math.abs(dy) >= 1) return L;
    const w = av.rx * Math.sqrt(1 - dy * dy) + 10;
    const need = s > 0 ? av.x + w - (x + D + GAP) : (x - D - GAP) - (av.x - w);
    const lead = Math.max(L, Math.ceil(need / 4) * 4);
    return lead > 0.42 * width ? L : lead;
  }

  // Screen rects the notes must keep clear of (the HUD's panels), [x0, y0, x1, y1] per rect in canvas CSS px.
  const MAX_EXCL = 12;
  const excl = new Float64Array(4 * MAX_EXCL);
  let exclCount = 0;
  // Obstacles: screen ellipses [cx, cy, rx, ry] no text may touch (the Apart plates), set per update().
  let obst = null, obstN = 0;
  /** Does box `b` hit one of the first `count` accepted rects, a HUD panel (`panels`) or an obstacle (`plates`)? */
  function blocked(b, count, panels, plates) {
    const x0 = b[0], y0 = b[1], x1 = b[2], y1 = b[3];
    for (let i = 0; i < count; i++) {
      const o = 4 * i;
      if (x0 < accepted[o + 2] && x1 > accepted[o] && y0 < accepted[o + 3] && y1 > accepted[o + 1]) return true;
    }
    if (panels) {
      for (let i = 0; i < exclCount; i++) {
        const o = 4 * i;
        if (x0 < excl[o + 2] && x1 > excl[o] && y0 < excl[o + 3] && y1 > excl[o + 1]) return true;
      }
    }
    if (plates) {
      for (let i = 0; i < obstN; i++) {
        const o = 4 * i, cx = obst[o], cy = obst[o + 1], rx = obst[o + 2], ry = obst[o + 3];
        if (!(rx > 0 && ry > 0)) continue;
        // the box's point nearest the centre (exact for an axis-aligned ellipse: scaling the axes keeps it nearest)
        const ex = (Math.min(Math.max(cx, x0), x1) - cx) / rx, ey = (Math.min(Math.max(cy, y0), y1) - cy) / ry;
        if (ex * ex + ey * ey < 1) return true;
      }
    }
    return false;
  }
  /** Does the segment `b` (x0, y0 → x1, y1) cross a HUD panel? (Liang–Barsky clip against each rect.) */
  function segBlocked(b) {
    const x0 = b[0], y0 = b[1], dx = b[2] - x0, dy = b[3] - y0;
    for (let i = 0; i < exclCount; i++) {
      const o = 4 * i;
      let t0 = 0, t1 = 1, k = 0;
      for (; k < 4; k++) {
        const p = k === 0 ? -dx : k === 1 ? dx : k === 2 ? -dy : dy;
        const q = k === 0 ? x0 - excl[o] : k === 1 ? excl[o + 2] - x0 : k === 2 ? y0 - excl[o + 1] : excl[o + 3] - y0;
        if (p === 0) { if (q < 0) break; continue; }
        const r = q / p;
        if (p < 0) { if (r > t1) break; if (r > t0) t0 = r; } else { if (r < t0) break; if (r < t1) t1 = r; }
      }
      if (k === 4 && t0 < t1) return true;
    }
    return false;
  }
  /** Is the anchor gx/gy[i] in view and clear of the HUD's panels? */
  function anchorClear(i, width, height) {
    const x = gx[i], y = gy[i];
    if (!(x > 4 && x < width - 4 && y > 4 && y < height - 4)) return false;
    tb[0] = x - 3; tb[1] = y - 3; tb[2] = x + 3; tb[3] = y + 3;
    return !blocked(tb, 0, true, false);
  }
  /** Accept `tb` (the text, padded 4 px either side) and `lb` (its leader) into `slot`. */
  function accept(slot) {
    const o = 8 * slot;
    accepted[o] = tb[0] - 4; accepted[o + 1] = tb[1]; accepted[o + 2] = tb[2] + 4; accepted[o + 3] = tb[3];
    accepted[o + 4] = lb[0]; accepted[o + 5] = lb[1]; accepted[o + 6] = lb[2]; accepted[o + 7] = lb[3];
  }
  // Does a text box sit on the organism's screen ellipse? Its centre inside, or its point nearest the organism's
  // centre well inside (80% of the radii): grazing the soft edge is allowed, covering tissue is not.
  function onEllipse(av, x0, y0, x1, y1) {
    if (!av || !(av.rx > 0) || !(av.ry > 0)) return false;
    const e = (x, y, k) => ((x - av.x) / (k * av.rx)) ** 2 + ((y - av.y) / (k * av.ry)) ** 2 < 1;
    const nx = Math.min(Math.max(av.x, x0), x1), ny = Math.min(Math.max(av.y, y0), y1);
    return e((x0 + x1) / 2, (y0 + y1) / 2, 1) || e(nx, ny, 0.8);
  }

  // This frame's constants (typed, so the hot paths below read them unboxed): canvas width, height, the screen x
  // that splits left from right, the time (performance.now() ms) and when the canvas size, the HUD or the fonts last
  // changed; and the organism ellipse to avoid (an object, or null).
  const fr = new Float64Array(5);
  let av = null;

  // One note beside its own anchor (gx/gy[i]): the text `w` px wide, tried on its preferred side, then the other
  // (unless its side is fixed), with a leader long enough to clear `av`, then a short one. `margin` px of extra room
  // is asked of the text box (a group testing whether a more generous layout fits comfortably), `edge` px of the
  // screen's edges. On success the leader is left in cS/cA/cLead/cY[i] and the rects accepted into `slot`.
  function fitAnchored(n, i, w, slot, margin, edge) {
    const x = gx[i], y = gy[i], width = fr[0], height = fr[1];
    const pref = n.fixedSide || (x >= fr[2] ? 1 : -1);
    // When the organism fills most of the view there is no room beside it: then a note may sit on the tissue.
    const fillsView = !av || !(av.rx < 0.36 * width);
    const m2 = margin / 2;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (n.fixedSide && attempt % 2) continue;                        // never flipped across its anchor
      const s = attempt % 2 === 0 ? pref : -pref;
      const lead = attempt < 2 && av ? leadFor(x, y - D, s, av, width) : L;   // last resort: short leader
      const tx0 = s > 0 ? x + D + lead + GAP : x - D - lead - GAP - w;
      const tx1 = tx0 + w;
      const mx0 = s > 0 ? tx0 : tx0 - margin, mx1 = s > 0 ? tx1 + margin : tx1;
      if (mx0 < edge || mx1 > width - edge) continue;
      const yt = y - D, ty0 = yt - HALF, ty1 = yt + HALF;
      if (ty0 - m2 < edge || ty1 + m2 > height - edge) continue;
      const lx0 = Math.min(x, x + s * (D + lead)), lx1 = Math.max(x, x + s * (D + lead));
      tb[0] = mx0; tb[1] = ty0 - m2; tb[2] = mx1; tb[3] = ty1 + m2;
      lb[0] = lx0; lb[1] = yt - 2; lb[2] = lx1; lb[3] = y + 3;
      if (blocked(tb, 2 * slot, true, true) || blocked(lb, 2 * slot, true, false)) continue;
      if (!fillsView && onEllipse(av, tx0, ty0, tx1, ty1)) continue;
      // a leader never runs across the specimen to its far side (the hero framing leaves little room beside it)
      if (av && lx0 < av.x && lx1 > av.x && Math.abs(yt - av.y) < 0.85 * av.ry) continue;
      tb[0] = tx0; tb[1] = ty0; tb[2] = tx1; tb[3] = ty1;
      accept(slot);
      cS[i] = s; cA[i] = D; cLead[i] = lead; cY[i] = -D;
      return true;
    }
    return false;
  }

  // ── groups ──
  // the column: live members sorted by anchor height, their text lines before the vertical offset, PAV blocks; the
  // column's edge and leader slope (an index into SLOPES) from the last columnFits that succeeded, and its side
  // (1: right of the anchors, −1: left). A column variant `v` (a group's g.v) = its row spacing (v % 3, see PACK)
  // and side (v < 3: right); or ROWS.
  const rows = new Int8Array(MAXG), rowY = new Float64Array(MAXG);
  const pavV = new Float64Array(MAXG), pavN = new Int8Array(MAXG);
  const col = new Float64Array(1), colS = new Int8Array([1]);
  // a bound on the column's edge (NaN: none): the current column's, so that it only drifts (see tryColumn)
  const colLim = new Float64Array([NaN]);
  let nRows = 0, colQ = 0;

  function makeGroup(name) {
    return {
      name, members: [], mode: M_FULL, shown: false, frame: -1,
      // a column's offset, slope and variant (see tryColumn), the candidate's, and its edge (`ex`: current, candidate)
      t: 0, q: 0, v: 0, tNext: 0, qNext: 0, vNext: 0, ex: new Float64Array(2),
      tm: new Float64Array(6), since: new Float64Array(MODES.length),
      // the anchors and plates when last seen moving (sx, sy, sLive, sObst), and the anchors at the last fresh
      // choice (fx, fy)
      sx: new Float64Array(MAXG), sy: new Float64Array(MAXG), sLive: new Uint8Array(MAXG), sObst: new Float64Array(16),
      fx: new Float64Array(MAXG), fy: new Float64Array(MAXG),
    };
  }
  function rebuildGroups() {
    groupsDirty = false;
    for (const g of groups.values()) g.members.length = 0;
    for (const n of order) if (n.group && n.group.members.length < MAXG) n.group.members.push(n);
  }

  /** A group beside its anchors, each member's text `full` or short: every live member must fit. */
  function tryAnchored(g, full, margin, count) {
    const mem = g.members;
    let slot = count;
    for (let i = 0; i < mem.length; i++) {
      cOn[i] = 0;
      if (!gLive[i]) continue;
      const n = mem[i];
      if (!fitAnchored(n, i, full ? n.wFull : n.wShort, slot, margin, EDGE_G)) return false;
      cOn[i] = 1;
      slot++;
    }
    return true;
  }

  /** The column's rows: live members by anchor height. Spaced like their anchors (`pk` 0): each text line just
   *  above its anchor, then spread (least squares, pool-adjacent-violators) so consecutive lines are at least PITCH
   *  apart. Packed (`pk` 1, 2): PACK[pk] apart, centred on the anchors' mean height, for a band shorter than the
   *  stack. */
  function columnRows(g, pk) {
    const mem = g.members;
    nRows = 0;
    for (let i = 0; i < mem.length; i++) {
      if (!gLive[i]) continue;
      let j = nRows++;
      while (j > 0 && gy[rows[j - 1]] > gy[i]) { rows[j] = rows[j - 1]; j--; }
      rows[j] = i;
    }
    if (!nRows) return;
    if (pk > 0) {
      const p = PACK[pk];
      let c = 0;
      for (let j = 0; j < nRows; j++) c += gy[rows[j]];
      c = c / nRows - D_COL - 0.5 * (nRows - 1) * p;
      for (let j = 0; j < nRows; j++) rowY[j] = c + j * p;
      return;
    }
    // isotonic fit of q_j = wanted_j − j·PITCH (non-decreasing q ⇔ lines PITCH apart)
    let nb = 0;
    for (let j = 0; j < nRows; j++) {
      pavV[nb] = gy[rows[j]] - D_COL - j * PITCH; pavN[nb] = 1; nb++;
      while (nb > 1 && pavV[nb - 2] > pavV[nb - 1]) {
        const a = pavN[nb - 2], b = pavN[nb - 1];
        pavV[nb - 2] = (pavV[nb - 2] * a + pavV[nb - 1] * b) / (a + b); pavN[nb - 2] = a + b; nb--;
      }
    }
    for (let b = 0, j = 0; b < nb; b++) for (let k = 0; k < pavN[b]; k++, j++) rowY[j] = pavV[b] + j * PITCH;
  }

  /** The column slid `t` px down (a whole number): a common edge beside the anchors, on their right (colS[0] 1:
   *  its left edge) or, the last resort, on their left, over the plates (−1: its right edge); clear of the plates
   *  unless `plates` is false (its text may then sit on them). Each row's leader leg runs SLOPES[q] px across per px
   *  of drop. True when every row fits; then col[0] / colQ hold the fit. */
  function columnFits(g, t, q, margin, plates, count) {
    const mem = g.members, m2 = margin / 2, k = SLOPES[q], width = fr[0], height = fr[1], s = colS[0];
    let X = s > 0 ? -Infinity : Infinity;
    for (let j = 0; j < nRows; j++) {
      const i = rows[j], yt = rowY[j] + t, a = Math.max(D_COL, k * Math.abs(yt - gy[i]));
      X = s > 0 ? Math.max(X, gx[i] + a + L_COL + GAP) : Math.min(X, gx[i] - a - L_COL - GAP);
      if (!plates) continue;
      // clear of the plates: their outermost x within the row's band
      const y0 = yt - HALF - m2, y1 = yt + HALF + m2;
      for (let e = 0; e < obstN; e++) {
        const o = 4 * e, cy = obst[o + 1], rx = obst[o + 2], ry = obst[o + 3];
        if (!(rx > 0 && ry > 0)) continue;
        const dy = cy < y0 ? (y0 - cy) / ry : cy > y1 ? (cy - y1) / ry : 0;
        if (dy < 1) {
          const dx = rx * Math.sqrt(1 - dy * dy) + 4;
          X = s > 0 ? Math.max(X, obst[o] + dx) : Math.min(X, obst[o] - dx);
        }
      }
    }
    X = s > 0 ? Math.ceil(X) : Math.floor(X);
    const lim = colLim[0];
    if (lim === lim) X = s > 0 ? Math.max(X, lim) : Math.min(X, lim);
    if (s > 0 ? X < 2 : X > width - 2) return false;
    // a HUD panel beside a row's text (the leader passing just above or below it): the column moves on past it
    for (let pass = 0; pass < 3; pass++) {
      const x0 = X;
      for (let j = 0; j < nRows; j++) {
        const yt = Math.round(rowY[j] + t), y0 = yt - HALF - m2, y1 = yt + HALF + m2, w = mem[rows[j]].wShort + margin;
        const tx0 = s > 0 ? X : X - w, tx1 = s > 0 ? X + w : X;
        for (let e = 0; e < exclCount; e++) {
          const o = 4 * e;
          if (tx0 < excl[o + 2] && tx1 > excl[o] && y0 < excl[o + 3] && y1 > excl[o + 1]) {
            X = s > 0 ? Math.max(X, Math.ceil(excl[o + 2])) : Math.min(X, Math.floor(excl[o]));
          }
        }
      }
      if (X === x0) break;
    }
    for (let j = 0; j < nRows; j++) {
      const i = rows[j], yt = Math.round(rowY[j] + t), w = mem[i].wShort;
      const ty0 = yt - HALF, ty1 = yt + HALF;
      if (ty0 - m2 < EDGE_G || ty1 + m2 > height - EDGE_G) return false;
      if (s > 0) {
        if (X + w + margin > width - EDGE_G) return false;
        tb[0] = X; tb[2] = X + w + margin;
      } else {
        if (X - w - margin < EDGE_G) return false;
        tb[0] = X - w - margin; tb[2] = X;
      }
      tb[1] = ty0 - m2; tb[3] = ty1 + m2;
      if (blocked(tb, 2 * count, true, plates)) return false;
      // the leader: from the anchor across `a` to the text line, then level to the column
      const x = gx[i], y = gy[i], a = Math.max(D_COL, k * Math.abs(yt - y)), xe = X - s * GAP;
      lb[0] = x; lb[1] = y; lb[2] = x + s * a; lb[3] = yt;
      if (segBlocked(lb)) return false;
      lb[0] = x + s * a; lb[1] = yt; lb[2] = xe;
      if (segBlocked(lb)) return false;
      lb[0] = Math.min(x, xe); lb[1] = Math.min(y, yt); lb[2] = Math.max(x, xe); lb[3] = Math.max(y, yt);
      if (blocked(lb, 2 * count, false, false)) return false;
    }
    col[0] = X; colQ = q;
    return true;
  }
  /** Keep the column found by columnFits (at offset t): candidates and accepted rects. */
  function columnTake(g, t, count) {
    const mem = g.members, X = col[0], k = SLOPES[colQ], s = colS[0];
    for (let i = 0; i < mem.length; i++) cOn[i] = 0;
    for (let j = 0; j < nRows; j++) {
      const i = rows[j], yt = Math.round(rowY[j] + t), x = gx[i], y = gy[i], w = mem[i].wShort, xe = X - s * GAP;
      // whole-pixel leader geometry: the leader's points are rewritten only when a pixel changes
      const ra = Math.round(Math.max(D_COL, k * Math.abs(yt - y)));
      cOn[i] = 1; cS[i] = s; cA[i] = ra; cY[i] = Math.round(yt - y);
      cLead[i] = Math.max(2, Math.round(s * (xe - x) - ra));
      tb[0] = s > 0 ? X : X - w; tb[1] = yt - HALF; tb[2] = s > 0 ? X + w : X; tb[3] = yt + HALF;
      lb[0] = Math.min(x, xe); lb[1] = Math.min(y, yt) - 2; lb[2] = Math.max(x, xe); lb[3] = Math.max(y, yt) + 3;
      accept(count + j);
    }
  }
  /** Search offsets 0, +STEP, −STEP, +2·STEP … (at most `limit` px), each with a 45° leg then a steeper one,
   *  for a column that fits; NaN when none does. */
  function scanColumn(g, margin, plates, count, limit) {
    for (let s = 0; s * STEP <= limit; s++) {
      const t = s * STEP;
      for (let q = 0; q < SLOPES.length; q++) {
        if (columnFits(g, t, q, margin, plates, count)) return t;
        if (s > 0 && columnFits(g, -t, q, margin, plates, count)) return -t;
      }
    }
    return NaN;
  }
  /** A column layout, variant `v` (its rows' spacing and side). `sticky`: it is the group's current layout, so
   *  it keeps its offset, sliding a pixel at a time when it must. On a `probe` it also looks for an offset nearer the
   *  anchors that fits with HYST to spare, and takes it once one has for DWELL on end (no hopping between two
   *  offsets as the anchors drift or a count ticks). */
  function tryColumn(g, margin, plates, v, sticky, probe, count) {
    colS[0] = v < 3 ? 1 : -1;
    columnRows(g, v % 3);
    g.vNext = v;
    if (!nRows) { g.tNext = 0; g.qNext = 0; g.ex[1] = 0; return true; }
    const tm = g.tm, now = fr[3];
    let t = NaN, lim = NaN, exact = false;       // exact: the last columnFits that succeeded was the column itself
    colLim[0] = NaN;
    if (sticky) {
      if (probe) {
        const cur = Math.abs(g.t);
        const near = cur > 0 ? scanColumn(g, HYST, plates, count, cur - STEP) : NaN;
        if (Number.isNaN(near)) tm[T_NEAR] = 0;
        else {
          if (!tm[T_NEAR]) tm[T_NEAR] = now;
          if (now - tm[T_NEAR] >= DWELL && now - tm[T_SWITCH] >= DWELL) t = near;
        }
      }
      if (Number.isNaN(t)) {
        // Where it stands, its edge drifting at most a pixel (back toward the anchors, never off in a jump: past a
        // panel it now grazes, or back when it no longer does); else the nearest offset that keeps the edge, a
        // pixel at a time, the way it already went first; else, as a last step, the same letting the edge jump.
        const dir = g.t < 0 ? -1 : 1;
        for (let pass = 0; pass < 2 && Number.isNaN(t); pass++) {
          colLim[0] = pass ? NaN : g.ex[0] - colS[0];
          const slack = pass ? Infinity : 1;               // how far the edge may move
          for (let e = 0; e <= 2 * STEP && Number.isNaN(t); e++) {
            const on = g.t + dir * e, back = g.t - dir * e;
            if (columnFits(g, on, g.q, 0, plates, count) && Math.abs(col[0] - g.ex[0]) <= slack) t = on;
            else if (e && columnFits(g, back, g.q, 0, plates, count) && Math.abs(col[0] - g.ex[0]) <= slack) t = back;
          }
          if (!Number.isNaN(t)) { lim = colLim[0]; exact = true; }
        }
        colLim[0] = NaN;
      }
    }
    if (Number.isNaN(t)) { t = scanColumn(g, margin, plates, count, fr[1]); exact = margin === 0; }
    if (Number.isNaN(t)) return false;
    if (!exact) {                                    // the column itself, without the margin asked
      colLim[0] = lim;
      columnFits(g, t, colQ, 0, plates, count);
      colLim[0] = NaN;
    }
    columnTake(g, t, count);
    g.tNext = t; g.qNext = colQ; g.ex[1] = col[0];
    return true;
  }

  /** When no column fits at all: each row on its own, as near its anchor's height as its text clears the HUD, the
   *  screen's edge and the rows placed before it, on the anchor's right, else its left (over the plates). Only a row
   *  that fits nowhere is hidden. */
  function squeezeRows(g, count) {
    columnRows(g, 0);
    const mem = g.members, width = fr[0], height = fr[1];
    let slot = count;
    for (let i = 0; i < mem.length; i++) cOn[i] = 0;
    for (let j = 0; j < nRows; j++) {
      const i = rows[j], x = gx[i], y = gy[i], w = mem[i].wShort, y0 = Math.round(y - D_COL);
      let found = false;
      for (let st = 0; st * STEP <= height && !found; st++) {
        for (let c = 0; c < 4 && !found; c++) {             // below, above; the right side, then the left
          if (st === 0 && c % 2) continue;
          const yt = y0 + (c % 2 ? -st : st) * STEP, s = c < 2 ? 1 : -1;
          if (yt - HALF < EDGE || yt + HALF > height - EDGE) continue;
          const a = Math.max(D_COL, 0.5 * Math.abs(yt - y));
          let X = s > 0 ? Math.ceil(x + a + L_COL + GAP) : Math.floor(x - a - L_COL - GAP);
          for (let e = 0; e < exclCount; e++) {             // past a panel beside the text (as columnFits)
            const o = 4 * e, tx0 = s > 0 ? X : X - w, tx1 = s > 0 ? X + w : X;
            if (tx0 < excl[o + 2] && tx1 > excl[o] && yt - HALF < excl[o + 3] && yt + HALF > excl[o + 1]) {
              X = s > 0 ? Math.max(X, Math.ceil(excl[o + 2])) : Math.min(X, Math.floor(excl[o]));
            }
          }
          const tx0 = s > 0 ? X : X - w, tx1 = s > 0 ? X + w : X, xe = X - s * GAP;
          if (tx0 < EDGE || tx1 > width - EDGE) continue;
          tb[0] = tx0; tb[1] = yt - HALF; tb[2] = tx1; tb[3] = yt + HALF;
          if (blocked(tb, 2 * slot, true, false)) continue;
          lb[0] = x; lb[1] = y; lb[2] = x + s * a; lb[3] = yt;
          if (segBlocked(lb)) continue;
          lb[0] = x + s * a; lb[1] = yt; lb[2] = xe;
          if (segBlocked(lb)) continue;
          lb[0] = Math.min(x, xe); lb[1] = Math.min(y, yt); lb[2] = Math.max(x, xe); lb[3] = Math.max(y, yt);
          if (blocked(lb, 2 * slot, false, false)) continue;
          const ra = Math.round(a);
          cOn[i] = 1; cS[i] = s; cA[i] = ra; cY[i] = Math.round(yt - y);
          cLead[i] = Math.max(2, Math.round(s * (xe - x) - ra));
          tb[0] = tx0; tb[1] = yt - HALF; tb[2] = tx1; tb[3] = yt + HALF;
          lb[0] = Math.min(x, xe); lb[1] = Math.min(y, yt) - 2; lb[2] = Math.max(x, xe); lb[3] = Math.max(y, yt) + 3;
          accept(slot++);
          found = true;
        }
      }
    }
    g.tNext = 0; g.qNext = 0; g.vNext = ROWS; g.ex[1] = 0;
  }

  /** Column variants `from` … `to` − 1: the current one first when `sticky` (so the column never hops between two
   *  while both fit), then the rest in order. */
  function tryColumns(g, margin, plates, from, to, sticky, probe, count) {
    const cur = sticky ? g.v : -1;
    if (cur >= from && cur < to && tryColumn(g, margin, plates, cur, true, probe, count)) return true;
    for (let v = from; v < to; v++) if (v !== cur && tryColumn(g, margin, plates, v, false, false, count)) return true;
    return false;
  }
  /** Try layout `m` (see MODES) with `margin` px to spare; `sticky`: it is the current one. The last resort always
   *  succeeds: the column let onto the plates, spaced like its anchors, then packed; then the same on the anchors'
   *  left (over the plates, where a panel takes the room on their right); else each row where it fits. */
  function tryMode(g, m, margin, sticky, probe, count) {
    if (m === M_FULL) return tryAnchored(g, true, margin, count);
    if (m === M_SHORT) return tryAnchored(g, false, margin, count);
    if (m === M_COLUMN) return tryColumn(g, margin, true, 0, sticky, probe, count);
    if (m === M_PACKED) return tryColumns(g, margin, true, 1, 3, sticky, probe, count);
    // (rows on their own: the columns are looked for again only every PROBE ms)
    if ((!sticky || g.v !== ROWS || probe) && tryColumns(g, 0, false, 0, ROWS, sticky, probe, count)) return true;
    squeezeRows(g, count);
    return true;
  }

  /** Lay out a group (every member at once); returns the new count of accepted notes. */
  function layoutGroup(g, camera, count) {
    const mem = g.members, width = fr[0], height = fr[1], now = fr[3], tm = g.tm, since = g.since;
    let live = 0;
    for (let i = 0; i < mem.length; i++) {
      const n = mem[i];
      gLive[i] = 0;
      if (!n.active || count + live >= maxNotes) continue;
      ndc.copy(n.world).project(camera);
      gx[i] = (ndc.x * 0.5 + 0.5) * width; gy[i] = (0.5 - ndc.y * 0.5) * height;
      // the anchor itself must be in view and not under a HUD panel
      if (ndc.z > -1 && ndc.z < 1 && anchorClear(i, width, height)) { gLive[i] = 1; live++; }
    }
    if (!live) {
      for (let i = 0; i < mem.length; i++) setOn(mem[i], false);
      if (g.shown) { g.shown = false; tm[T_TRIG] = 0; tm[T_NEAR] = 0; since.fill(0); }
      return count;
    }
    // Has the view settled? Anchors or plates moving (a flight, a resize, the plates growing), or a count ticking
    // (set()), restart the clock. Straying MOVED px from where the last fresh choice saw them asks for a new one once
    // it has, as a resize, a HUD change or the fonts arriving do (fr[4], the last of those): so a view reached one
    // way is laid out as a fresh load of it is. While a run plays it waits: a choice made then (with no room to
    // spare, as a fresh one may be) could be undone a moment later.
    let moved = false, far = false;
    for (let i = 0; i < mem.length; i++) {
      if (gLive[i] !== g.sLive[i]) { moved = true; far = true; }
      if (!gLive[i]) continue;
      if (Math.abs(gx[i] - g.sx[i]) > EPS || Math.abs(gy[i] - g.sy[i]) > EPS) moved = true;
      if (Math.abs(gx[i] - g.fx[i]) > MOVED || Math.abs(gy[i] - g.fy[i]) > MOVED) far = true;
    }
    const nOb = Math.min(obstN, 4), sOb = g.sObst;
    for (let k = 0; k < 4 * nOb && !moved; k++) if (Math.abs(obst[k] - sOb[k]) > EPS) moved = true;
    if (moved) {
      tm[T_MOVE] = now;
      for (let i = 0; i < mem.length; i++) { g.sLive[i] = gLive[i]; g.sx[i] = gx[i]; g.sy[i] = gy[i]; }
      for (let k = 0; k < 4 * nOb; k++) sOb[k] = obst[k];
    }
    if (fr[4] > tm[T_SEEN]) { tm[T_SEEN] = fr[4]; tm[T_TRIG] = fr[4]; }
    else if (far && !tm[T_TRIG]) tm[T_TRIG] = now;
    const shown = g.shown;
    const fresh = !shown ||
      (tm[T_TRIG] > 0 && now - tm[T_TRIG] >= SETTLE && now - tm[T_MOVE] >= STILL && now - tm[T_SWITCH] >= DWELL);
    const oldMode = shown ? g.mode : -1, oldT = g.t, oldV = g.v, oldX = g.ex[0];
    if (fresh) {
      // the most generous layout that fits, as on a first showing (whose view is still easing in: it is chosen
      // afresh once more when that has settled)
      g.mode = M_FULL; g.t = 0; g.q = 0; g.v = 0; g.ex[0] = 0;
      since.fill(0); tm[T_NEAR] = 0;
      tm[T_TRIG] = shown ? 0 : now;
      for (let i = 0; i < mem.length; i++) { g.fx[i] = gx[i]; g.fy[i] = gy[i]; }
    }
    // A more generous layout takes over once it has fitted, with HYST to spare, for DWELL on end (looked at every
    // PROBE ms), and not within DWELL of the last change; else the current one, if it still fits (a column keeps its
    // offset); else, at once, the next that fits.
    const probe = !fresh && now >= tm[T_PROBE];
    if (probe) tm[T_PROBE] = now + PROBE;
    let mode = -1;
    if (probe) {
      for (let m = 0; m < g.mode; m++) {
        if (!tryMode(g, m, HYST, false, false, count)) { since[m] = 0; continue; }
        if (!since[m]) since[m] = now;
        if (now - since[m] >= DWELL && now - tm[T_SWITCH] >= DWELL) { mode = m; break; }
      }
    }
    for (let m = g.mode; m < M_SQUEEZE && mode < 0; m++) {
      if (tryMode(g, m, 0, m === g.mode && !fresh, probe, count)) mode = m;
    }
    if (mode < 0) { mode = M_SQUEEZE; tryMode(g, M_SQUEEZE, 0, g.mode === M_SQUEEZE && !fresh, probe, count); }
    const t = mode >= M_COLUMN ? g.tNext : 0, v = mode >= M_COLUMN ? g.vNext : 0, x = mode >= M_COLUMN ? g.ex[1] : 0;
    const jumped = Math.abs(t - oldT) > 2 * STEP || Math.abs(x - oldX) > 2 * STEP;     // (not a slide)
    if (mode !== oldMode || v !== oldV || jumped) {
      tm[T_SWITCH] = now; tm[T_NEAR] = 0;
      for (let m = mode; m < since.length; m++) since[m] = 0;
    }
    g.t = t; g.v = v; g.ex[0] = x;
    g.q = mode >= M_COLUMN ? g.qNext : 0;
    g.mode = mode;
    g.shown = true;
    // when an update is next due though nothing else may render: the fresh choice once the view has settled, or a
    // more generous layout (a nearer column) that has fitted long enough
    let w = Infinity;
    if (tm[T_TRIG]) w = Math.max(tm[T_TRIG] + SETTLE, tm[T_MOVE] + STILL, tm[T_SWITCH] + DWELL);
    for (let m = 0; m < mode; m++) {
      if (since[m]) w = Math.min(w, Math.max(since[m] + DWELL, tm[T_SWITCH] + DWELL, tm[T_PROBE]));
    }
    if (tm[T_NEAR]) w = Math.min(w, Math.max(tm[T_NEAR] + DWELL, tm[T_SWITCH] + DWELL, tm[T_PROBE]));
    if (w < wake[0]) wake[0] = w;
    for (let i = 0; i < mem.length; i++) {
      const n = mem[i];
      if (!cOn[i]) { setOn(n, false); continue; }
      const full = mode === M_FULL || !n.short;
      showText(n, full ? n.text : n.short);
      boxWidth(n, cS[i] < 0 ? (full ? n.wFull : n.wShort) : 0);
      setLeader(n, i);
      moveTo(n, i);
      setOn(n, true);
      count++;
    }
    return count;
  }

  return {
    layer,
    setMax(n) { maxNotes = n; },
    /** Rects ({left, top, right, bottom} in canvas CSS px) that notes must not overlap: the HUD's panels. */
    setExclusions(rects) {
      let n = 0, changed = false;
      for (const r of rects || []) {
        if (n >= MAX_EXCL) break;
        if (!(r && r.right > r.left && r.bottom > r.top)) continue;
        const o = 4 * n++;
        const x0 = r.left - 6, y0 = r.top - 6, x1 = r.right + 6, y1 = r.bottom + 6;
        if (excl[o] !== x0 || excl[o + 1] !== y0 || excl[o + 2] !== x1 || excl[o + 3] !== y1) changed = true;
        excl[o] = x0; excl[o + 1] = y0; excl[o + 2] = x1; excl[o + 3] = y1;
      }
      if (n !== exclCount) changed = true;
      exclCount = n;
      if (changed) trig = true;
      return changed;        // true when the notes need a new layout
    },
    setStill(on) { layer.classList.toggle('is-still', !!on); },
    /** [ms]: performance.now() by which update() wants to run again although nothing may have changed (a group's
     *  fresh choice once the view settles, or an upgrade that has waited long enough); Infinity = never. */
    wake,

    /** Declare or update a note. Only text changes touch the DOM. `landmark` = a dimmed anatomical landmark that is
     *  not a colour key (no swatch, no count). An empty `value` drops the value slot (and its flex gap).
     *  `side` = 1 / −1 keeps the text on that side of the anchor (hidden rather than flipped across); 0 = either.
     *  `group` = a name: the group's notes are laid out together (see the header), `short` = a shorter name for
     *  its compact layouts. */
    set(key, { priority, text, short = '', group = '', value = '', swatch = '', landmark = false, side = 0, x, y, z }) {
      let n = notes.get(key);
      if (!n) {
        n = makeNote(key);
        notes.set(key, n);
        order.push(n);
        groupsDirty = true;
      }
      if (n.priority !== priority) {
        n.priority = priority; order.sort((a, b) => a.priority - b.priority); groupsDirty = true;
      }
      n.world.set(x, y, z);
      n.active = true;
      n.fixedSide = side > 0 ? 1 : side < 0 ? -1 : 0;
      const g = group ? (groups.get(group) || groups.set(group, makeGroup(group)).get(group)) : null;
      if (n.group !== g) {
        n.group = g; groupsDirty = true; n.measured = false;
        n.resDigits = 0; n.resv = '';
        if (g) reserve(n, value);
      }
      if (n.text !== text) { n.text = text; n.measured = false; }
      if (n.short !== short) { n.short = short; n.measured = false; }
      if (n.value !== value) {
        if (g) {
          if (reserve(n, value)) n.measured = false;           // measured at its reserved shape
          g.tm[T_MOVE] = performance.now();                    // a count ticking: the view has not settled
        }
        else if (!sameShape(n.value, value)) n.measured = false;   // 1,204 → 1,219 keeps its width (tabular digits)
        n.value = value; n.v.textContent = value; n.v.style.display = value ? '' : 'none';
      }
      if (n.swatch !== swatch) { n.swatch = swatch; n.sw.style.background = swatch; n.sw.style.display = swatch ? '' : 'none'; n.measured = false; }
      if (n.landmark !== landmark) { n.landmark = landmark; n.el.classList.toggle('is-landmark', landmark); }
    },
    /** A declared note's world anchor (a Vector3; null if undeclared): the caller may move it every frame, with no
     *  DOM work, for an anchor that follows continuous motion. */
    anchor(key) { const n = notes.get(key); return n ? n.world : null; },
    hide(key) { const n = notes.get(key); if (n) n.active = false; },
    hideAll() { for (const n of order) n.active = false; },

    /** Project anchors and declutter. `avoid` = the organism's screen ellipse {x, y, rx, ry} (or null): leaders point
     *  away from its centre and stretch until the label clears it. `obstacles` = screen ellipses [cx, cy, rx, ry, …]
     *  (the first `obstacleCount`) that no text may touch. */
    update(camera, width, height, avoid, obstacles = null, obstacleCount = 0) {
      const now = performance.now();
      fr[0] = width; fr[1] = height; fr[2] = avoid ? avoid.x : width / 2; fr[3] = now; av = avoid || null;
      obst = obstacles; obstN = obstacles ? Math.min(obstacleCount, (obstacles.length / 4) | 0) : 0;
      if (trig || width !== lastW || height !== lastH) fr[4] = now;
      lastW = width; lastH = height; trig = false; frame++;
      wake[0] = Infinity;
      if (groupsDirty) rebuildGroups();
      // Reads before writes: measure every note whose width is unknown first (a small forced layout of the ruler per
      // cache miss, and none when every width is cached), so nothing below reads layout after a transform write.
      for (const n of order) {
        if (!n.active || n.measured) continue;
        n.wFull = widthOf(n, n.text);
        n.wShort = n.short ? widthOf(n, n.short) : n.wFull;
        n.measured = true;
      }
      let count = 0;
      for (const n of order) {
        const g = n.group;
        if (g) {
          if (g.frame !== frame) { g.frame = frame; count = layoutGroup(g, camera, count); }
          continue;
        }
        let show = false;
        if (n.active && count < maxNotes) {
          ndc.copy(n.world).project(camera);
          const inFront = ndc.z > -1 && ndc.z < 1;
          gx[MAXG] = (ndc.x * 0.5 + 0.5) * width; gy[MAXG] = (0.5 - ndc.y * 0.5) * height;
          // the anchor itself must be in view and not under a HUD panel
          if (inFront && anchorClear(MAXG, width, height)) {
            if (fitAnchored(n, MAXG, n.wFull, count, 0, EDGE)) {
              showText(n, n.text);
              setLeader(n, MAXG);
              moveTo(n, MAXG);
              show = true;
              count++;
            }
          }
        }
        setOn(n, show);
      }
      return count;
    },

    visible() {
      return order.filter((n) => n.on).map((n) => ({ key: n.key, text: n.shown, value: n.value, landmark: n.landmark, x: n.x, y: n.y }));
    },
    /** QA: a group's current layout (see MODES), its column's vertical offset (px), leader slope and variant, and
     *  whether a fresh choice is pending. */
    groupLayout(name) {
      const g = groups.get(name);
      return g ? { mode: MODES[g.mode], t: g.t, k: SLOPES[g.q], v: g.v, shown: g.shown, pending: g.tm[T_TRIG] > 0 }
        : null;
    },
    /** QA: the current exclusion rects. */
    exclusions() { return Array.from(excl.subarray(0, 4 * exclCount)); },

    dispose() {
      document.fonts?.removeEventListener?.('loadingdone', onFonts);
      layer.remove();
      notes.clear();
      groups.clear();
      order.length = 0;
    },
  };
}
