// src/scene/quality.js — quality tiers (SPEC §4.13, ADDENDUM §C.1) and cell level-of-detail profiles.
// Pure data: no three import, so main.js can read the table for adaptive quality.

export const TIER_NAMES = ['high', 'medium', 'low'];

export const TIERS = Object.freeze({
  high: Object.freeze({
    // No MSAA: on Apple GPUs (ANGLE/Metal) a multisampled HDR target with a depth texture went fully black once the
    // cell count grew (≈1.3M triangles at DPR 2). SPEC §4.12 names samples 0 + FXAA as the fallback; at DPR 2 it is
    // effectively supersampled anyway.
    name: 'high', dprCap: 2.0, dprMin: 1.0, msaa: 0, fxaa: true, lod: 'high',
    shadowSize: 2048, shadowEvery: 1, sheen: false,
    dof: Object.freeze({ taps: 28, maxCoc: 30 }), bloomScale: 0.5, grain: true, labels: 6, motes: 512,
  }),
  medium: Object.freeze({
    name: 'medium', dprCap: 1.5, dprMin: 0.75, msaa: 0, fxaa: true, lod: 'medium',
    shadowSize: 1024, shadowEvery: 2, sheen: false,
    dof: Object.freeze({ taps: 20, maxCoc: 26 }), bloomScale: 0.5, grain: true, labels: 6, motes: 256,
  }),
  low: Object.freeze({
    name: 'low', dprCap: 1.0, dprMin: 0.5, msaa: 0, fxaa: true, lod: 'low',
    shadowSize: 0, shadowEvery: 0, sheen: false,
    dof: null, bloomScale: 0.25, grain: false, labels: 3, motes: 0,
  }),
});

// Cell geometry per LOD: a base ring (on the floor), a skirt ring (the groove floor between neighbours) and a
// rounded cap sampled at the listed angles on a superellipse of exponent `n` (2 = circle; a little more gives a
// soft pillow): 0° = equator, 90° = pole, negative = the undercut below the equator (a stem cell's lower hemisphere,
// which makes it a pearl; other types collapse it to a slight rounding). Triangles = radial × (points − 1) × 2.
// `shadow` is the proxy that only casts shadows: no skirt, a two-point cap.
export const LOD = Object.freeze({
  high:   { radial: 13, cap: [-66, -34, 0, 26, 52, 74, 90], n: 2.2, skirt: true },   // 208
  medium: { radial: 12, cap: [-58, 0, 34, 64, 90], n: 2.2, skirt: true },            // 144
  low:    { radial: 8, cap: [-50, 0, 45, 90], n: 2.2, skirt: true },                 // 80
  shadow: { radial: 8, cap: [0, 90], n: 2.2, skirt: false },                         // 32
  // While the embryo is small its cells are large on screen, and there are few of them: tessellate generously.
  macro:  { radial: 26, cap: [-78, -58, -38, -18, 0, 16, 32, 48, 64, 78, 90], n: 2.2, skirt: true },   // 624
  fine:   { radial: 16, cap: [-66, -34, 0, 24, 48, 70, 90], n: 2.2, skirt: true },                     // 256
});

/** The LOD for a tier at a given cell count (hysteresis: `current` is kept within ±12 % of a threshold). */
export function lodForCount(tierLod, count, current) {
  const pick = (n) => (tierLod === 'low' ? (n < 900 ? 'fine' : 'low') : n < 900 ? 'macro' : n < 2600 ? 'fine' : tierLod);
  const want = pick(count);
  if (want === current) return current;
  return pick(count * 1.12) === pick(count / 1.12) ? want : (current || want);
}

export function tierOf(name) {
  return TIERS[name] || TIERS.medium;
}
