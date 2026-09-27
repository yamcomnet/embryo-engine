// src/scene/post.js — post chain: Scene (own HDR target with depth) → DOF (CoC + half-res golden-angle gather)
// → Bloom (mip chain, fed by the defocused half-res image so bokeh and glow agree) → Final (DOF composite + bloom
// + vignette + grain + Neutral tone map + sRGB, in ONE full-resolution pass) → FXAA → screen.
// Folding the DOF composite, the bloom blend, the grade and the output transform into one pass saves three
// full-resolution passes (≈0.65 ms each at DPR 2 on an M2 Pro); that budget pays for the stronger depth of field.
import {
  DepthTexture, HalfFloatType, LinearFilter, ShaderMaterial, UnsignedByteType, UnsignedIntType, Vector2, Vector4,
  WebGLRenderTarget, Matrix4,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import * as S from './shaders.js';

const BLOOM = { strength: 0.8, radius: 0.32, threshold: 1.0 };

/** UnrealBloomPass's mip chain without its final full-resolution blend: the Final pass adds the result. */
class BloomChain extends UnrealBloomPass {
  constructor() {
    super(new Vector2(256, 256), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    this.highPassUniforms.smoothWidth.value = 0.25;
    this.materialHighPassFilter.fragmentShader = S.BLOOM_HIGHPASS_FRAG;
    this.materialHighPassFilter.needsUpdate = true;
  }
  get texture() { return this.renderTargetsHorizontal[0].texture; }
  run(renderer, input) {
    const q = this._fsQuad;
    this.highPassUniforms.tDiffuse.value = input;
    this.highPassUniforms.luminosityThreshold.value = this.threshold;
    q.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright);
    q.render(renderer);
    let src = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const m = this.separableBlurMaterials[i];
      q.material = m;
      m.uniforms.colorTexture.value = src.texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      q.render(renderer);
      m.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      q.render(renderer);
      src = this.renderTargetsVertical[i];
    }
    q.material = this.compositeMaterial;
    this.compositeMaterial.uniforms.bloomStrength.value = this.strength;
    this.compositeMaterial.uniforms.bloomRadius.value = this.radius;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
    q.render(renderer);
  }
}

export function createPost(renderer, scene, camera, tier) {
  const hdr = (w, h, extra = {}) => new WebGLRenderTarget(w, h, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, ...extra });
  const sceneRT = hdr(1, 1, { depthBuffer: true, depthTexture: new DepthTexture(1, 1, UnsignedIntType) });
  const halfRT = hdr(1, 1), blurRT = hdr(1, 1);
  const ldrRT = new WebGLRenderTarget(1, 1, { type: UnsignedByteType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
  const quad = new FullScreenQuad();

  const U = {
    uProjInv: { value: new Matrix4() }, uCamWorld: { value: new Matrix4() }, uFocus: { value: 300 },
    uRange: { value: 100 }, uTopY: { value: 20 }, uK: { value: 90 }, uMaxCoc: { value: 12 }, uResY: { value: 1080 },
  };
  const mat = (frag, extra) => new ShaderMaterial({
    vertexShader: S.PASS_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, uniforms: { ...U, ...extra },
  });
  const cocMat = mat(S.DOF_COC_FRAG, { tColor: { value: sceneRT.texture }, tDepth: { value: sceneRT.depthTexture }, uFullTexel: { value: new Vector2() } });
  const gatherMat = mat(S.DOF_GATHER_FRAG, { tHalf: { value: halfRT.texture }, uFullTexel: { value: new Vector2() }, uTaps: { value: 16 } });
  const bloom = new BloomChain();
  const finalMat = mat(S.FINAL_FRAG, {
    tColor: { value: sceneRT.texture }, tDepth: { value: sceneRT.depthTexture }, tBlur: { value: blurRT.texture },
    tBloom: { value: bloom.texture }, uDofOn: { value: 1 }, uBloomOn: { value: 1 }, uHalfTexel: { value: new Vector2() },
    uVig: { value: 0.42 }, uGrain: { value: 0.025 }, uFrame: { value: 0 }, uAspect: { value: 1.6 },
  });
  const fxaaMat = new ShaderMaterial({ ...FXAAShader, uniforms: { tDiffuse: { value: ldrRT.texture }, resolution: { value: new Vector2() } }, depthTest: false, depthWrite: false });

  let cur = tier;
  let frame = 0;
  let cssW = 1, cssH = 1, dpr = 1;
  const state = { dofOn: true, dofActive: true, bloomOn: true, vignette: 0.42, reducedMotion: false };
  // Shared with the airborne dust so its bokeh follows the same lens: focus, range, K·(resY/1080), max CoC px.
  const dofUniform = { value: new Vector4() };

  function sizeAll() {
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    sceneRT.setSize(w, h);
    const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
    halfRT.setSize(hw, hh); blurRT.setSize(hw, hh);
    ldrRT.setSize(w, h);
    bloom.setSize(Math.max(2, Math.round(w * cur.bloomScale)), Math.max(2, Math.round(h * cur.bloomScale)));
    cocMat.uniforms.uFullTexel.value.set(1 / w, 1 / h);
    gatherMat.uniforms.uFullTexel.value.set(1 / w, 1 / h);
    finalMat.uniforms.uHalfTexel.value.set(1 / hw, 1 / hh);
    fxaaMat.uniforms.resolution.value.set(1 / w, 1 / h);
    U.uResY.value = h;
  }

  function applyTier(t) {
    cur = t;
    gatherMat.uniforms.uTaps.value = t.dof ? t.dof.taps : 0;
    finalMat.uniforms.uGrain.value = t.grain ? 0.025 : 0;
    sizeAll();
  }

  return {
    bloom, sceneRT, dofUniform, uniforms: U, finalMat,
    get dofActive() { return state.dofActive; },

    setSize(w, h, pixelRatio) {
      cssW = w; cssH = h; dpr = pixelRatio;
      finalMat.uniforms.uAspect.value = w / Math.max(1, h);
      sizeAll();
    },
    setTier: applyTier,

    /** Per-frame focus: distance to the focus point, in-focus half range, top of the specimen (world y). */
    setFocus(cam, focusDist, range, topY, mapMode) {
      U.uProjInv.value.copy(cam.projectionMatrixInverse);
      U.uCamWorld.value.copy(cam.matrixWorld);
      U.uFocus.value = focusDist;
      U.uRange.value = range;
      U.uTopY.value = topY;
      U.uMaxCoc.value = cur.dof ? cur.dof.maxCoc * (U.uResY.value / 1080) : 0;
      state.dofActive = state.dofOn && !!cur.dof && !mapMode;
      state.bloomOn = !mapMode;
      finalMat.uniforms.uVig.value = mapMode ? 0.12 : state.vignette;
      dofUniform.value.set(focusDist, range, U.uK.value * (U.uResY.value / 1080), state.dofActive ? U.uMaxCoc.value : 0);
    },
    setDofEnabled(on) { state.dofOn = !!on; },
    setReducedMotion(on) { state.reducedMotion = !!on; },

    render() {
      if (!state.reducedMotion) frame = (frame + 1) % 4096;
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(sceneRT);
      renderer.clear();
      renderer.render(scene, camera);

      const dofOn = state.dofActive;
      if (dofOn) {
        quad.material = cocMat;
        renderer.setRenderTarget(halfRT);
        quad.render(renderer);
        quad.material = gatherMat;
        renderer.setRenderTarget(blurRT);
        quad.render(renderer);
      }
      if (state.bloomOn) bloom.run(renderer, dofOn ? blurRT.texture : sceneRT.texture);

      const f = finalMat.uniforms;
      f.uDofOn.value = dofOn ? 1 : 0;
      f.uBloomOn.value = state.bloomOn ? 1 : 0;
      f.uFrame.value = frame;
      quad.material = finalMat;
      renderer.setRenderTarget(cur.fxaa ? ldrRT : null);
      quad.render(renderer);
      if (cur.fxaa) {
        quad.material = fxaaMat;
        renderer.setRenderTarget(null);
        quad.render(renderer);
      }
      renderer.setRenderTarget(prevTarget);
    },

    dispose() {
      sceneRT.depthTexture.dispose(); sceneRT.dispose(); halfRT.dispose(); blurRT.dispose(); ldrRT.dispose();
      cocMat.dispose(); gatherMat.dispose(); finalMat.dispose(); fxaaMat.dispose(); quad.dispose(); bloom.dispose();
    },
  };
}
