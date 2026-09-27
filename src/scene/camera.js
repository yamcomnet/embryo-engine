// src/scene/camera.js — camera presets, auto-framing, transitions and the turntable on top of OrbitControls.
// A pose is { tx, ty, tz, dist, az, el, fov } (az/el in radians; az 0 = camera on +z, looking toward anterior −z).
// While the user drives OrbitControls the rig stays out of the way; presets, auto-framing, orbitBy and zoomBy
// animate the pose (0.9 s ease for presets, a critically damped spring for auto-framing, cuts under reduced motion).
import { MathUtils, Vector3 } from 'three';

const DEG = Math.PI / 180;
const AZ0 = -26 * DEG;           // hero azimuth: a 3/4 view from the front-left
// Low, macro elevations: the far dish rim and the objective sit behind the specimen and melt into bokeh.
// The macro pose drops to 10° on a tiny embryo (each row of seed pearls hides the stalks of the rows behind it,
// and the dish's lit lip rises into frame behind them) and lifts to 18° as it grows.
const EL_SPEC = 20 * DEG, EL_CLOSE_MIN = 10 * DEG, EL_CLOSE_MAX = 18 * DEG, EL_MAP = 89.3 * DEG, EL_APART = 15 * DEG;
const FILL_SPEC = 0.66, FILL_CLOSE = 0.8;
const FOV = 30, FOV_MAP = 18;
const DISH_OUTER = 114;
const OMEGA = 2.5;               // spring angular frequency (rad/s)
const TURN_RATE = 2.4 * DEG;     // turntable: one revolution in 150 s
const KEYS = ['tx', 'ty', 'tz', 'dist', 'az', 'el', 'fov'];

const makePose = () => ({ tx: 0, ty: 0, tz: 0, dist: 400, az: AZ0, el: EL_SPEC, fov: FOV });
const copyPose = (o, p) => { for (const k of KEYS) o[k] = p[k]; return o; };
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };

export function createRig(camera, controls, { reducedMotion = false } = {}) {
  const cur = makePose(), goal = makePose(), from = makePose(), vel = makePose();
  for (const k of KEYS) vel[k] = 0;
  const org = { cx: 0, cz: 0, rMax: 4, hMax: 3, plateTop: 72, plateBase: 18 };
  let preset = 'specimen', auto = true, exploded = false, user = false, reduced = reducedMotion;
  let tween = null;                 // { t, dur }
  let manual = null;                // pose offsets from orbitBy/zoomBy while not following
  let aspect = 1.6;
  // Share of the canvas left free by the HUD (the stage centres the view on that region with a view offset);
  // the organism is fitted to it.
  let regionX = 1, regionY = 1;
  const turn = { want: false, az: 0, w: 0 };   // turntable: accumulated azimuth and eased angular speed
  const off = new Vector3();

  /** Distance that fits the organism (radius R, dome height H) seen from elevation `el` into `fill` of the free region. */
  function fitOrganism(R, H, el, fov, fill) {
    const tv = Math.tan((fov * DEG) / 2), th = tv * aspect;
    const halfW = R, halfH = 0.5 * (2 * R * Math.sin(el) + H * Math.cos(el));
    return Math.max(halfW / (fill * th * regionX), halfH / (fill * tv * regionY));
  }
  function fitDist(R, fov, fill) {
    const tv = Math.tan((fov * DEG) / 2);
    return R / (fill * Math.min(tv * regionY, tv * aspect * regionX));
  }
  function framed(o, el, fill) {
    const R = 1.04 * org.rMax + 1.2;
    if (aspect < 0.8) fill *= 0.9;          // portrait phones: a little room beside the organism for a callout
    o.tx = org.cx; o.ty = 0.36 * org.hMax; o.tz = org.cz;
    o.dist = MathUtils.clamp(fitOrganism(R, org.hMax, el, FOV, fill), 17, 1100);
    o.az = AZ0 + turn.az; o.el = el; o.fov = FOV;
    return o;
  }
  const closePose = (o) => framed(o, MathUtils.lerp(EL_CLOSE_MIN, EL_CLOSE_MAX, MathUtils.smoothstep(org.rMax, 4, 30)), FILL_CLOSE);
  const specimenPose = (o) => framed(o, EL_SPEC, FILL_SPEC);
  const tmpA = makePose(), tmpB = makePose();

  /** The pose the current preset asks for (auto-framed when `auto`). */
  function computeGoal(o) {
    if (preset === 'map') {
      const R = auto ? org.rMax + 8 : DISH_OUTER + 4;
      o.tx = auto ? org.cx : 0; o.ty = 0; o.tz = auto ? org.cz : 0;
      o.dist = MathUtils.clamp(fitDist(R, FOV_MAP, 0.86), 60, 1600); o.az = 0; o.el = EL_MAP; o.fov = FOV_MAP;
      return o;
    }
    if (preset === 'close') closePose(o);
    else {
      // 'specimen': macro on the seeds, easing to the hero framing (a little more room, a little lower) as it grows
      closePose(tmpA); specimenPose(tmpB);
      let s = MathUtils.clamp((org.rMax - 5) / 22, 0, 1);
      if (reduced) s = s < 0.25 ? 0 : s < 0.75 ? 0.5 : 1;                 // snap between three framings
      s = s * s * (3 - 2 * s);
      for (const k of KEYS) o[k] = tmpA[k] + (tmpB[k] - tmpA[k]) * s;
    }
    if (exploded) {
      o.el = EL_APART;
      o.dist = Math.max(o.dist * 1.3, fitDist(0.5 * (org.plateTop - 0) + 6, FOV, 0.8));
      o.ty = 0.5 * (org.plateBase + org.plateTop) * 0.8;
    }
    return o;
  }

  function readCamera(o) {
    off.copy(camera.position).sub(controls.target);
    o.tx = controls.target.x; o.ty = controls.target.y; o.tz = controls.target.z;
    o.dist = Math.max(1e-3, off.length());
    o.el = Math.asin(MathUtils.clamp(off.y / o.dist, -1, 1));
    o.az = Math.atan2(off.x, off.z);
    o.fov = camera.fov;
    return o;
  }

  function writeCamera(p) {
    controls.target.set(p.tx, p.ty, p.tz);
    const ce = Math.cos(p.el);
    camera.position.set(p.tx + p.dist * ce * Math.sin(p.az), p.ty + p.dist * Math.sin(p.el), p.tz + p.dist * ce * Math.cos(p.az));
    if (camera.fov !== p.fov) { camera.fov = p.fov; camera.updateProjectionMatrix(); }
    camera.lookAt(controls.target);
  }

  function startTween(dur = 0.9) {
    readCamera(from);
    copyPose(cur, from);
    for (const k of KEYS) vel[k] = 0;
    if (reduced || dur <= 0) { computeGoal(goal); applyManual(goal); copyPose(cur, goal); writeCamera(cur); tween = null; return; }
    tween = { t: 0, dur };
  }
  function applyManual(p) {
    if (!manual) return;
    p.az += manual.az; p.el = MathUtils.clamp(p.el + manual.el, 2 * DEG, 89.4 * DEG); p.dist *= manual.zoom;
  }

  return {
    get preset() { return preset; },
    get auto() { return auto; },
    get userControlled() { return user; },
    get fovMap() { return preset === 'map'; },
    /** True while the turntable is actually turning (it eases in and out). */
    get turning() { return Math.abs(turn.w) > 1e-4; },

    setAspect(a) { aspect = a; },
    setRegion(fx, fy) { regionX = MathUtils.clamp(fx, 0.3, 1); regionY = MathUtils.clamp(fy, 0.3, 1); },
    setReducedMotion(on) { reduced = !!on; if (reduced) turn.w = 0; },
    setOrganism(cx, cz, rMax, hMax, plateBase, plateTop) {
      org.cx = cx; org.cz = cz; org.rMax = Math.max(2, rMax); org.hMax = hMax; org.plateBase = plateBase; org.plateTop = plateTop;
    },
    /** Turntable: a slow orbit while the run plays and nobody has touched the camera (the caller decides). */
    setTurntable(on) { turn.want = !!on; },
    setPreset(p, { animate = true } = {}) { preset = p; user = false; manual = null; startTween(animate ? 0.9 : 0); },
    setAuto(on) { auto = !!on; if (auto) { user = false; manual = null; startTween(0.9); } },
    setExploded(on) {
      if (exploded === !!on) return;
      exploded = !!on;
      if (auto && !user) startTween(1.1);
    },
    frame() { user = false; manual = null; startTween(0.9); },
    /** Keyboard orbit/zoom: a short glide on top of the current pose; the rig then holds it. */
    orbitBy(dAzDeg, dElDeg) {
      readCamera(from);
      manual = manual || { az: 0, el: 0, zoom: 1 };
      manual.az += dAzDeg * DEG; manual.el += dElDeg * DEG;
      user = false; startTween(0.35);
    },
    zoomBy(f) {
      manual = manual || { az: 0, el: 0, zoom: 1 };
      manual.zoom = MathUtils.clamp(manual.zoom * f, 0.1, 8);
      user = false; startTween(0.35);
    },
    /** OrbitControls 'start': the user takes over. */
    onUserStart() { user = true; tween = null; manual = null; turn.w = 0; },

    /** Advance transitions. Returns true while the camera is moving. */
    update(dt) {
      if (user) return false;
      // the turntable eases in and out over ~1 s; it only turns under auto-framing with no manual offsets
      const turnOn = turn.want && auto && !manual && !reduced && preset !== 'map';
      turn.w += ((turnOn ? TURN_RATE : 0) - turn.w) * (1 - Math.exp(-dt / 0.6));
      if (Math.abs(turn.w) < 1e-5 && !turnOn) turn.w = 0;
      turn.az = wrapPi(turn.az + turn.w * dt);
      computeGoal(goal);
      applyManual(goal);
      goal.az = (tween ? from.az : cur.az) + wrapPi(goal.az - (tween ? from.az : cur.az));
      if (tween) {
        tween.t += dt;
        const e = easeInOut(Math.min(1, tween.t / tween.dur));
        for (const k of KEYS) cur[k] = from[k] + (goal[k] - from[k]) * e;
        if (tween.t >= tween.dur) tween = null;
        writeCamera(cur);
        return true;
      }
      if (!auto && !manual) { readCamera(cur); return false; }
      if (reduced) {
        let moved = false;
        for (const k of KEYS) if (Math.abs(goal[k] - cur[k]) > 1e-3) { moved = true; cur[k] = goal[k]; }
        if (moved) writeCamera(cur);
        return false;
      }
      // critically damped spring toward the (moving) goal
      const ex = Math.exp(-OMEGA * dt);
      let moving = turn.w !== 0;
      for (const k of KEYS) {
        const x0 = cur[k] - goal[k];
        const tmp = (vel[k] + OMEGA * x0) * dt;
        vel[k] = (vel[k] - OMEGA * tmp) * ex;
        cur[k] = goal[k] + (x0 + tmp) * ex;
        const scale = k === 'dist' ? 0.02 : k === 'az' || k === 'el' ? 1e-4 : k === 'fov' ? 0.01 : 0.01;
        if (Math.abs(cur[k] - goal[k]) > scale || Math.abs(vel[k]) > scale) moving = true;
      }
      writeCamera(cur);
      return moving;
    },

    /** Current elevation of the camera (radians), from the live camera. */
    elevation() { readCamera(tmpA); return tmpA.el; },
    azimuth() { readCamera(tmpA); return tmpA.az; },
  };
}
