// src/scene/cells.js — texture-driven instanced cells: frame textures, the display pass (EMA ping-pong),
// cell LOD geometry, the patched MeshPhysicalMaterial, and a low-poly shadow proxy with its depth material.
import {
  BufferAttribute, Color, DataTexture, FloatType, GLSL3, HalfFloatType, InstancedBufferAttribute,
  InstancedBufferGeometry, LatheGeometry, LinearFilter, Mesh, MeshDepthMaterial, MeshPhysicalMaterial,
  NearestFilter, NoColorSpace, RawShaderMaterial, RGBADepthPacking, RGBAFormat, ShaderChunk, ShaderMaterial,
  SRGBColorSpace, UnsignedByteType, Vector2, Vector3, Vector4, WebGLRenderTarget, DynamicDrawUsage,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GRID, N, EV, EV_WORDS, MAX_EVENTS_PER_FRAME, TISSUE_HEX } from '../shared.js';
import { LOD, lodForCount } from './quality.js';
import { buildRampBytes, DEPTH_STEP } from './ramps.js';
import * as S from './shaders.js';

// Per-type shape: the non-colour cue (index = TYPE; 0 falls back to stem). Stem cells are round pearls with a tall
// dome; specified cells are softer, flatter pillows, squarer the more specialised the tissue.
const SHAPE_SQ = [0.1, 0.04, 0.55, 0.34, 0.46, 0.4, 0.5, 0.3];
const SHAPE_CAP_H = [0.5, 0.5, 0.26, 0.34, 0.3, 0.36, 0.3, 0.32];     // cap height per unit of cell width
const SHAPE_UNDER = [1, 1, 0.22, 0.3, 0.26, 0.3, 0.26, 0.3];         // undercut: 1 = a full sphere (a pearl)
const SKIRT = new Vector2(0.55, 1.16);   // groove depth (world units), skirt half-width scale (fills the pitch)
const EMA_TAU = 0.12;                 // seconds; caps per-cell colour change at ~1.3 Hz
// Flash safety (WCAG 2.3.1): the event-driven emissive terms (the commitment flash and the death ember) share one
// light budget on the mean transient emission per visible cell (linear luminance, the vertex shader's own envelopes):
// a ceiling, and a limit on how much it may rise from one frame to the next (a wave of fate changes on a single tick,
// ~35 of 800 cells, rose by 0.015 in one frame: a 7–10% pulse of the whole frame on a phone or a desktop).
const TRANSIENT_MAX = 0.015;
const TRANSIENT_RISE = 0.004;         // per 1/60 s
const TRANSIENT_RECOVER_S = 1;        // the scale drops at once and recovers with this time constant (wall time)
const FLASH_ENV = 6;                  // commitment flash: exp(−FLASH_ENV · tv / τ_fate), as in CELL_VERT
const EMBER_ENV = 5;                  // death ember: exp(−EMBER_ENV · tv / τ_death)
const lumOf = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const EMBER_LUM = 1.2 * lumOf({ r: 1.0, g: 0.43, b: 0.162 });   // EE_EMBER × 1.2
// Conservation glow ≈ E × GLOW_K: linear in energy at everyday levels (E ≲ 500, so the dish's emitted light tracks
// the conserved total), with a soft knee at 0.95 (display pass) so the 37 T0 seeds (E ≈ 6,757) blaze without the
// bloom whiting out the frame. SPEC's E × 0.0018 capped at 12 flooded the frame; see the scene notes.
export const GLOW_K = 0.0006;

/** Replace each needle once; a missing needle means three's chunks changed, so fail loudly. */
export function patchShader(src, pairs, what) {
  for (const [needle, repl] of pairs) {
    if (!src.includes(needle)) throw new Error(`three chunk changed: '${needle}' not found in ${what}`);
    src = src.replace(needle, repl);
  }
  return src;
}

// The light loop, with the key light's (directional light 0, the only shadow caster) shadow visibility captured
// in eeKeyVis for the analytic terms that follow it.
const KEY_SHADOW = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]';
function lightsBeginWithKeyVis() {
  const src = ShaderChunk.lights_fragment_begin;
  const at = src.indexOf(KEY_SHADOW);
  if (at < 0) throw new Error('three chunk changed: directional shadow line not found in lights_fragment_begin');
  const end = src.indexOf(';', at) + 1;
  return 'float eeKeyVis = 1.0;\n' + src.slice(0, end) +
    '\n\t\tif ( UNROLLED_LOOP_INDEX == 0 ) eeKeyVis = dot( directLight.color, vec3( 1.0 ) ) / max( dot( directionalLight.color, vec3( 1.0 ) ), 1e-5 );' +
    src.slice(end);
}

function dataTexture(data, type) {
  const t = new DataTexture(data, GRID, GRID, RGBAFormat, type);
  t.minFilter = t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Lathe rings from the base up: base (aKind 0), skirt (1, optional), then the cap (2) from equator to pole in
 *  normalised coordinates (radius ≤ 0.5, y −1 → 0). Cap normals are the superellipse's analytic normals. */
function buildColumnGeometry(lodName, idxAttr) {
  const { radial, cap, n, skirt } = LOD[lodName];
  const prof = [[0.5, -1.6, 0, 1, 0]];                              // r, y, kind, nr, ny (base: placeholder y)
  if (skirt) prof.push([0.5, -1.3, 1, 1, 0]);
  const e = 2 / n;
  for (const deg of cap) {
    const t = (deg * Math.PI) / 180, c = Math.max(Math.cos(t), 0), s = Math.abs(Math.sin(t)), sg = deg < 0 ? -1 : 1;
    // upper dome: y ∈ [−1, 0]; the undercut below the equator: y ∈ [−2, −1] (the shader scales each part)
    const r = deg >= 90 ? 0 : 0.5 * Math.pow(c, e), y = -1 + sg * Math.pow(s, e);
    // ∇((x/a)^n + (y/b)^n) with a = 0.5, b = 1 (the cap's normalised half-width and height)
    let nr = Math.pow(c, 2 - e) / 0.5, ny = sg * Math.pow(s, 2 - e);
    const l = Math.hypot(nr, ny) || 1; nr /= l; ny /= l;
    prof.push([r, y, 2, nr, ny]);
  }
  const lathe = new LatheGeometry(prof.map(([r, y]) => new Vector2(r, y)), radial);
  const np = prof.length;
  const g = new InstancedBufferGeometry();
  g.setIndex(lathe.getIndex());
  g.setAttribute('position', lathe.getAttribute('position'));
  const count = lathe.getAttribute('position').count;
  const kind = new Float32Array(count), nrm = new Float32Array(3 * count);
  for (let v = 0; v < count; v++) {
    const seg = Math.floor(v / np), j = v % np, phi = (seg / radial) * Math.PI * 2;
    const [, , k, nr, ny] = prof[j];
    kind[v] = k;
    nrm[3 * v] = Math.sin(phi) * nr; nrm[3 * v + 1] = ny; nrm[3 * v + 2] = Math.cos(phi) * nr;
  }
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('aKind', new BufferAttribute(kind, 1));
  g.setAttribute('aIdx', idxAttr);
  g.instanceCount = 0;
  lathe.dispose();
  return g;
}

export function createCells({ tier, palette = TISSUE_HEX }) {
  // ── CPU copies (picking, labels) and GPU textures ──
  const cell = new Uint8Array(4 * N);
  const life = new Uint8Array(4 * N);
  const morph = new Float32Array(4 * N);
  const events = new Int32Array(EV_WORDS * MAX_EVENTS_PER_FRAME);
  const tCell = dataTexture(cell, UnsignedByteType);
  const tLife = dataTexture(life, UnsignedByteType);
  const tMorph = dataTexture(morph, FloatType);
  const tRamps = new DataTexture(buildRampBytes(), 256, 8, RGBAFormat, UnsignedByteType);
  tRamps.colorSpace = SRGBColorSpace;
  tRamps.minFilter = tRamps.magFilter = LinearFilter;
  tRamps.generateMipmaps = false;
  tRamps.needsUpdate = true;

  const idxArray = new Uint16Array(N);
  const idxAttr = new InstancedBufferAttribute(idxArray, 1);
  idxAttr.setUsage(DynamicDrawUsage);
  let idxCount = 0, eventCount = 0, flashScale = 1;

  const paletteLin = palette.map((h) => new Color(h));   // ColorManagement converts sRGB hex → linear
  const flashLum = paletteLin.map((c) => 1.5 * lumOf(c));  // the commitment flash's peak luminance per type
  // Cells whose latest event may still be glowing (a fate change or a death), gathered from the life texture at
  // ingest: every event is in it, including any beyond the frame's event list (MAX_EVENTS_PER_FRAME).
  const trAge = new Float32Array(N), trLum = new Float32Array(N);   // event age (ticks); peak lum (> 0 flash, < 0 ember)
  let trCount = 0, transientLum = 0, transientShown = 0;

  // ── display pass: MRT ping-pong at 200×200 ──
  const makeTarget = () => new WebGLRenderTarget(GRID, GRID, {
    count: 3, type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter,
    depthBuffer: false, generateMipmaps: false,
  });
  let dRead = makeTarget(), dWrite = makeTarget();
  const DU = {
    uCell: { value: tCell }, uLife: { value: tLife }, uMorph: { value: tMorph }, uRamps: { value: tRamps },
    uPrevA: { value: dRead.textures[0] }, uPrevB: { value: dRead.textures[1] }, uPrevC: { value: dRead.textures[2] },
    uPalette: { value: paletteLin }, uView: { value: 0 }, uIsolate: { value: 0 },
    uChanMask: { value: new Vector4(1, 0, 0, 0) }, uDomainMax: { value: 1 }, uSqrtScale: { value: 0 },
    uK: { value: 1 }, uVisRel: { value: 0 }, uBands: { value: new Vector4(1, 2, 6, 8) },
    uDome: { value: new Vector4(4, 1.4, 0.75, 0) },   // stage.js sets it (see RELIEF_GLSL)
    uThr: { value: new Vector2(30, 42) }, uDepthStep: { value: DEPTH_STEP }, uGlowK: { value: GLOW_K },
  };
  const displayMat = new RawShaderMaterial({
    glslVersion: GLSL3, vertexShader: S.FULLSCREEN_VERT, fragmentShader: S.DISPLAY_FRAG, uniforms: DU,
    depthTest: false, depthWrite: false,
  });
  const quad = new FullScreenQuad(displayMat);

  // halo: 50×50 average of the display colour (the agar blurs it into scattered light around the tissue)
  const haloRT = new WebGLRenderTarget(GRID / 4, GRID / 4, {
    type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, generateMipmaps: false,
  });
  const haloMat = new RawShaderMaterial({
    glslVersion: GLSL3, vertexShader: S.FULLSCREEN_VERT, fragmentShader: S.HALO_FRAG,
    uniforms: { uDispA: { value: dRead.textures[0] } }, depthTest: false, depthWrite: false,
  });
  const haloQuad = new FullScreenQuad(haloMat);

  // ── the cell material ──
  const U = {
    uCell: DU.uCell, uLife: DU.uLife,
    uDispA: { value: dRead.textures[0] }, uDispB: { value: dRead.textures[1] }, uDispC: { value: dRead.textures[2] },
    uBend: { value: 1.15 }, uPalette: DU.uPalette, uSq: { value: SHAPE_SQ }, uCapH: { value: SHAPE_CAP_H }, uUnder: { value: SHAPE_UNDER },
    uSkirt: { value: SKIRT.clone() },
    uVisRel: DU.uVisRel, uTau: { value: new Vector3(1, 1, 1) }, uReduced: { value: 0 }, uFlashScale: { value: 1 },
    uGlowOn: { value: 1 }, uFlat: { value: 0 }, uView: DU.uView, uIsolate: DU.uIsolate,
    uHover: { value: -1 }, uPinned: { value: -1 }, uHiCol: { value: new Color('#CFE0FF') },
    uExplodeS: { value: 0 }, uPlateY: { value: new Vector4(72, 54, 36, 18) }, uOrg: { value: new Vector3(0, 0, 40) },
    // analytic light terms (stage.js keeps the view-space directions current)
    uScatter: { value: 0.18 }, uTrans: { value: 1.5 }, uWrap: { value: 0.5 }, uRimK: { value: 1.5 },
    uSoftbox: { value: 1.2 }, uGlowGain: { value: 1.55 },
    uKeyDirV: { value: new Vector3(0, 1, 0) }, uKeyCol: { value: new Color(1, 1, 1) },
    uBackDirV: { value: new Vector3(0, 0.3, -1) }, uBackCol: { value: new Color('#cfe0ff') },
    uUpV: { value: new Vector3(0, 1, 0) }, uSky: { value: new Color(0.016, 0.017, 0.02) }, uGround: { value: new Color(0.03, 0.036, 0.05) },
    uUnlit: { value: 0 },
  };

  // No environment map on the cells: their reflections are analytic (key softbox, rim), which is both the look
  // (a dark room, two lights) and much cheaper than three PMREM lookups per fragment.
  const material = new MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.45, metalness: 0.0,
    clearcoat: 1.0, clearcoatRoughness: 0.08,
    fog: false,
  });
  let dfgUniform = null;                 // three's shared DFG LUT (released on dispose so a new renderer re-uploads it)
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    dfgUniform = sh.uniforms.dfgLUT || null;
    sh.vertexShader = patchShader(sh.vertexShader, [
      ['#include <common>', '#include <common>\n' + S.CELL_VERT_PARS],
      ['#include <beginnormal_vertex>', S.CELL_VERT_NORMAL],
      ['#include <begin_vertex>', S.CELL_VERT_BEGIN],
    ], 'meshphysical_vert');
    sh.fragmentShader = patchShader(sh.fragmentShader, [
      ['#include <common>', '#include <common>\n' + S.CELL_FRAG_PARS],
      ['#include <color_fragment>', '#include <color_fragment>\n' + S.CELL_FRAG_COLOR],
      ['#include <roughnessmap_fragment>', S.CELL_FRAG_ROUGH],
      ['#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + S.CELL_FRAG_EMISSIVE],
      ['#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + S.CELL_FRAG_COAT],
      ['#include <lights_fragment_begin>', lightsBeginWithKeyVis()],
      ['#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + S.CELL_FRAG_SCATTER],
      ['#include <aomap_fragment>', S.CELL_FRAG_AO],
      ['#include <opaque_fragment>', S.CELL_FRAG_OUT + '\n#include <opaque_fragment>'],
    ], 'meshphysical_frag');
  };
  material.customProgramCacheKey = () => 'ee-cells-2';

  const depthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depthMaterial.defines = { EE_DEPTH: '' };
  depthMaterial.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = patchShader(sh.vertexShader, [
      ['#include <common>', '#include <common>\n' + S.CELL_VERT_PARS],
      ['#include <begin_vertex>', S.CELL_DEPTH_BEGIN],
    ], 'depth_vert');
  };
  depthMaterial.customProgramCacheKey = () => 'ee-cells-depth-2';

  let tierLod = tier.lod, lodName = lodForCount(tierLod, 37, null);
  let geometry = buildColumnGeometry(lodName, idxAttr);
  function useLod(name) {
    if (name === lodName || !LOD[name]) return;
    lodName = name;
    const old = geometry;
    geometry = buildColumnGeometry(name, idxAttr);
    geometry.instanceCount = idxCount;
    mesh.geometry = geometry;
    // The instance-index attribute is shared with the shadow proxy: detach it first, or disposing the old geometry
    // deletes its GPU buffer under the proxy (whose shadow pass then drew every cell at one place).
    old.deleteAttribute('aIdx');
    old.dispose();
  }
  const mesh = new Mesh(geometry, material);
  mesh.name = 'cells';
  mesh.frustumCulled = false;
  mesh.castShadow = false;               // the proxy below casts; the visible cells only receive
  mesh.receiveShadow = true;

  // Shadow proxy: 32 triangles per cell instead of the visible LOD. Its own material puts every vertex outside the
  // clip volume, so on screen it costs one cheap draw; in the shadow pass it renders with the cells' depth material.
  const proxyGeo = buildColumnGeometry('shadow', idxAttr);
  const nullMat = new ShaderMaterial({ vertexShader: S.NULL_VERT, fragmentShader: S.NULL_FRAG, depthWrite: false, depthTest: false, colorWrite: false });
  const shadowMesh = new Mesh(proxyGeo, nullMat);
  shadowMesh.name = 'cells-shadow';
  shadowMesh.frustumCulled = false;
  shadowMesh.castShadow = true;
  shadowMesh.receiveShadow = false;
  shadowMesh.customDepthMaterial = depthMaterial;

  let snapNext = true;

  return {
    mesh, shadowMesh, material, depthMaterial, uniforms: U, displayUniforms: DU,
    cell, life, morph, events, textures: { tCell, tLife, tMorph, tRamps, tHalo: haloRT.texture },
    get idxCount() { return idxCount; },
    get eventCount() { return eventCount; },
    idxArray,

    /** Copy a frame's arrays into our own (the caller acks right after). Returns the number of FATE events. */
    ingest(frame) {
      cell.set(frame.cell);
      life.set(frame.life);
      tCell.needsUpdate = true;
      tLife.needsUpdate = true;
      if (frame.morph) { morph.set(frame.morph); tMorph.needsUpdate = true; }
      idxArray.set(frame.idx);
      idxCount = frame.idxCount | 0;
      idxAttr.needsUpdate = true;
      useLod(lodForCount(tierLod, idxCount, lodName));
      geometry.instanceCount = idxCount;
      proxyGeo.instanceCount = idxCount;
      eventCount = Math.min(frame.eventCount | 0, MAX_EVENTS_PER_FRAME);
      events.set(frame.events);
      let fates = 0;
      for (let e = 0; e < eventCount; e++) if ((events[e * EV_WORDS] & 0xff) === EV.FATE) fates++;
      trCount = 0;
      for (let k = 0; k < idxCount; k++) {
        const o = 4 * idxArray[k], age = life[o + 2];
        if (age >= 255) continue;                        // no recent event
        const kind = life[o + 1] & 3, type = cell[o];
        if (kind === 3 && type > 0) { trAge[trCount] = age; trLum[trCount++] = flashLum[type]; }
        else if (kind === 2 && type === 0) { trAge[trCount] = age; trLum[trCount++] = -EMBER_LUM; }
      }
      return fates;
    },

    /** Flash safety (WCAG 2.3.1), every rendered frame, after the clock. Fate changes arrive in synchronised waves
     *  (and at hundreds of ticks per second a whole wave lands inside one frame), which pulsed the whole organism.
     *  Sum what the vertex shader is about to draw, the commitment flashes' and death embers' actual envelopes at
     *  this frame's event clock, and scale both so their mean emission per visible cell stays under TRANSIENT_MAX
     *  and rises by at most TRANSIENT_RISE a frame. Measured on the frame it is drawn, the budget holds whatever the
     *  tick rate, the ticks per frame, a catch-up of the display clock or a change of τ. The scale drops at once and
     *  recovers over ~1 s (wall time), so consecutive waves cannot pump; a lone fate change still flashes fully. */
    updateTransients(dt) {
      let sum = 0;
      if (U.uReduced.value < 0.5 && trCount > 0 && idxCount > 0) {
        const vr = DU.uVisRel.value, tf = FLASH_ENV / U.uTau.value.z, td = 1 / U.uTau.value.y;
        for (let j = 0; j < trCount; j++) {
          const tv = vr + trAge[j] + 1, L = trLum[j];     // visual ticks since the event (CELL_VERT's tv)
          if (tv < 0) continue;
          if (L > 0) { const x = tv * tf; if (x < 12) sum += L * Math.exp(-x); }
          else { const ph = tv * td; if (ph < 1) sum -= L * Math.exp(-EMBER_ENV * ph); }
        }
        sum *= 1 - U.uFlat.value;
      }
      transientLum = idxCount > 0 ? sum / idxCount : 0;
      const t = Math.max(dt, 0), rise = TRANSIENT_RISE * Math.min(2, Math.max(0.5, t * 60));
      let scale = flashScale + (1 - flashScale) * (1 - Math.exp(-t / TRANSIENT_RECOVER_S));
      if (transientLum > 0) scale = Math.min(scale, TRANSIENT_MAX / transientLum, (transientShown + rise) / transientLum);
      flashScale = scale;
      transientShown = scale * transientLum;
      U.uFlashScale.value = flashScale;
    },
    /** QA: the unscaled mean transient emission per visible cell, and the scale applied (see updateTransients). */
    get transients() { return { lum: transientLum, shown: transientShown, scale: flashScale, candidates: trCount }; },

    /** Snap the display EMA on the next pass (first frame, reset, snapshot, view change under reduced motion). */
    snap() { snapNext = true; },

    /** Run the display pass (every rendered frame). */
    updateDisplay(renderer, dt) {
      DU.uPrevA.value = dRead.textures[0];
      DU.uPrevB.value = dRead.textures[1];
      DU.uPrevC.value = dRead.textures[2];
      DU.uK.value = snapNext ? 1 : 1 - Math.exp(-Math.max(dt, 0) / EMA_TAU);
      snapNext = false;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(dWrite);
      quad.render(renderer);
      renderer.setRenderTarget(prev);
      const t = dRead; dRead = dWrite; dWrite = t;
      U.uDispA.value = dRead.textures[0];
      U.uDispB.value = dRead.textures[1];
      U.uDispC.value = dRead.textures[2];
      haloMat.uniforms.uDispA.value = dRead.textures[0];
      renderer.setRenderTarget(haloRT);
      haloQuad.render(renderer);
      renderer.setRenderTarget(prev);
    },

    /** The tier's LOD; small embryos get finer tessellation on top of it (lodForCount). */
    setLod(name) {
      if (!LOD[name]) return;
      tierLod = name;
      useLod(lodForCount(tierLod, idxCount, lodName));
    },
    get lod() { return lodName; },

    setSheen() {},                        // the wet-gel look has no sheen lobe (kept for the tier API)

    setReducedMotion(on) {
      U.uReduced.value = on ? 1 : 0;
      if (material.alphaHash !== !!on) { material.alphaHash = !!on; material.needsUpdate = true; }
    },

    dispose() {
      geometry.dispose();
      proxyGeo.dispose();
      material.dispose();
      nullMat.dispose();
      depthMaterial.dispose();
      displayMat.dispose();
      quad.dispose();
      haloMat.dispose();
      haloQuad.dispose();
      haloRT.dispose();
      dRead.dispose();
      dWrite.dispose();
      tCell.dispose(); tLife.dispose(); tMorph.dispose(); tRamps.dispose();
      dfgUniform?.value?.dispose();
    },
  };
}
