// src/ui/ramps.js — colour ramps for the legend and the stains rail previews.
// They mirror the scene's display pass (SPEC §4.5.2, Depth per ADDENDUM §C.1) so a legend swatch reads the same
// colour as the columns. If the scene changes a ramp, change it here too.

import { TISSUE_HEX, TYPE } from '../shared.js';

// [position 0..1, colour]
export const RAMPS = {
  energy:    [[0, '#0f3a4a'], [0.25, '#1d6f8a'], [0.5, '#f4f1e8'], [0.75, '#ffc15a'], [1, '#ff8a3d']],
  age:       [[0, '#34C28A'], [0.5, '#F2EEDF'], [0.85, '#ff9a6b'], [1, '#ff5a3d']],
  midline:   [[0, '#0e1530'], [0.75, '#8E5CFF'], [1, '#efe6ff']],
  ap:        [[0, '#141a2a'], [0.55, '#b07a1e'], [0.8, '#F2B544'], [1, '#fff4d6']],
  activator: [[0, '#1a0f14'], [0.5, '#9c2f22'], [0.8, '#F0604A'], [1, '#ffe0d6']],
  inhibitor: [[0, '#0b1426'], [0.5, '#1f4f9a'], [0.8, '#4A94F0'], [1, '#e6f2ff']],
};

// Depth view: band 1..4 take the ecto, meso, endo and stem colours.
export const BAND_HEX = ['#000000', TISSUE_HEX[TYPE.ECTO], TISSUE_HEX[TYPE.MESO], TISSUE_HEX[TYPE.ENDO], TISSUE_HEX[TYPE.STEM]];

/** CSS linear-gradient for a ramp (left → right). */
export function rampCss(stops, dir = '90deg') {
  return `linear-gradient(${dir}, ${stops.map(([p, c]) => `${c} ${(p * 100).toFixed(1)}%`).join(', ')})`;
}

/** Hard-edged segments, e.g. the tissue or band preview strips. */
export function segmentsCss(colours, dir = '90deg') {
  const n = colours.length;
  const parts = colours.map((c, i) => `${c} ${((i / n) * 100).toFixed(2)}% ${(((i + 1) / n) * 100).toFixed(2)}%`);
  return `linear-gradient(${dir}, ${parts.join(', ')})`;
}

/** The 24×6 preview shown next to each stain in the rail. */
export function previewCss(viewId) {
  switch (viewId) {
    case 'cells': return segmentsCss([TYPE.ECTO, TYPE.NEURAL, TYPE.MESO, TYPE.MUSCLE, TYPE.VESSEL, TYPE.ENDO, TYPE.STEM].map((t) => TISSUE_HEX[t]));
    case 'depth': return segmentsCss([BAND_HEX[1], BAND_HEX[2], BAND_HEX[3], BAND_HEX[4]]);
    default: return Object.hasOwn(RAMPS, viewId) ? rampCss(RAMPS[viewId]) : 'none';   // own keys only (never toString)
  }
}

/** Field value → 0..1 position on a legend ramp, honouring FIELD_INFO's scale. */
export function fieldPos(v, info) {
  const max = info?.domain?.[1] || 1;
  const t = Math.min(1, Math.max(0, v / max));
  return info?.scale === 'sqrt' ? Math.sqrt(t) : t;
}
