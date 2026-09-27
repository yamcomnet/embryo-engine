// src/scene/motes.js — energy motes: when a cell dies, one warm spark per recipient hops from the dead cell to the
// neighbour that received its energy (DEATH event recipientMask), timed by the same event clock as the ghost's
// deflation. Brightness follows the energy passed on. A fixed ring of instanced sprites; positions are computed on
// the GPU from the display heights, so a frame only writes the newly spawned slots.
import {
  AdditiveBlending, BufferAttribute, Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry,
  Mesh, ShaderMaterial,
} from 'three';
import { GRID, DX, DY, EV, EV_WORDS } from '../shared.js';

const VERT = /* glsl */`
attribute float aFrom;
attribute float aTo;
attribute float aT0;
attribute float aE;
uniform highp sampler2D uDispA;
uniform float uNow;
uniform vec3 uTau;
uniform float uFlat;
uniform float uSize;
uniform float uHide;
varying float vA;
varying vec2 vQ;
vec3 topOf(float idx) {
  int i = int(idx + 0.5);
  ivec2 tc = ivec2(i % 200, i / 200);
  float h = mix(texelFetch(uDispA, tc, 0).a, 0.6, uFlat);
  return vec3(float(tc.x) - 99.5, h + 0.2, float(tc.y) - 99.5);
}
void main() {
  float p = (uNow - aT0 + 1.0) / uTau.y;
  vQ = position.xy;
  vA = 0.0;
  if (uHide > 0.5 || aE <= 0.0 || p < 0.0 || p > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 a = topOf(aFrom), b = topOf(aTo);
  vec3 d = b - a;
  d.x -= 200.0 * floor(d.x / 200.0 + 0.5);            // toroidal neighbours: take the short way
  d.z -= 200.0 * floor(d.z / 200.0 + 0.5);
  float e = p * p * (3.0 - 2.0 * p);
  vec3 c = a + d * e;
  c.y += 0.8 * sin(3.14159265 * p);
  vec4 mv = modelViewMatrix * vec4(c, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
  vA = aE * sin(3.14159265 * p);
}`;

const FRAG = /* glsl */`
uniform vec3 uCol;
varying float vA;
varying vec2 vQ;
void main() {
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0 || vA <= 0.0) discard;
  gl_FragColor = vec4(uCol * (vA * exp(-r2 * 5.0)), 1.0);
}`;

export function createMotes({ capacity = 256, dispA, tau }) {
  const cap = Math.max(1, capacity);
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const mk = () => { const a = new InstancedBufferAttribute(new Float32Array(cap), 1); a.setUsage(DynamicDrawUsage); return a; };
  const aFrom = mk(), aTo = mk(), aT0 = mk(), aE = mk();
  g.setAttribute('aFrom', aFrom); g.setAttribute('aTo', aTo); g.setAttribute('aT0', aT0); g.setAttribute('aE', aE);
  g.instanceCount = capacity > 0 ? cap : 0;

  const U = {
    uDispA: dispA, uTau: tau, uNow: { value: -1e6 }, uFlat: { value: 0 }, uSize: { value: 0.26 }, uHide: { value: 0 },
    uCol: { value: new Color('#fff1d6').multiplyScalar(1.6) },
  };
  const material = new ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, uniforms: U, transparent: true, depthWrite: false, blending: AdditiveBlending,
  });
  const mesh = new Mesh(g, material);
  mesh.name = 'motes';
  mesh.frustumCulled = false;
  mesh.renderOrder = 9;

  let head = 0, base = -1, enabled = capacity > 0, alive = false;

  return {
    mesh, uniforms: U,
    get alive() { return alive; },

    setCapacity(n) {
      enabled = n > 0;
      g.instanceCount = enabled ? Math.min(cap, n) : 0;
    },

    /** Spawn motes for the frame's DEATH events. Returns the number spawned. */
    spawn(events, count, frameTick, allow) {
      if (base < 0 || frameTick < base) {             // first frame or reset: rebase ticks, clear the ring
        base = frameTick;
        aE.array.fill(0);
        aE.needsUpdate = true;
      }
      if (!enabled || !allow) return 0;
      const n = g.instanceCount;
      let spawned = 0;
      for (let e = 0; e < count; e++) {
        const o = e * EV_WORDS;
        if ((events[o] & 0xff) !== EV.DEATH) continue;
        const idx = events[o] >>> 8, tick = events[o + 1], a = events[o + 2];
        const mask = (a >> 4) & 15;
        if (!mask) continue;
        let k = 0;
        for (let d = 0; d < 4; d++) if (mask & (1 << d)) k++;
        const share = events[o + 3] / 1000 / k;
        const bright = Math.min(1.6, 0.35 + 0.45 * Math.log10(1 + share));
        const x = idx % GRID, y = (idx / GRID) | 0;
        for (let d = 0; d < 4; d++) {
          if (!(mask & (1 << d))) continue;
          const to = ((y + DY[d] + GRID) % GRID) * GRID + ((x + DX[d] + GRID) % GRID);
          aFrom.array[head] = idx; aTo.array[head] = to; aT0.array[head] = tick - base; aE.array[head] = bright;
          head = (head + 1) % n;
          spawned++;
        }
      }
      if (spawned) {
        aFrom.needsUpdate = aTo.needsUpdate = aT0.needsUpdate = aE.needsUpdate = true;
        alive = true;
      }
      return spawned;
    },

    /** Per render: the clock (visTick relative to the rebased tick). */
    update(frameTick, visRel, flat, hide) {
      U.uNow.value = base < 0 ? -1e6 : frameTick - base + visRel;
      U.uFlat.value = flat;
      U.uHide.value = hide ? 1 : 0;
    },

    dispose() { g.dispose(); material.dispose(); },
  };
}
