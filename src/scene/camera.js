// src/scene/camera.js — camera presets, auto-framing, transitions and the turntable on top of OrbitControls.
// A pose is { tx, ty, tz, dist, az, el, fov } (az/el in radians; az 0 = camera on +z, looking toward anterior −z).
// While the user drives OrbitControls the rig stays out of the way; presets, auto-framing, orbitBy and zoomBy
// animate the pose (0.9 s ease for presets, a critically damped spring for auto-framing, cuts under reduced motion).
// Keyboard orbit/zoom offsets sit on top of that pose as their own fast spring: repeated calls move its target, so a
// held key turns the camera at a steady rate and stops shortly after release.
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
const OMEGA_KEY = 14;            // keyboard orbit/zoom spring (rad/s): a 5° press is 95 % there in 0.35 s, no overshoot
const EL_MIN = 8 * DEG, EL_MAX = 89.4 * DEG;   // what OrbitControls allows (maxPolarAngle 82°, minPolarAngle 0.01)
const LZ_MIN = Math.log(0.1), LZ_MAX = Math.log(8);
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
  // Keyboard offsets on top of the framed pose, per axis (0 azimuth, 1 elevation, in radians; 2 log of the zoom
  // factor): mT = their targets, mX = the offsets shown, following mT on a critically damped spring (velocity mV).
  // `manual` = keyboard offsets are in effect.
  let manual = false;
  const mT = new Float64Array(3), mX = new Float64Array(3), mV = new Float64Array(3);
  const shown = makePose();         // the pose written to the camera: cur with the shown offsets
  let aspect = 1.6;
  // Share of the canvas left free by the HUD (the stage centres the view on that region with a view offset);
  // the organism is fitted to it. `fitPlates`: Apart also fits the plates' full width into it (narrow screens,
  // where the region leaves a column for the plate callouts).
  let regionX = 1, regionY = 1, fitPlates = false;
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
      // Apart seen from above: the top plate is plateTop nearer the camera than the floor, so it is the one fitted
      const lift = auto && exploded ? org.plateTop : 0;
      o.dist = MathUtils.clamp(fitDist(R, FOV_MAP, 0.86) + lift, 60, 1600); o.az = 0; o.el = EL_MAP; o.fov = FOV_MAP;
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
      if (fitPlates) {
        // narrow screens: the plates' full width (radius rMax + 8, and their lit edge) fills 90 % of the region beside
        // the callout column; the stack's height fits the region's height
        const tv = Math.tan((FOV * DEG) / 2);
        o.dist = Math.max((org.rMax + 9) / (0.9 * tv * aspect * regionX), (0.5 * org.plateTop + 6) / (0.8 * tv * regionY));
      } else o.dist = Math.max(o.dist * 1.3, fitDist(0.5 * (org.plateTop - 0) + 6, FOV, 0.8));
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

  /** The camera's pose less the shown keyboard offsets: the framed pose the tween and the spring move. */
  function readBase(o) {
    readCamera(o);
    o.az -= mX[0]; o.el -= mX[1]; o.dist /= Math.exp(mX[2]);
    return o;
  }
  /** `p` with the shown keyboard offsets applied (into `shown`), or `p` itself when there are none. */
  function withOffsets(p) {
    if (!manual) return p;
    shown.tx = p.tx; shown.ty = p.ty; shown.tz = p.tz; shown.fov = p.fov;
    shown.az = p.az + mX[0]; shown.el = MathUtils.clamp(p.el + mX[1], EL_MIN, EL_MAX); shown.dist = p.dist * Math.exp(mX[2]);
    return shown;
  }
  function startTween(dur = 0.9) {
    readBase(from);
    copyPose(cur, from);
    for (const k of KEYS) vel[k] = 0;
    if (reduced || dur <= 0) {
      computeGoal(goal); copyPose(cur, goal); clampElTarget(); stepManual(0); writeCamera(withOffsets(cur)); tween = null; return;
    }
    tween = { t: 0, dur };
  }
  function clearManual() {
    manual = false;
    mT.fill(0); mX.fill(0); mV.fill(0);
  }
  function ensureManual() {
    if (manual) return;
    clearManual();
    manual = true;
  }
  /** The elevation target stays reachable from the goal's elevation, so turning back the other way answers at once. */
  function clampElTarget() {
    if (manual) mT[1] = MathUtils.clamp(mT[1], EL_MIN - goal.el, EL_MAX - goal.el);
  }
  /** Keyboard offsets toward their targets (a cut under reduced motion). True while they move (or, reduced, changed). */
  function stepManual(dt) {
    if (!manual) return false;
    let moving = false;
    if (reduced) {
      for (let k = 0; k < 3; k++) if (mX[k] !== mT[k]) { mX[k] = mT[k]; mV[k] = 0; moving = true; }
      return moving;
    }
    const e = Math.exp(-OMEGA_KEY * dt);
    for (let k = 0; k < 3; k++) {
      const x0 = mX[k] - mT[k];
      if (x0 === 0 && mV[k] === 0) continue;
      const tmp = (mV[k] + OMEGA_KEY * x0) * dt;
      mV[k] = (mV[k] - OMEGA_KEY * tmp) * e;
      mX[k] = mT[k] + (x0 + tmp) * e;
      if (Math.abs(mX[k] - mT[k]) < 2e-5 && Math.abs(mV[k]) < 2e-4) { mX[k] = mT[k]; mV[k] = 0; } else moving = true;
    }
    return moving;
  }
  /** A keyboard nudge: the target moves; the camera glides from wherever the user left it only the first time. */
  function nudge() {
    const free = user || (!auto && !manual);
    ensureManual();
    user = false;
    if (free) startTween(0.35);
  }

  return {
    get preset() { return preset; },
    get auto() { return auto; },
    get userControlled() { return user; },
    get fovMap() { return preset === 'map'; },
    /** True while the turntable is actually turning (it eases in and out). */
    get turning() { return Math.abs(turn.w) > 1e-4; },

    setAspect(a) { aspect = a; },
    setRegion(fx, fy, plateFit = false) { regionX = MathUtils.clamp(fx, 0.3, 1); regionY = MathUtils.clamp(fy, 0.3, 1); fitPlates = !!plateFit; },
    setReducedMotion(on) { reduced = !!on; if (reduced) turn.w = 0; },
    setOrganism(cx, cz, rMax, hMax, plateBase, plateTop) {
      org.cx = cx; org.cz = cz; org.rMax = Math.max(2, rMax); org.hMax = hMax; org.plateBase = plateBase; org.plateTop = plateTop;
    },
    /** Turntable: a slow orbit while the run plays and nobody has touched the camera (the caller decides). */
    setTurntable(on) { turn.want = !!on; },
    setPreset(p, { animate = true } = {}) { preset = p; user = false; clearManual(); startTween(animate ? 0.9 : 0); },
    setAuto(on) { auto = !!on; if (auto) { user = false; clearManual(); startTween(0.9); } },
    setExploded(on) {
      if (exploded === !!on) return;
      exploded = !!on;
      if (auto && !user) startTween(1.1);
    },
    frame() { user = false; clearManual(); startTween(0.9); },
    /** Keyboard orbit/zoom: offsets on top of the framed pose, which the rig then holds. Calls accumulate into the
     *  offsets' targets (a held key repeats them ~30 times a second); the shown offsets follow on their own spring. */
    orbitBy(dAzDeg, dElDeg) {
      nudge();
      mT[0] += dAzDeg * DEG; mT[1] += dElDeg * DEG;       // the elevation is kept reachable in update()
    },
    zoomBy(f) {
      nudge();
      mT[2] = MathUtils.clamp(mT[2] + Math.log(f), LZ_MIN, LZ_MAX);
    },
    /** OrbitControls 'start': the user takes over. */
    onUserStart() { user = true; tween = null; clearManual(); turn.w = 0; },

    /** Advance transitions. Returns true while the camera is moving. */
    update(dt) {
      if (user) return false;
      // the turntable eases in and out over ~1 s; it only turns under auto-framing with no manual offsets
      const turnOn = turn.want && auto && !manual && !reduced && preset !== 'map';
      turn.w += ((turnOn ? TURN_RATE : 0) - turn.w) * (1 - Math.exp(-dt / 0.6));
      if (Math.abs(turn.w) < 1e-5 && !turnOn) turn.w = 0;
      turn.az = wrapPi(turn.az + turn.w * dt);
      computeGoal(goal);
      goal.az = (tween ? from.az : cur.az) + wrapPi(goal.az - (tween ? from.az : cur.az));
      clampElTarget();
      const mMoving = stepManual(dt);
      if (tween) {
        tween.t += dt;
        const e = easeInOut(Math.min(1, tween.t / tween.dur));
        for (const k of KEYS) cur[k] = from[k] + (goal[k] - from[k]) * e;
        if (tween.t >= tween.dur) tween = null;
        writeCamera(withOffsets(cur));
        return true;
      }
      if (!auto && !manual) { readCamera(cur); return false; }
      if (reduced) {
        let moved = mMoving;
        for (const k of KEYS) if (Math.abs(goal[k] - cur[k]) > 1e-3) { moved = true; cur[k] = goal[k]; }
        if (moved) writeCamera(withOffsets(cur));
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
      writeCamera(withOffsets(cur));
      return moving || mMoving;
    },

    /** Current elevation of the camera (radians), from the live camera. */
    elevation() { readCamera(tmpA); return tmpA.el; },
    azimuth() { readCamera(tmpA); return tmpA.az; },
  };
}
