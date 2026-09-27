// src/scene/ramps.js — colour ramps for the continuous views (SPEC §4.5.2). Pure data (no three), so the HUD can
// import the same stops for its legend ramps and the two stay identical.
//
// Stops are sRGB hex and are interpolated in sRGB space, like a CSS linear-gradient, so a legend drawn with
//   `linear-gradient(90deg, ${stops.map(([t, c]) => `${c} ${t * 100}%`).join(',')})`
// matches the 3D colours. Rows of the ramp texture are indexed by VIEW_INDEX (rows 0 and 1 are unused).

export const VIEW_RAMPS = Object.freeze({
  energy:    [[0, '#0f3a4a'], [0.25, '#1d6f8a'], [0.5, '#f4f1e8'], [0.75, '#ffc15a'], [1, '#ff8a3d']], // at clamp(E/threshold / 2)
  age:       [[0, '#34C28A'], [0.5, '#F2EEDF'], [0.85, '#ff9a6b'], [1, '#ff5a3d']],                   // at age/maxAge
  midline:   [[0, '#0e1530'], [0.75, '#8E5CFF'], [1, '#efe6ff']],
  ap:        [[0, '#141a2a'], [0.55, '#b07a1e'], [0.8, '#F2B544'], [1, '#fff4d6']],
  activator: [[0, '#1a0f14'], [0.5, '#9c2f22'], [0.8, '#F0604A'], [1, '#ffe0d6']],
  inhibitor: [[0, '#0b1426'], [0.5, '#1f4f9a'], [0.8, '#4A94F0'], [1, '#e6f2ff']],
});

// Depth view: band 1..4 take the colour of the fate the rule assigns there (ecto, meso, endo, stem = TYPE 2, 3, 4, 1).
// Inside a band, lightness steps down with depth by up to DEPTH_STEP (the outermost ring of a band is the exact colour).
export const DEPTH_BAND_TYPE = [0, 2, 3, 4, 1];
export const DEPTH_STEP = 0.3;

const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Sample a ramp at t ∈ [0,1] → [r,g,b] sRGB bytes. */
export function sampleRamp(stops, t) {
  const x = Math.min(1, Math.max(0, t));
  let k = 0;
  while (k < stops.length - 2 && stops[k + 1][0] < x) k++;
  const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
  const f = t1 > t0 ? Math.min(1, Math.max(0, (x - t0) / (t1 - t0))) : 0;
  const a = hexRgb(c0), b = hexRgb(c1);
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * f));
}

/** 256 × 8 RGBA8 sRGB bytes, one row per view (VIEW_INDEX order: cells, depth, energy, age, midline, ap, activator, inhibitor). */
export function buildRampBytes() {
  const W = 256, rows = ['cells', 'depth', 'energy', 'age', 'midline', 'ap', 'activator', 'inhibitor'];
  const out = new Uint8Array(W * rows.length * 4);
  rows.forEach((id, row) => {
    const stops = VIEW_RAMPS[id];
    for (let u = 0; u < W; u++) {
      const o = (row * W + u) * 4;
      const c = stops ? sampleRamp(stops, u / (W - 1)) : [0, 0, 0];
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
    }
  });
  return out;
}
