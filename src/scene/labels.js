// src/scene/labels.js — CSS2D-style annotation layer: scientific-figure callouts (a 3px dot on the anchor, a 1px
// leader running diagonally then horizontally, a small-caps label with a mono value). World anchors are projected
// every rendered frame; notes are decluttered by priority. Default styles are injected once with zero specificity
// (:where), so the HUD stylesheet can override any of them.
import { Vector3 } from 'three';

const STYLE_ID = 'ee-note-style';
const CSS = `
:where(.ee-notes){position:absolute;inset:0;pointer-events:none;overflow:hidden;contain:strict}
:where(.ee-note){position:absolute;left:0;top:0;width:0;height:0;opacity:0;transition:opacity .28s ease;will-change:transform,opacity}
:where(.ee-note.is-on){opacity:1}
:where(.ee-notes.is-still .ee-note){transition:none}
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
const SVGNS = 'http://www.w3.org/2000/svg';

export function createLabels(root, { max = 6 } = {}) {
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
  const accepted = new Float32Array(4 * 2 * 16);   // accepted rects (label + leader bbox) for declutter
  const ndc = new Vector3();
  let maxNotes = max;
  // Text widths, cached by what decides them: the key text, the value's shape (tabular digits: every digit is as wide
  // as '0'; commas and arrows are not) and whether the swatch shows. A value that ticks from 1,204 to 1,219 then
  // costs no layout read. Widths depend on the web fonts: the cache is dropped once they have loaded.
  const widths = new Map();
  const widthKey = (n) => `${n.text}|${n.value.replace(/\d/g, '0')}|${n.swatch ? 1 : 0}`;
  document.fonts?.ready?.then(() => { widths.clear(); for (const n of order) n.measured = false; });

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
      text: '', value: '', swatch: '', landmark: false, width: 0, side: 0, lead: 0, x: 0, y: 0, measured: false,
    };
  }

  function setSide(n, side, lead) {
    if (n.side === side && n.lead === lead) return;
    n.side = side; n.lead = lead;
    const s = side > 0 ? 1 : -1;
    n.pl.setAttribute('points', `0,0 ${s * D},${-D} ${s * (D + lead)},${-D}`);
    if (s > 0) { n.txt.style.left = `${D + lead + GAP}px`; n.txt.style.right = ''; }
    else { n.txt.style.left = ''; n.txt.style.right = `${D + lead + GAP}px`; }
    n.txt.style.top = `${-D}px`;
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

  function overlaps(x0, y0, x1, y1, count) {
    for (let i = 0; i < count; i++) {
      const o = 4 * i;
      if (x0 < accepted[o + 2] && x1 > accepted[o] && y0 < accepted[o + 3] && y1 > accepted[o + 1]) return true;
    }
    return false;
  }
  // Screen rects the notes must keep clear of (the HUD's panels), [x0, y0, x1, y1] per rect in canvas CSS px.
  const MAX_EXCL = 12;
  const excl = new Float64Array(4 * MAX_EXCL);
  let exclCount = 0;
  function excluded(x0, y0, x1, y1) {
    for (let i = 0; i < exclCount; i++) {
      const o = 4 * i;
      if (x0 < excl[o + 2] && x1 > excl[o] && y0 < excl[o + 3] && y1 > excl[o + 1]) return true;
    }
    return false;
  }
  // Does a text box sit on the organism's screen ellipse? Its centre inside, or its point nearest the organism's
  // centre well inside (80% of the radii): grazing the soft edge is allowed, covering tissue is not.
  function onEllipse(av, x0, y0, x1, y1) {
    if (!av || !(av.rx > 0) || !(av.ry > 0)) return false;
    const e = (x, y, k) => ((x - av.x) / (k * av.rx)) ** 2 + ((y - av.y) / (k * av.ry)) ** 2 < 1;
    const nx = Math.min(Math.max(av.x, x0), x1), ny = Math.min(Math.max(av.y, y0), y1);
    return e((x0 + x1) / 2, (y0 + y1) / 2, 1) || e(nx, ny, 0.8);
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
      return changed;        // true when the notes need a new layout
    },
    setStill(on) { layer.classList.toggle('is-still', !!on); },

    /** Declare or update a note. Only text changes touch the DOM. `landmark` = a dimmed anatomical landmark that is
     *  not a colour key (no swatch, no count). An empty `value` drops the value slot (and its flex gap). */
    set(key, { priority, text, value = '', swatch = '', landmark = false, x, y, z }) {
      let n = notes.get(key);
      if (!n) {
        n = makeNote(key);
        notes.set(key, n);
        order.push(n);
      }
      if (n.priority !== priority) { n.priority = priority; order.sort((a, b) => a.priority - b.priority); }
      n.world.set(x, y, z);
      n.active = true;
      if (n.text !== text) { n.text = text; n.k.textContent = text; n.measured = false; }
      if (n.value !== value) { n.value = value; n.v.textContent = value; n.v.style.display = value ? '' : 'none'; n.measured = false; }
      if (n.swatch !== swatch) { n.swatch = swatch; n.sw.style.background = swatch; n.sw.style.display = swatch ? '' : 'none'; n.measured = false; }
      if (n.landmark !== landmark) { n.landmark = landmark; n.el.classList.toggle('is-landmark', landmark); }
    },
    hide(key) { const n = notes.get(key); if (n) n.active = false; },
    hideAll() { for (const n of order) n.active = false; },

    /** Project anchors and declutter. `avoid` = the organism's screen ellipse {x, y, rx, ry} (or null): leaders point
     *  away from its centre and stretch until the label clears it. */
    update(camera, width, height, avoid) {
      const cxScreen = avoid ? avoid.x : width / 2;
      // Reads before writes: measure every note whose width is unknown first (one layout at most, and only on a
      // cache miss), so nothing below reads layout after a transform or leader write.
      for (const n of order) {
        if (!n.active || n.measured) continue;
        const k = widthKey(n);
        let w = widths.get(k);
        if (w === undefined) { w = n.txt.offsetWidth || n.text.length * 8; if (widths.size > 256) widths.clear(); widths.set(k, w); }
        n.width = w; n.measured = true;
      }
      let count = 0;
      for (const n of order) {
        let show = false;
        if (n.active && count < maxNotes) {
          ndc.copy(n.world).project(camera);
          const inFront = ndc.z > -1 && ndc.z < 1;
          const x = (ndc.x * 0.5 + 0.5) * width, y = (0.5 - ndc.y * 0.5) * height;
          // the anchor itself must be in view and not under a HUD panel
          if (inFront && x > 4 && x < width - 4 && y > 4 && y < height - 4 && !excluded(x - 3, y - 3, x + 3, y + 3)) {
            const pref = x >= cxScreen ? 1 : -1;
            // When the organism fills most of the view there is no room beside it: then a note may sit on the tissue.
            const fillsView = !avoid || !(avoid.rx < 0.36 * width);
            for (let attempt = 0; attempt < 4 && !show; attempt++) {
              const s = attempt % 2 === 0 ? pref : -pref;
              const lead = attempt < 2 ? leadFor(x, y - D, s, avoid, width) : L;   // last resort: short leader
              const tx0 = s > 0 ? x + D + lead + GAP : x - D - lead - GAP - n.width;
              const tx1 = tx0 + n.width;
              const ty0 = y - D - 9, ty1 = y - D + 9;
              if (tx0 < 2 || tx1 > width - 2 || ty0 < 2) continue;
              const lx0 = Math.min(x, x + s * (D + lead)), lx1 = Math.max(x, x + s * (D + lead));
              if (overlaps(tx0, ty0, tx1, ty1, 2 * count) || overlaps(lx0, y - D - 2, lx1, y + 3, 2 * count)) continue;
              if (excluded(tx0, ty0, tx1, ty1) || excluded(lx0, y - D - 2, lx1, y + 3)) continue;
              if (!fillsView && onEllipse(avoid, tx0, ty0, tx1, ty1)) continue;
              // a leader never runs across the specimen to its far side (the hero framing leaves little room beside it)
              if (avoid && lx0 < avoid.x && lx1 > avoid.x && Math.abs(y - D - avoid.y) < 0.85 * avoid.ry) continue;
              const o = 8 * count;
              accepted[o] = tx0 - 4; accepted[o + 1] = ty0; accepted[o + 2] = tx1 + 4; accepted[o + 3] = ty1;
              accepted[o + 4] = lx0; accepted[o + 5] = y - D - 2; accepted[o + 6] = lx1; accepted[o + 7] = y + 3;
              setSide(n, s, lead);
              show = true;
              count++;
            }
            if (show && (Math.abs(n.x - x) > 0.25 || Math.abs(n.y - y) > 0.25)) {
              n.x = x; n.y = y;
              n.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
            }
          }
        }
        if (show !== n.on) { n.on = show; n.el.classList.toggle('is-on', show); }
      }
      return count;
    },

    visible() {
      return order.filter((n) => n.on).map((n) => ({ key: n.key, text: n.text, value: n.value, landmark: n.landmark, x: n.x, y: n.y }));
    },
    /** QA: the current exclusion rects. */
    exclusions() { return Array.from(excl.subarray(0, 4 * exclCount)); },

    dispose() {
      layer.remove();
      notes.clear();
      order.length = 0;
    },
  };
}
