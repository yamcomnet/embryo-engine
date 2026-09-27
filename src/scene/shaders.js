// src/scene/shaders.js — GLSL for the scene: display pass, cell material patches, agar, void, light cone, dust,
// depth of field and the final composite. Grid texel (x, y) is cell idx = y*200 + x; it sits at world (x − 99.5, ·, y − 99.5).

// ─── relief: column height from depth (shared by the display pass and stage.js, which mirrors it for picking) ──
// h(d) = 0.6 + H · (u(2 − u))^P + T · (bands crossed), u = (d − ½) / D.
// A rounded cap (a circle for P = ½; softer shoulders for P > ½) normalised by D, a slowly eased copy of the
// deepest live depth, plus a small terrace step at each Rule 3 band edge (e1, e2, e3). Monotonic in depth.
export const RELIEF_GLSL = /* glsl */`
uniform vec4 uDome;          // D (eased dmax), H (dome height), P (profile exponent), T (terrace step)
uniform vec4 uBands;         // e1, e2, e3, dmax
float hOf(float d) {
  d = max(d, 1.0);
  float u = clamp((d - 0.5) / max(uDome.x, 1.0), 0.0, 1.0);
  float terr = step(uBands.x + 0.5, d) + step(uBands.y + 0.5, d) + step(uBands.z - 0.5, d);
  return 0.6 + uDome.y * pow(u * (2.0 - u), uDome.z) + uDome.w * terr;
}`;

// ─── display pass (RawShaderMaterial, GLSL3, MRT) ────────────────────────────────────────────────────
// Writes per texel A = (linear view colour, column top), B = (glow, E/threshold, heightfield AO, 0) and
// C = (relief slope xz), each an exponential moving average of its target so nothing strobes faster than ~1.3 Hz.

export const FULLSCREEN_VERT = /* glsl */`
precision highp float;
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

export const DISPLAY_FRAG = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uCell;
uniform sampler2D uLife;
uniform sampler2D uMorph;
uniform sampler2D uRamps;
uniform sampler2D uPrevA;
uniform sampler2D uPrevB;
uniform sampler2D uPrevC;
uniform vec3 uPalette[8];
uniform int uView;
uniform int uIsolate;
uniform vec4 uChanMask;
uniform float uDomainMax;
uniform float uSqrtScale;
uniform float uK;
uniform float uVisRel;
uniform vec2 uThr;          // divThreshStem, divThreshDiff
uniform float uDepthStep;
uniform float uGlowK;
${RELIEF_GLSL}
in vec2 vUv;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
layout(location = 2) out vec4 oC;

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 ramp(int row, float u) {
  return texture(uRamps, vec2(clamp(u, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, (float(row) + 0.5) / 8.0)).rgb;
}
float nbH(ivec2 c) {
  vec4 n = texelFetch(uCell, (c + 200) % 200, 0);
  return n.r > 0.002 ? hOf(n.b * 255.0) : 0.0;
}

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 cell = texelFetch(uCell, tc, 0);
  vec4 life = texelFetch(uLife, tc, 0);
  vec4 pA = texelFetch(uPrevA, tc, 0);
  vec4 pB = texelFetch(uPrevB, tc, 0);
  vec4 pC = texelFetch(uPrevC, tc, 0);
  int type = int(cell.r * 255.0 + 0.5);
  int bits = int(life.g * 255.0 + 0.5);
  int kind = bits & 3;
  float evAge = life.b * 255.0;

  if (type == 0) {
    // A ghost (recent death) keeps its last colour and height while it deflates; other empty texels are 0.
    if (kind == 2 && evAge < 254.5) { oA = pA; oB = pB; oC = pC; }
    else { oA = vec4(0.0); oB = vec4(0.0); oC = vec4(0.0); }
    return;
  }

  float depth = cell.b * 255.0;
  int band = int(cell.g * 255.0 + 0.5);
  float E = exp2(cell.a * 13.0) - 1.0;
  float r = E / (type == 1 ? uThr.x : uThr.y);
  float ageF = life.r;

  // Before a fate change has visually happened (event clock), keep showing the previous type.
  int show = type;
  if (kind == 3 && evAge < 254.5 && uVisRel + evAge + 1.0 < 0.0) show = (bits >> 4) & 7;
  if (show == 0) show = type;

  vec3 col;
  if (uView == 0) {
    col = uPalette[show];
    float s = clamp((ageF - 0.85) / 0.15, 0.0, 1.0) * 0.4;          // senescence
    col = mix(col, vec3(lum(col)), s) * (1.0 - 0.15 * s);
  } else if (uView == 1) {
    // Rule 3 bands: the colour of the fate the rule assigns at this depth; lightness steps down inside a band.
    int bt = band == 1 ? 2 : band == 2 ? 3 : band == 3 ? 4 : 1;
    float lo = 1.0, hi = uBands.x;
    if (band == 2) { lo = uBands.x + 1.0; hi = uBands.y; }
    else if (band == 3) { lo = uBands.y + 1.0; hi = uBands.z - 1.0; }
    else if (band >= 4) { lo = uBands.z; hi = max(uBands.w, uBands.z); }
    float t = hi > lo ? clamp((depth - lo) / (hi - lo), 0.0, 1.0) : 0.0;
    col = uPalette[bt] * pow(1.0 - uDepthStep * t, 2.2);
  } else if (uView == 2) {
    col = ramp(2, r * 0.5);
  } else if (uView == 3) {
    col = ramp(3, ageF);
  } else {
    float v = dot(texelFetch(uMorph, tc, 0), uChanMask);
    float u = clamp(v / max(uDomainMax, 1e-6), 0.0, 1.0);
    if (uSqrtScale > 0.5) u = sqrt(u);
    col = ramp(uView, u);
  }
  if (uIsolate > 0 && show != uIsolate) col = mix(col, vec3(lum(col)), 0.7) * 0.18;

  float h = hOf(depth);
  float hE = nbH(tc + ivec2(1, 0)), hW = nbH(tc - ivec2(1, 0)), hN = nbH(tc + ivec2(0, 1)), hS = nbH(tc - ivec2(0, 1));
  float occ = clamp((hE - h) / 2.0, 0.0, 1.0) + clamp((hW - h) / 2.0, 0.0, 1.0)
            + clamp((hN - h) / 2.0, 0.0, 1.0) + clamp((hS - h) / 2.0, 0.0, 1.0);
  // relief slope: least-squares plane over the 5×5 neighbourhood (smooth; empty cells count as height 0)
  vec2 grad = vec2(0.0);
  for (int dy = -2; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++) {
    if (dx == 0 && dy == 0) continue;
    grad += nbH(tc + ivec2(dx, dy)) * vec2(float(dx), float(dy));
  }
  grad /= 50.0;
  float ao = 1.0 - 0.55 * occ / 4.0;
  // conservation glow: linear in energy at everyday levels; a soft knee keeps the T0 seeds from whiting out
  float glow = 0.95 * (1.0 - exp(-E * uGlowK / 0.95));

  float k = pA.a <= 0.0 ? 1.0 : uK;                                    // a newly occupied texel snaps
  oA = mix(pA, vec4(col, h), k);
  oB = mix(pB, vec4(glow, r, ao, 0.0), k);
  oC = mix(pC, vec4(grad, 0.0, 0.0), k);
}`;

// Halo: a 50×50 average of the display colour (each texel = 4×4 cells), sampled blurred by the agar as the
// light the tissue scatters into the gel around it.
export const HALO_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D uDispA;
in vec2 vUv;
out vec4 oH;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * 4;
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    vec4 d = texelFetch(uDispA, b + ivec2(x, y), 0);
    acc += d.a > 0.0 ? vec4(d.rgb, 1.0) : vec4(0.0);
  }
  oH = acc / 16.0;
}`;

// ─── cell material patches (MeshPhysicalMaterial via onBeforeCompile) ──────────────────────────────────
// Each cell is a soft gel pillow: a rounded cap (the type's shape cue; its width is E/threshold), and below its
// equator a skirt that flares out to fill the grid pitch, so neighbours meet in soft grooves instead of black
// seams. Lathe rings carry aKind: 0 = base ring (on the floor or plate), 1 = skirt ring (groove floor),
// 2 = cap profile (normalised: radius ≤ 0.5, y from −1 at the equator to 0 at the pole).

export const CELL_VERT_PARS = /* glsl */`
attribute float aIdx;
attribute float aKind;
uniform highp sampler2D uCell;
uniform highp sampler2D uLife;
uniform highp sampler2D uDispA;
uniform highp sampler2D uDispB;
uniform highp sampler2D uDispC;
uniform float uBend;
uniform vec3 uPalette[8];
uniform float uSq[8];
uniform float uCapH[8];       // cap height per unit of width: the per-type shape cue
uniform float uUnder[8];      // undercut below the cap's equator, as a fraction of the cap height (1 = a sphere)
uniform vec2 uSkirt;          // x = groove depth below the cap's equator, y = skirt half-width scale (lathe r 0.5 → 0.5·y)
uniform float uVisRel;
uniform vec3 uTau;            // birth, death, fate durations in ticks
uniform float uReduced;
uniform float uFlashScale;
uniform float uGlowOn;
uniform float uFlat;
uniform int uView;
uniform int uIsolate;
uniform int uHover;
uniform int uPinned;
uniform vec3 uHiCol;
uniform float uExplodeS;      // staggered explode clock, 0 → 1.5
uniform vec4 uPlateY;         // plate floor per family (0 ecto … 3 stem)
uniform vec3 uOrg;            // organism centre (world x, z) and rMax
#ifndef EE_DEPTH
varying vec3 vCol;
varying vec3 vEmis;
varying vec3 vGlow;
varying vec4 vMat;            // roughness, clearcoat, clearcoat roughness, AO
varying vec4 vShape;          // side (1 − |n.y|), outward rim, fade, cap weight
varying float vLum;           // conservation glow 0..1 (Tissue stain): how luminous, rather than reflective, the cell is
#endif
vec3 eeP;
vec3 eeN;
const int EE_FAM[8] = int[8](0, 3, 0, 1, 2, 0, 1, 1);
const ivec2 EE_DIR[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
const vec3 EE_GHOST = vec3(0.102, 0.117, 0.146);   // #5a606c
const vec3 EE_EMBER = vec3(1.0, 0.43, 0.162);      // #ffb070
const vec3 EE_GOLD = vec3(1.0, 0.533, 0.102);      // #ffc15a
float eeOutCubic(float x) { float y = 1.0 - x; return 1.0 - y * y * y; }
float eeOutBack(float x) { float y = x - 1.0; return 1.0 + 2.08 * y * y * y + 1.08 * y * y; }
float eeFly(float p) { return 1.0 - pow(1.0 - clamp(p, 0.0, 1.0), 4.9); }   // ≈ cubic-bezier(.2,.8,.2,1)

void eeSetup(vec3 pos, vec3 nrm) {
  int i = int(aIdx + 0.5);
  ivec2 tc = ivec2(i % 200, i / 200);
  vec4 cell = texelFetch(uCell, tc, 0);
  vec4 life = texelFetch(uLife, tc, 0);
  vec4 dA = texelFetch(uDispA, tc, 0);
  vec4 dB = texelFetch(uDispB, tc, 0);
  int type = int(cell.r * 255.0 + 0.5);
  int bits = int(life.g * 255.0 + 0.5);
  int kind = bits & 3;
  int dir = (bits >> 2) & 3;
  int prevT = (bits >> 4) & 7;
  float evAge = life.b * 255.0;
  bool recent = evAge < 254.5;
  int shape = type > 0 ? type : max(prevT, 1);
  // Visual ticks since the event began: an event stamped at tick T happens between T−1 and T.
  float tv = uVisRel + evAge + 1.0;

  float hTop = mix(dA.a, 0.6, uFlat);
  float fill = clamp(dB.g, 0.0, 1.0);                // E / division threshold
  float foot = 0.62 + 0.34 * fill;
  float sxz = 1.0, hScale = 1.0, hide = 0.0, fade = 1.0, dying = 0.0;
  vec2 off = vec2(0.0);
  vec3 col = dA.rgb;
  vec3 emis = vec3(0.0);
  float glow = dB.r;

  if (type == 0) {                                   // ghost of a death: deflate, grey, ember
    float ph = tv / uTau.y;
    if (kind != 2 || ph >= 1.0) hide = 1.0;
    ph = clamp(ph, 0.0, 1.0);
    dying = ph;
    glow *= 1.0 - ph;
    if (uReduced > 0.5) fade = 1.0 - ph;
    else {
      hScale = pow(1.0 - ph, 0.7);
      sxz = 1.0 - 0.5 * ph;
      col = mix(col, EE_GHOST, ph);
      if (tv >= 0.0) emis += EE_EMBER * (1.2 * exp(-5.0 * ph));
    }
  } else if (kind == 1 && recent) {                  // birth: the daughter slides out of its parent
    if (tv < 0.0) hide = 1.0;
    float ph = clamp(tv / uTau.x, 0.0, 1.0);
    if (uReduced > 0.5) fade = ph;
    else {
      float ec = eeOutCubic(ph);
      sxz = mix(0.35, 1.0, eeOutBack(ph));
      float hp = mix(texelFetch(uDispA, (tc - EE_DIR[dir] + 200) % 200, 0).a, 0.6, uFlat);
      hTop = mix(hp, hTop, ec);
      off = -vec2(EE_DIR[dir]) * (1.0 - ec);
    }
  }

  // Apart: fly to the family plate, staggered by radius and plate. While a cell flies, its column stretches
  // between where it is and where it was a moment ago (a motion streak), and closes up as it lands.
  int fam = EE_FAM[shape];
  vec2 gp = vec2(tc) - 99.5;
  float rr = clamp(length(gp - uOrg.xy) / max(uOrg.z, 1.0), 0.0, 1.0);
  float p = clamp(uExplodeS - 0.25 * rr - 0.08 * float(fam), 0.0, 1.0);
  float ex = eeFly(p);
  float exT = uReduced > 0.5 ? ex : eeFly(p - 0.045);
  float lo = min(ex, exT), hi = max(ex, exT);
  float streak = hi - lo;
  float plate = uPlateY[fam];
  float dE = type > 0 ? cell.b * 255.0 : 1.0;
  float baseY = plate * lo;
  float top = mix(hTop, plate + 0.35 + 0.25 * sqrt(max(dE, 1.0)), hi);
  top = baseY + (top - baseY) * hScale;

  float colH = max(top - baseY, 0.04);
  float s = foot * sxz;
  float capH = min(uCapH[shape] * s, 0.62 * colH);
  float groove = (1.0 - uFlat) * (1.0 - ex);
  float under = uUnder[shape] * groove;
  float capLo = min(capH * under, max(colH - capH - 0.02, 0.0));
  float skirt = min(uSkirt.x, max(colH - capH - capLo - 0.02, 0.0)) * groove;
  // the skirt flares to fill the pitch; under a pearl (full undercut) it tucks in, so pearls keep dark gaps
  float sk = mix(s, mix(uSkirt.y * sxz, 0.3 * s, uUnder[shape] * uUnder[shape]), groove);
  bool isCap = aKind > 1.5;
  bool isLower = isCap && pos.y < -1.0;

  vec2 q = pos.xz;
  float ql0 = length(q);
  if (isLower) q *= mix(0.5 / max(ql0, 1e-4), 1.0, under);    // no undercut: the ring sits on the equator
  float ql = length(q);
  vec2 d = ql > 1e-4 ? q / ql : vec2(1.0, 0.0);
  float m = max(abs(d.x), abs(d.y));
  float sq = isCap ? uSq[shape] : mix(uSq[shape], 0.62 * (1.0 - uUnder[shape]), groove);
  q = mix(q, q / m, sq);                              // superellipse-ish squarification
  float y;
  if (isCap) { q *= s; y = isLower ? top - capH + (pos.y + 1.0) * capLo : top + pos.y * capH; }
  else { q *= sk; y = aKind > 0.5 ? top - capH - capLo - skirt : baseY; }
  // The cap and the groove floor shear with the relief's local slope: a cell's uphill edge rises and its downhill
  // edge drops by half a step, so neighbouring caps meet edge to edge, a continuous sheet of soft cells over the
  // dome instead of a staircase of columns. (The footprint in xz is unchanged, so the grid still tiles exactly.)
  vec2 slope = texelFetch(uDispC, tc, 0).xy * ((1.0 - uFlat) * (1.0 - ex));
  float yFlat = y;
  float shear = 1.0 - 0.85 * uUnder[shape] * uUnder[shape];      // pearls stay round: they pile, they do not tile
  if (aKind > 0.5) y = max(y + dot(slope, q) * shear, baseY + 0.02);
  eeP = hide > 0.5 ? vec3(0.0, -300.0, 0.0) : vec3(gp.x + off.x + q.x, y, gp.y + off.y + q.y);

  // normals: the cap's lathe normals under the per-axis scale; the groove wall tilts up by its flare
  vec2 ax = abs(d.x) > abs(d.y) ? vec2(sign(d.x), 0.0) : vec2(0.0, sign(d.y));
  float wsq = sq * smoothstep(0.02, 0.3, abs(abs(d.x) - abs(d.y)));
  vec2 rd = normalize(mix(d, ax, wsq));
  vec3 n;
  if (isCap) {
    float nl = length(nrm.xz);
    n = nrm;
    if (nl > 1e-4) n.xz = normalize(mix(nrm.xz / nl, ax, wsq)) * nl;
    n = normalize(vec3(n.x / s, n.y / max(isLower ? capLo : capH, 1e-3), n.z / s));
    if (isLower) n = normalize(mix(vec3(rd.x, 0.0, rd.y), n, smoothstep(0.0, 0.2, under)));
    // the shear's normal transform (inverse transpose), a little exaggerated so the relief reads at any distance
    n = normalize(vec3(n.x - slope.x * uBend * shear * n.y, n.y, n.z - slope.y * uBend * shear * n.y));
  } else if (aKind > 0.5) {
    n = normalize(vec3(rd.x * max(skirt, 0.02), max(0.5 * (sk - s), 0.0), rd.y * max(skirt, 0.02)));
  } else {
    n = vec3(rd.x, 0.0, rd.y);
  }
  // A wall that stands above its neighbour (the organism's outer skin, a terrace riser) is exposed: it shades as
  // part of the body's smooth surface and is not darkened as a groove.
  float exposed = 0.0;
  if (!isCap) {
    float hn = texelFetch(uDispA, (tc + ivec2(ax) + 200) % 200, 0).a;
    exposed = clamp((yFlat - baseY - hn) / 1.2, 0.0, 1.0) * groove;
    n = normalize(mix(n, normalize(vec3(-slope.x, 0.35, -slope.y)), 0.5 * exposed));
  }
  eeN = n;

#ifndef EE_DEPTH
  bool ready = (bits & 128) != 0;
  float nonMap = 1.0 - uFlat;
  vec3 glowE = uGlowOn > 0.5 ? uPalette[shape] * glow : vec3(0.0);
  if (uView == 2 && ready && type > 0) emis += EE_GOLD * 0.35;
  if (uView >= 4) emis += col * 0.12;
  if (kind == 3 && recent && type > 0 && uReduced < 0.5 && tv >= 0.0)
    emis += uPalette[type] * (1.5 * exp(-6.0 * tv / uTau.z) * uFlashScale);   // commitment flash
  emis += col * (2.2 * streak);                     // Apart flight: the streak glows in the cell's own colour
  if (uIsolate > 0 && shape != uIsolate) { emis *= 0.1; glowE *= 0.1; }
  emis *= nonMap;
  vGlow = glowE * nonMap;
  float lum = uGlowOn > 0.5 ? clamp(glow / 0.95, 0.0, 1.0) * nonMap : 0.0;
  vLum = lum;
  if (i == uHover) emis += uHiCol * 1.25;          // hover / pinned: the accent light, bright enough to spark
  if (i == uPinned) emis += uHiCol * 1.7;
  vCol = col;
  vEmis = emis;
  // Surface from real data only: young, energy-full cells are turgid and glossy; age dulls the coat.
  float ageF = life.r;
  float rough = clamp(0.30 + 0.34 * ageF - 0.10 * fill + 0.3 * dying, 0.12, 0.95);
  if (!isCap) rough = mix(rough, 1.0, lum);          // a luminous pearl's stalk has no sheen
  float coat = clamp((0.42 + 0.58 * fill) * (1.0 - 0.45 * ageF) * (1.0 - dying), 0.0, 1.0);
  if (!isCap) coat *= 1.0 - 0.85 * lum;              // a luminous pearl's stalk stays in the dark
  float coatR = 0.05 + 0.22 * ageF + 0.2 * dying;
  float ao = mix(dB.b, 1.0, uFlat);
  ao *= isCap ? (isLower ? mix(0.8, 0.5, clamp(-1.0 - pos.y, 0.0, 1.0) * under) : 0.8 + 0.2 * clamp(pos.y + 1.0, 0.0, 1.0))
              : mix(aKind > 0.5 ? mix(1.0, 0.5, groove) : 0.45, 0.9, exposed);
  vMat = vec4(rough, coat, coatR, ao);
  vec2 outDir = gp - uOrg.xy;
  float ol = length(outDir);
  float side = 1.0 - abs(eeN.y);
  float rim = ol > 1e-3 ? max(0.0, dot(rd, outDir / ol)) * side * nonMap : 0.0;
  vShape = vec4(side, rim, fade, isCap ? (isLower ? 0.55 : 1.0) : 0.0);
#endif
}`;

export const CELL_VERT_NORMAL = /* glsl */`
eeSetup(position, normal);
vec3 objectNormal = eeN;
#ifdef USE_TANGENT
  vec3 objectTangent = vec3(tangent.xyz);
#endif`;

export const CELL_VERT_BEGIN = /* glsl */`
vec3 transformed = eeP;
#ifdef USE_ALPHAHASH
  vPosition = transformed;
#endif`;

export const CELL_DEPTH_BEGIN = /* glsl */`
eeSetup(position, vec3(0.0, 1.0, 0.0));
vec3 transformed = eeP;`;

// The shadow proxy's main-pass material: every vertex lands outside the clip volume, so it costs nothing on screen.
export const NULL_VERT = /* glsl */`void main() { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }`;
export const NULL_FRAG = /* glsl */`void main() { gl_FragColor = vec4(0.0); }`;

export const CELL_FRAG_PARS = /* glsl */`
varying vec3 vCol;
varying vec3 vEmis;
varying vec3 vGlow;
varying vec4 vMat;
varying vec4 vShape;
varying float vLum;
uniform float uScatter;
uniform float uTrans;
uniform float uWrap;
uniform float uRimK;
uniform float uSoftbox;
uniform float uGlowGain;
uniform vec3 uKeyDirV;
uniform vec3 uKeyCol;
uniform vec3 uBackDirV;
uniform vec3 uBackCol;
uniform vec3 uUpV;
uniform vec3 uSky;
uniform vec3 uGround;
uniform float uUnlit;
// Inverse of three's NeutralToneMapping (exposure 1): the map preset outputs legend colours exactly.
vec3 eeInvNeutral(vec3 c) {
  const float S = 0.76, D = 0.24, DS = 0.15;
  c = clamp(c, 0.0, 0.97);
  float np = max(c.r, max(c.g, c.b));
  if (np >= S) {
    float peak = D * D / (1.0 - np) - D + S;
    float g = 1.0 - 1.0 / (DS * (peak - np) + 1.0);
    c = (c - np * g) / (1.0 - g) * (peak / np);
  }
  float mn = min(c.r, min(c.g, c.b));
  float off = mn >= 0.04 ? 0.04 : 0.4 * sqrt(max(mn, 0.0)) - mn;
  return c + off;
}`;

// A cell brimming with energy is a bead of light rather than a lit surface: its diffuse albedo gives way to its glow
// (the blazing T0 seeds are pearls; as they share their energy they cool into opaque, coloured cells).
export const CELL_FRAG_COLOR = /* glsl */`
diffuseColor.rgb = vCol * (1.0 - 0.88 * vLum) * (1.0 - 0.85 * vLum * (1.0 - vShape.w));
diffuseColor.a *= vShape.z;`;

export const CELL_FRAG_ROUGH = /* glsl */`
float roughnessFactor = vMat.x;`;

export const CELL_FRAG_EMISSIVE = /* glsl */`
totalEmissiveRadiance = vEmis;`;

// After lights_physical_fragment: the wet coat's strength and roughness per cell (energy, age).
export const CELL_FRAG_COAT = /* glsl */`
#ifdef USE_CLEARCOAT
  material.clearcoat = saturate(vMat.y);
  material.clearcoatRoughness = min(max(vMat.z, 0.0525) + geometryRoughness, 1.0);
#endif`;

// Appended after lights_fragment_end. eeKeyVis is the key light's shadow visibility (captured in the light loop).
//  · ambient: a dark room above, the illuminator's faint cool light from below
//  · wrap: the warm key bleeding past the terminator into the gel
//  · back light: the darkfield illuminator behind the specimen, transmitted in the tissue's own (deepened) colour —
//    strongest through walls and at the organism's rim, so the dome's edge glows from below
//  · edge scatter and a cool fresnel rim that outlines the silhouette against the void
//  · the key's softbox as a broad reflection on the wet coat
//  · the conservation glow, brightest through a pearl's middle (a luminous gel's path length ∝ n·v)
export const CELL_FRAG_SCATTER = /* glsl */`
{
  vec3 N = geometryNormal, V = geometryViewDir;
  float NV = saturate(dot(N, V));
  float side = vShape.x, rim = vShape.y;
  float scat = 1.0 - 0.9 * vLum * (1.0 - vShape.w);       // a luminous pearl's stalk neither scatters nor transmits
  vec3 alb = diffuseColor.rgb;                              // the albedo (a luminous cell reflects little)
  float up = dot(N, uUpV);
  reflectedLight.indirectDiffuse += alb * mix(uGround, uSky, up * 0.5 + 0.5);
  float NL = dot(N, uKeyDirV);
  float w = max(0.0, (NL + uWrap) / (1.0 + uWrap)) - max(0.0, NL);
  reflectedLight.directDiffuse += alb * sqrt(vCol) * uKeyCol * (w * eeKeyVis * 0.5 * RECIPROCAL_PI);
  float fres = 1.0 - NV;
  vec3 Hb = normalize(uBackDirV + N * 0.3);
  float tr = pow(saturate(dot(V, -Hb)), 2.0) * fres * sqrt(fres);          // light gets through only where it is thin
  vec3 gel = vCol * (0.25 + 0.75 * vCol);
  totalEmissiveRadiance += gel * uBackCol * (uTrans * scat * tr * (0.35 + 0.65 * side) * (0.4 + 0.6 * rim));
  totalEmissiveRadiance += vCol * (uScatter * scat * fres * fres * fres * (0.35 + 0.65 * side));
  totalEmissiveRadiance += uBackCol * (uRimK * scat * pow(fres, 5.0) * saturate(dot(N, uBackDirV) + 0.3));
  vec3 R = reflect(-V, N);
  float sb = smoothstep(0.88, 0.985, dot(R, uKeyDirV));
  totalEmissiveRadiance += uKeyCol * (uSoftbox * sb * eeKeyVis * vMat.y * (0.06 + 0.94 * pow(fres, 5.0)));
  totalEmissiveRadiance += vGlow * (uGlowGain * (0.04 + 0.96 * NV * NV * NV) * mix(0.1, 1.0, vShape.w));
}`;

// Replaces aomap_fragment: the heightfield AO from the display pass (no aoMap needed).
export const CELL_FRAG_AO = /* glsl */`
{
  float ambientOcclusion = vMat.w;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  reflectedLight.directDiffuse *= mix(1.0, ambientOcclusion, 0.6);
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
}`;

// Before opaque_fragment: in the map preset the tops are unlit legend colours (pre-compensated for tone mapping).
export const CELL_FRAG_OUT = /* glsl */`
if (uUnlit > 0.0) {
  vec3 eeFlat = eeInvNeutral(vCol * mix(1.0, 0.72, vShape.x)) + vEmis;
  outgoingLight = mix(outgoingLight, eeFlat, uUnlit);
}`;

// ─── agar (dish floor): scale grid, signal fields with gate iso-lines, surfaces, the tissue's glow ─────

export const AGAR_VERT = /* glsl */`
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const AGAR_FRAG = /* glsl */`
precision highp sampler2D;
uniform sampler2D uCell;
uniform sampler2D uLife;
uniform sampler2D uMorph;
uniform sampler2D uRamps;
uniform sampler2D uDispA;
uniform sampler2D uHalo;
uniform float uHaloAmt;
uniform float uBaseTint;
uniform float uGrid;
uniform vec4 uGridFade;       // organism centre (x, z), fade start radius, fade width (map/depth: no fade)
uniform float uEdgeLine;
uniform int uView;
uniform vec4 uChanMask;
uniform float uDomainMax;
uniform float uSqrtScale;
uniform vec4 uGates;
uniform int uGateN;
uniform float uSignal;
uniform float uSurf;
uniform float uApart;
uniform float uDishR;
uniform vec3 uBase;
uniform vec3 uLine;
uniform vec3 uAmber;
varying vec3 vW;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
bool isLive(ivec2 c) { return texelFetch(uCell, (c + 200) % 200, 0).r > 0.002; }
float field(ivec2 c) { return dot(texelFetch(uMorph, (c + 200) % 200, 0), uChanMask); }

void main() {
  vec2 g = vW.xz + 100.0;                       // grid coordinates; cell (i, j) covers [i, i+1) × [j, j+1)
  vec2 fw = fwidth(g);
  float rr = length(vW.xz) / uDishR;
  vec3 col = uBase * (0.75 + 0.5 * vnoise(g * 0.21) * vnoise(g * 0.057 + 3.1)) * (1.0 + 0.6 * (1.0 - rr * rr));
  float inGrid = step(0.0, g.x) * step(0.0, g.y) * step(g.x, 200.0) * step(g.y, 200.0);

  // 10-cell scale grid: in the specimen views only a faint reticle around the organism, fading with distance;
  // the map and depth views show it everywhere, with the world boundary (the torus wraps there)
  float dOrg = length(vW.xz - uGridFade.xy);
  float gridA = uGrid * (1.0 - smoothstep(uGridFade.z, uGridFade.z + uGridFade.w, dOrg));
  vec2 gd = abs(fract(g / 10.0 + 0.5) - 0.5) * 10.0;
  float ln = 1.0 - min(smoothstep(0.0, fw.x * 1.5, gd.x), smoothstep(0.0, fw.y * 1.5, gd.y));
  ln *= 1.0 - smoothstep(0.5, 2.5, max(fw.x, fw.y));            // no moiré where the lines get finer than a pixel
  vec2 bd = min(g, 200.0 - g);
  float edge = 1.0 - smoothstep(0.0, max(fw.x, fw.y) * 2.0, min(abs(bd.x), abs(bd.y)));
  col += uLine * (gridA * ln * inGrid + uEdgeLine * edge);
  col += uLine * 0.03 * smoothstep(0.72, 1.0, rr);                     // the illuminator's light pooling at the rim
  vec4 dsp = texelFetch(uDispA, (ivec2(floor(g)) + 200) % 200, 0);
  if (dsp.a > 0.0) col = mix(col, dsp.rgb * uBaseTint, inGrid);
  if (uHaloAmt > 0.0) {
    // the light the tissue scatters into the wet agar: a tight pool at its foot, a wide soft glow beyond
    vec2 hu = g / 200.0;
    const float o = 1.0 / 50.0;
    vec4 near = texture(uHalo, hu) * 0.4 + (texture(uHalo, hu + vec2(o, 0.0)) + texture(uHalo, hu - vec2(o, 0.0))
              + texture(uHalo, hu + vec2(0.0, o)) + texture(uHalo, hu - vec2(0.0, o))) * 0.15;
    vec4 far = (texture(uHalo, hu + vec2(3.0 * o, 1.5 * o)) + texture(uHalo, hu + vec2(-1.5 * o, 3.0 * o))
              + texture(uHalo, hu + vec2(-3.0 * o, -1.5 * o)) + texture(uHalo, hu + vec2(1.5 * o, -3.0 * o))) * 0.25;
    col += (near.rgb * 0.8 + far.rgb * 0.45) * uHaloAmt * inGrid * (dsp.a > 0.0 ? 0.0 : 1.0);
  }

  // signal fields (views 5–8): the whole field, empty space included, with the gate iso-lines
  float v = 0.0;
  if (uSignal > 0.5) {
    vec2 p = g - 0.5;
    ivec2 i0 = ivec2(floor(p));
    vec2 f = fract(p);
    v = mix(mix(field(i0), field(i0 + ivec2(1, 0)), f.x), mix(field(i0 + ivec2(0, 1)), field(i0 + ivec2(1, 1)), f.x), f.y);
  }
  float fv = max(fwidth(v), 1e-6);
  if (uSignal > 0.5) {
    float u = clamp(v / max(uDomainMax, 1e-6), 0.0, 1.0);
    if (uSqrtScale > 0.5) u = sqrt(u);
    vec3 fc = texture(uRamps, vec2(u * (255.0 / 256.0) + 0.5 / 256.0, (float(uView) + 0.5) / 8.0)).rgb * 0.55;
    col = mix(col, fc, inGrid);
    for (int k = 0; k < 4; k++) {
      if (k >= uGateN) break;
      float dd = abs(v - uGates[k]) / fv;
      col = mix(col, vec3(1.0), 0.6 * (1.0 - smoothstep(0.5, 1.5, dd)) * inGrid);
    }
  }

  // surfaces: exterior contour, interior gaps (amber wells), recent deaths (fading rings)
  if (uSurf > 0.0 || uApart > 0.0) {
    ivec2 c = ivec2(floor(g));
    vec2 f = fract(g);
    vec4 cl = texelFetch(uCell, (c + 200) % 200, 0);
    vec4 lf = texelFetch(uLife, (c + 200) % 200, 0);
    float w = max(fw.x, fw.y) * 1.2 + 0.05;
    if (cl.r < 0.002) {
      float B = cl.b * 255.0;
      if (B < 0.5) {
        float e = 1e3;
        if (isLive(c + ivec2(1, 0))) e = min(e, 1.0 - f.x);
        if (isLive(c - ivec2(1, 0))) e = min(e, f.x);
        if (isLive(c + ivec2(0, 1))) e = min(e, 1.0 - f.y);
        if (isLive(c - ivec2(0, 1))) e = min(e, f.y);
        col = mix(col, uLine * 1.2, (1.0 - smoothstep(0.0, w, e)) * max(uSurf, uApart) * inGrid);
      } else if (B > 254.5) {
        float dd = length(f - 0.5) * 2.0;
        col = mix(col, uAmber * 0.8, (1.0 - smoothstep(0.1, 1.0, dd)) * max(uSurf, uApart) * inGrid);
      }
      int bits = int(lf.g * 255.0 + 0.5);
      float age = lf.b * 255.0;
      if ((bits & 3) == 2 && age < 254.5) {
        float dd = length(f - 0.5) * 2.0;
        float ring = 1.0 - smoothstep(0.0, 0.18, abs(dd - 0.62));
        col = mix(col, uAmber, ring * (1.0 - age / 255.0) * 0.8 * max(uSurf, uApart) * inGrid);
      }
    } else {
      col = mix(col, uLine * 0.05 + col, uApart * inGrid);      // Apart: the base keeps a faint footprint
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// ─── void, light cone, dust, bokeh ──────────────────────────────────────────────────────────────────

export const VOID_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}`;

// The void, with a faint cool haze: the illuminator's light scattered in the air above the dish, brightest just
// above the dish's far rim (uHaze.xy = its screen position, z = strength, w = vertical spread).
export const VOID_FRAG = /* glsl */`
uniform vec3 uCentre;
uniform vec3 uEdge;
uniform vec3 uHazeCol;
uniform vec4 uHaze;
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec2 q = (vUv - vec2(0.5, 0.46)) * vec2(uAspect, 1.0);
  float r = length(q) / (0.62 * length(vec2(uAspect, 1.0)));
  vec3 c = mix(uCentre, uEdge, smoothstep(0.0, 1.0, r));
  vec2 h = (vUv - uHaze.xy) * vec2(uAspect * 0.55, 1.0);
  float haze = exp(-abs(h.y) / uHaze.w) * exp(-dot(h.x, h.x) * 1.6);
  c += uHazeCol * uHaze.z * haze;
  gl_FragColor = vec4(c, 1.0);
}`;

export const CONE_VERT = /* glsl */`
varying float vV;
varying vec3 vN;
varying vec3 vV2C;
void main() {
  vV = uv.y;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV2C = normalize(cameraPosition - w.xyz);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const CONE_FRAG = /* glsl */`
uniform vec3 uCol;
uniform float uI;
varying float vV;
varying vec3 vN;
varying vec3 vV2C;
void main() {
  float face = 1.0 - abs(dot(normalize(vN), normalize(vV2C)));
  float a = uI * pow(vV, 2.2) * (0.25 + 0.75 * pow(face, 2.0));
  gl_FragColor = vec4(uCol * a, 1.0);
}`;

// Static specks: on the glass (small, crisp glints) and adrift in the air above the dish (defocused into bokeh
// discs by the same circle-of-confusion law as the depth of field: their light spreads over the disc).
export const DUST_VERT = /* glsl */`
attribute float aSize;
attribute float aGlint;
attribute float aAir;         // 1 = adrift in the air (drawn as its own bokeh disc); 0 = on the glass (the DOF blurs it)
uniform float uScale;         // drawing-buffer px per world unit at distance 1
uniform vec4 uDof;            // focus distance, in-focus half range, K·(resY/1080), max CoC px (0 = no DOF)
varying float vGlint;
varying float vSoft;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float z = max(-mv.z, 1.0);
  float core = max(aSize * uScale / z, 1.6);
  float coc = uDof.w > 0.0 ? aAir * clamp(uDof.z * max(abs(z - uDof.x) - uDof.y, 0.0) / z, 0.0, 2.2 * uDof.w) : 0.0;
  float px = core + 2.0 * coc;
  gl_PointSize = min(px, 480.0);
  // a speck on the glass keeps its light in a point; a defocused mote is a faint disc (a bright glint spread by the
  // lens, dimming gently as it grows)
  vGlint = aGlint * mix((core * core) / (px * px), 0.16 / (1.0 + 0.025 * coc), aAir * step(1.0, coc));
  vSoft = clamp(coc / 6.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

export const DUST_FRAG = /* glsl */`
uniform vec3 uCol;
varying float vGlint;
varying float vSoft;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;
  float speck = exp(-d * d * 4.0);
  float disc = smoothstep(1.0, 0.86, d) * (0.72 + 0.28 * smoothstep(0.45, 0.93, d));   // a bokeh disc's brighter rim
  gl_FragColor = vec4(uCol * vGlint * mix(speck, disc, vSoft), 1.0);
}`;

// Apart plates: edge-lit glass. The family's colour enters at the rim and fades inward (as light does in an
// edge-lit sheet); a cool fresnel sheen and a fine engraved ring keep the glass readable from any angle.
export const PLATE_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
varying vec2 vP;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = cameraPosition - w.xyz;
  vP = position.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const PLATE_FRAG = /* glsl */`
uniform vec3 uFam;
uniform vec3 uSheen;
uniform float uA;
varying vec3 vN;
varying vec3 vV;
varying vec2 vP;
void main() {
  float r = length(vP);                            // plate radius is 1 in object space
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
  float edgeLit = exp(-(1.0 - r) * 7.0);
  float ring = 1.0 - smoothstep(0.0, 0.006, abs(r - 0.93));
  vec3 c = uFam * (0.22 * edgeLit + 0.18 * ring) + uSheen * (0.05 + 0.5 * fres);
  gl_FragColor = vec4(c * uA, 1.0);
}`;

// ─── post: depth of field and the final composite ───────────────────────────────────────────────────

const DOF_COMMON = /* glsl */`
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
uniform float uFocus;
uniform float uRange;
uniform float uTopY;
uniform float uK;
uniform float uMaxCoc;
uniform float uResY;
// Signed circle of confusion in full-resolution pixels: negative in front of the focus (near field).
// Blur grows with the distance outside the in-focus slab, and with height above the specimen (the objective).
float cocAt(vec2 uv, float depth) {
  vec4 vp = uProjInv * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vp /= vp.w;
  float z = -vp.z;
  float wy = (uCamWorld * vec4(vp.xyz, 1.0)).y;
  float dz = z - uFocus;
  float off = max(abs(dz) - uRange, 0.0) + 2.5 * max(wy - uTopY, 0.0);
  float c = clamp(uK * off / max(z, 1.0) * (uResY / 1080.0), 0.0, uMaxCoc);
  return dz < 0.0 || wy > uTopY ? -c : c;
}`;

export const DOF_COC_FRAG = /* glsl */`
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uFullTexel;
${DOF_COMMON}
varying vec2 vUv;
void main() {
  // half-res: the bilinear tap averages the 2×2 block; CoC from the nearest of two depth taps keeps edges clean
  float d = min(texture2D(tDepth, vUv + uFullTexel * 0.5).r, texture2D(tDepth, vUv - uFullTexel * 0.5).r);
  gl_FragColor = vec4(texture2D(tColor, vUv).rgb, cocAt(vUv, d));
}`;

export const DOF_GATHER_FRAG = /* glsl */`
uniform sampler2D tHalf;
uniform vec2 uFullTexel;
uniform float uMaxCoc;
uniform int uTaps;
varying vec2 vUv;
void main() {
  vec4 c0 = texture2D(tHalf, vUv);
  float cc = c0.a, ac = abs(cc);
  vec3 acc = c0.rgb;
  float wsum = 1.0, nearC = max(-cc, 0.0);
  float rot = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  for (int k = 0; k < 40; k++) {
    if (k >= uTaps) break;
    float fr = sqrt((float(k) + 0.5) / float(uTaps));
    float th = float(k) * 2.39996323 + rot;
    float dist = fr * uMaxCoc;
    vec4 s = texture2D(tHalf, vUv + vec2(cos(th), sin(th)) * dist * uFullTexel);
    float sc = abs(s.a);
    if (s.a > 0.0 && s.a > cc) sc = min(sc, ac);      // background never bleeds over a sharper, nearer pixel
    float w = clamp(sc - dist + 1.0, 0.0, 1.0);
    acc += s.rgb * w;
    wsum += w;
    if (s.a < 0.0) nearC = max(nearC, sc * w);
  }
  gl_FragColor = vec4(acc / wsum, max(ac, nearC));
}`;

export const PASS_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// One full-resolution pass: DOF composite (with a 4-tap tent over the half-res blur) + bloom + vignette + grain,
// then three's Neutral tone mapping and the sRGB transfer (identical formulas, so the map preset's
// pre-compensated legend colours still come out exact).
export const FINAL_FRAG = /* glsl */`
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tBlur;
uniform sampler2D tBloom;
uniform float uDofOn;
uniform float uBloomOn;
uniform vec2 uHalfTexel;
uniform float uVig;
uniform float uGrain;
uniform float uFrame;
uniform float uAspect;
${DOF_COMMON}
varying vec2 vUv;
float h(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
vec3 neutral(vec3 color) {
  const float StartCompression = 0.8 - 0.04;
  const float Desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < StartCompression) return color;
  float d = 1. - StartCompression;
  float newPeak = 1. - d * d / (peak + d - StartCompression);
  color *= newPeak / peak;
  float g = 1. - 1. / (Desaturation * (peak - newPeak) + 1.);
  return mix(color, vec3(newPeak), g);
}
vec3 srgb(vec3 v) {
  return mix(pow(v, vec3(0.41666)) * 1.055 - vec3(0.055), v * 12.92, vec3(lessThanEqual(v, vec3(0.0031308))));
}
void main() {
  vec3 c = texture2D(tColor, vUv).rgb;
  if (uDofOn > 0.5) {
    float coc = abs(cocAt(vUv, texture2D(tDepth, vUv).r));
    // a 4×4-texel tent over the half-res gather (four bilinear taps) smooths the stochastic gather's noise
    vec2 o = uHalfTexel;
    vec4 b = 0.25 * (texture2D(tBlur, vUv + vec2(o.x, o.y)) + texture2D(tBlur, vUv + vec2(-o.x, o.y))
                   + texture2D(tBlur, vUv + vec2(o.x, -o.y)) + texture2D(tBlur, vUv - o));
    c = mix(c, b.rgb, smoothstep(0.5, 1.5, max(coc, b.a)));
  }
  if (uBloomOn > 0.5) c += texture2D(tBloom, vUv).rgb;
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(q) / length(vec2(uAspect, 1.0) * 0.5);
  c *= 1.0 - uVig * smoothstep(0.35, 0.95, r);
  vec2 fc = gl_FragCoord.xy + vec2(uFrame * 7.13, uFrame * 3.71);
  float n = h(fc) + h(fc + 17.3) - 1.0;                     // triangular dither noise
  c = max(c + n * uGrain * (0.55 * sqrt(max(c, 0.0)) + 0.012), 0.0);
  gl_FragColor = vec4(srgb(clamp(neutral(c), 0.0, 1.0)), 1.0);
}`;

// Bloom high-pass that keeps only the energy ABOVE the threshold (soft knee), instead of passing the whole colour of
// any pixel that crosses it. Surfaces just over 1.0 barely bloom; the ring, glints and blazing seeds do.
export const BLOOM_HIGHPASS_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec3 defaultColor;
uniform float defaultOpacity;
uniform float luminosityThreshold;
uniform float smoothWidth;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = max(max(c.r, c.g), c.b);
  float k = max(smoothWidth, 1e-4);
  float soft = clamp(l - luminosityThreshold + k, 0.0, 2.0 * k);
  soft = soft * soft / (4.0 * k);
  float w = max(soft, l - luminosityThreshold) / max(l, 1e-4);
  gl_FragColor = vec4(c * w, 1.0);
}`;
