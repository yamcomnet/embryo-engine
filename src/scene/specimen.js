// src/scene/specimen.js — the "Darkfield" set around the data: void, petri dish, agar field layer, darkfield
// illuminator, stage plate and clips, objective barrel, dust, the environment map, lights and the Apart plates.
// Props never use tissue hues, never move and never glow (except the illuminator ring and the glass rim it lights);
// the help lists them as decoration.
import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, CircleGeometry, Color, CylinderGeometry,
  DirectionalLight, DoubleSide, ExtrudeGeometry, Group, LatheGeometry, Mesh, MeshBasicMaterial,
  MeshPhysicalMaterial, MeshStandardMaterial, Path, PlaneGeometry, PMREMGenerator, Points, Scene,
  ShaderMaterial, Shape, ShadowMaterial, SphereGeometry, TorusGeometry, Vector2, Vector3, Vector4,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TISSUE_HEX } from '../shared.js';
import * as S from './shaders.js';

export const DISH_R = 112;          // inner radius of the dish
export const RING_R = 116.5;        // illuminator ring radius (hugs the dish base, under the stage glass)
const LIGHT = '#CFE0FF';            // the illuminator's pale blue-white (also the UI accent)
const KEY = '#FFF0DE';              // the warm key (a tungsten-ish microscope lamp, kept close to white)
const FAMILY_TYPE = [2, 3, 4, 1];   // plate k → the type whose colour marks its edge

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fresnel rim glow for glass: emissive rises toward grazing angles (the darkfield ring on the dish). */
function addRim(material, colour, strength, power = 4.0) {
  const u = { uRimCol: { value: new Color(colour) }, uRim: { value: strength }, uRimPow: { value: power } };
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    const needle = '#include <emissivemap_fragment>';
    if (!sh.fragmentShader.includes(needle)) throw new Error('three chunk changed: ' + needle);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRimCol;\nuniform float uRim;\nuniform float uRimPow;')
      .replace(needle, needle + '\ntotalEmissiveRadiance += uRimCol * uRim * pow(1.0 - saturate(abs(dot(normalize(vNormal), normalize(vViewPosition)))), uRimPow);');
  };
  material.customProgramCacheKey = () => 'ee-rim-' + power;
  return u;
}

export function createSpecimen(renderer, { cellTextures, displayUniforms, cellUniforms, dofUniform }) {
  const root = new Group();
  root.name = 'specimen';
  const disposables = [];
  const keep = (...xs) => { disposables.push(...xs); return xs[0]; };
  const envMats = [];                      // prop materials that reflect the environment (cells do not)
  const envd = (m, k = 1) => { envMats.push([m, k]); return m; };

  // ── void: a full-screen radial gradient drawn behind everything, with the illuminator's haze ──
  const voidMat = keep(new ShaderMaterial({
    vertexShader: S.VOID_VERT, fragmentShader: S.VOID_FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      uCentre: { value: new Color('#0b0d0c') }, uEdge: { value: new Color('#030303') }, uAspect: { value: 1.6 },
      uHazeCol: { value: new Color(LIGHT).multiplyScalar(0.03) }, uHaze: { value: new Vector4(0.5, 0.55, 1, 0.14) },
    },
  }));
  const voidGeo = keep(new BufferGeometry());
  voidGeo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const voidMesh = new Mesh(voidGeo, voidMat);
  voidMesh.frustumCulled = false;
  voidMesh.renderOrder = -1000;
  root.add(voidMesh);

  // ── agar: the dish floor, carrying the field layer ──
  const AU = {
    uCell: { value: cellTextures.tCell }, uLife: { value: cellTextures.tLife }, uMorph: { value: cellTextures.tMorph },
    uRamps: { value: cellTextures.tRamps }, uDispA: cellUniforms.uDispA, uHalo: { value: cellTextures.tHalo }, uHaloAmt: { value: 0.3 },
    uBaseTint: { value: 0.3 }, uGrid: { value: 0.012 }, uGridFade: { value: new Vector4(0, 0, 1e4, 1) }, uEdgeLine: { value: 0 },
    uView: displayUniforms.uView, uChanMask: displayUniforms.uChanMask,
    uDomainMax: displayUniforms.uDomainMax, uSqrtScale: displayUniforms.uSqrtScale,
    uGates: { value: new Vector4() }, uGateN: { value: 0 }, uSignal: { value: 0 }, uSurf: { value: 0 }, uApart: { value: 0 },
    uDishR: { value: DISH_R }, uBase: { value: new Color('#0c0f0e') }, uLine: { value: new Color(LIGHT) },
    uAmber: { value: new Color('#ffb070') },
  };
  const agarMat = keep(new ShaderMaterial({ vertexShader: S.AGAR_VERT, fragmentShader: S.AGAR_FRAG, uniforms: AU }));
  const agarGeo = keep(new CircleGeometry(DISH_R, 160));
  agarGeo.rotateX(-Math.PI / 2);
  const agar = new Mesh(agarGeo, agarMat);
  agar.position.y = 0.02;
  agar.renderOrder = -10;
  root.add(agar);

  // Shadow catcher just above the agar (the agar shader itself is unlit).
  const catcherMat = keep(new ShadowMaterial({ color: 0x000000, opacity: 0.62, depthWrite: false }));
  const catcher = new Mesh(agarGeo, catcherMat);
  catcher.position.y = 0.04;
  catcher.receiveShadow = true;
  catcher.renderOrder = -9;
  root.add(catcher);

  // ── petri dish: glass wall with a glowing fresnel rim (the darkfield ring the illuminator lights) ──
  const dishProfile = [
    [DISH_R - 1.2, -0.9], [DISH_R + 0.5, -0.9], [DISH_R + 0.8, -0.5], [DISH_R + 0.8, 7.7], [DISH_R + 0.62, 8.05],
    [DISH_R + 0.18, 8.05], [DISH_R, 7.7], [DISH_R, 0.3], [DISH_R - 0.4, 0.02],
  ].map(([r, y]) => new Vector2(r, y));
  const dishGeo = keep(new LatheGeometry(dishProfile.reverse(), 256));
  const dishMat = keep(envd(new MeshPhysicalMaterial({
    color: '#0e1210', roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04,
    transparent: true, opacity: 0.55, depthWrite: false, side: DoubleSide,
  }), 0.75));
  const dishRim = addRim(dishMat, LIGHT, 1.25, 3.8);
  const dish = new Mesh(dishGeo, dishMat);
  dish.renderOrder = 5;
  root.add(dish);
  // the glass lip catches the illuminator: a thin bright edge that the lens melts into a soft arc of light
  const lipGeo = keep(new TorusGeometry(DISH_R + 0.42, 0.42, 8, 360));
  lipGeo.rotateX(Math.PI / 2);
  const lipMat = keep(new MeshBasicMaterial({ color: new Color(LIGHT).multiplyScalar(0.34) }));
  const lip = new Mesh(lipGeo, lipMat);
  lip.position.y = 8.02;
  root.add(lip);

  // ── stage: glass insert, anodised plate with an aperture, condenser well, steel clips ──
  const insertGeo = keep(new CircleGeometry(123.5, 128));
  insertGeo.rotateX(-Math.PI / 2);
  const insertMat = keep(envd(new MeshPhysicalMaterial({
    color: '#060807', roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05, transparent: true, opacity: 0.22,
    depthWrite: false, envMapIntensity: 1.2,
  }), 1.2));
  const insert = new Mesh(insertGeo, insertMat);
  insert.position.y = -0.95;
  insert.renderOrder = 4;
  root.add(insert);

  const plateShape = new Shape();
  const PW = 300, PD = 240, PR = 18;
  plateShape.moveTo(-PW + PR, -PD);
  plateShape.lineTo(PW - PR, -PD); plateShape.quadraticCurveTo(PW, -PD, PW, -PD + PR);
  plateShape.lineTo(PW, PD - PR); plateShape.quadraticCurveTo(PW, PD, PW - PR, PD);
  plateShape.lineTo(-PW + PR, PD); plateShape.quadraticCurveTo(-PW, PD, -PW, PD - PR);
  plateShape.lineTo(-PW, -PD + PR); plateShape.quadraticCurveTo(-PW, -PD, -PW + PR, -PD);
  const hole = new Path();
  hole.absarc(0, 0, 123, 0, Math.PI * 2, true);
  plateShape.holes.push(hole);
  const plateGeo = keep(new ExtrudeGeometry(plateShape, {
    depth: 5, bevelEnabled: true, bevelThickness: 0.6, bevelSize: 0.6, bevelSegments: 2, curveSegments: 96,
  }));
  plateGeo.rotateX(-Math.PI / 2);
  // matte black anodising: it should read only as a faint edge, never as a grey surface behind the specimen
  const plateMat = keep(envd(new MeshStandardMaterial({ color: '#050606', roughness: 0.62, metalness: 0.5 }), 0.22));
  const stagePlate = new Mesh(plateGeo, plateMat);
  stagePlate.position.y = -0.95 - 5.6;
  stagePlate.receiveShadow = true;
  root.add(stagePlate);

  const wellGeo = keep(new CylinderGeometry(123, 121, 46, 128, 1, true));
  const wellMat = keep(new MeshStandardMaterial({ color: '#050606', roughness: 0.7, metalness: 0.2, side: BackSide }));
  const well = new Mesh(wellGeo, wellMat);
  well.position.y = -6.5 - 23;
  root.add(well);
  const wellFloorGeo = keep(new CircleGeometry(126, 96));
  wellFloorGeo.rotateX(-Math.PI / 2);
  const wellFloor = new Mesh(wellFloorGeo, wellMat);
  wellFloor.position.y = -52;
  wellFloor.material = keep(new MeshStandardMaterial({ color: '#030404', roughness: 0.9 }));
  root.add(wellFloor);

  const steel = keep(envd(new MeshPhysicalMaterial({ color: '#4a4f55', metalness: 1, roughness: 0.4, clearcoat: 0.2 }), 0.22));
  const clipGeo = keep(new RoundedBoxGeometry(36, 0.8, 7, 2, 0.36));
  const postGeo = keep(new CylinderGeometry(4.6, 5.2, 3.2, 48));
  const screwGeo = keep(new CylinderGeometry(3.0, 3.0, 1.2, 40));
  for (const a of [Math.PI * 0.62, -Math.PI * 0.38]) {
    const g = new Group();
    const bar = new Mesh(clipGeo, steel);
    bar.position.set(DISH_R + 1 + 16, 1.0, 0);
    bar.rotation.z = -0.035;
    bar.castShadow = true;
    const post = new Mesh(postGeo, steel);
    post.position.set(DISH_R + 1 + 30, -0.95 + 1.6, 0);
    const screw = new Mesh(screwGeo, steel);
    screw.position.set(DISH_R + 1 + 30, 1.9, 0);
    g.add(bar, post, screw);
    g.rotation.y = a;
    root.add(g);
  }

  // ── darkfield illuminator: the annular ring below the stage and a faint light curtain ──
  const ringGeo = keep(new TorusGeometry(RING_R, 0.42, 12, 360));
  ringGeo.rotateX(Math.PI / 2);
  const ringMat = keep(new ShaderMaterial({
    vertexShader: S.RING_VERT, fragmentShader: S.RING_FRAG,
    uniforms: { uCol: { value: new Color('#d9e6ff').multiplyScalar(1.9) } },
  }));
  const ring = new Mesh(ringGeo, ringMat);
  ring.position.y = -2.2;
  root.add(ring);

  const coneGeo = keep(new CylinderGeometry(104, RING_R, 34, 160, 1, true));
  const coneMat = keep(new ShaderMaterial({
    vertexShader: S.CONE_VERT, fragmentShader: S.CONE_FRAG, transparent: true, depthWrite: false,
    blending: AdditiveBlending, side: DoubleSide,
    uniforms: { uCol: { value: new Color('#cfe0ff') }, uI: { value: 0.07 } },
  }));
  const cone = new Mesh(coneGeo, coneMat);
  cone.position.y = -2.2 + 17;
  cone.renderOrder = 6;
  root.add(cone);

  // ── objective barrel hanging into the top of the frame (never glows; DOF melts it into a dark silhouette) ──
  const objective = new Group();
  const gun = keep(envd(new MeshPhysicalMaterial({ color: '#1c1f22', metalness: 0.85, roughness: 0.38, clearcoat: 0.3, clearcoatRoughness: 0.3, transparent: true, opacity: 1 }), 0.6));
  addRim(gun, LIGHT, 0.22, 4.0);                              // the back light grazes the barrel's silhouette
  const gunDark = keep(envd(new MeshPhysicalMaterial({ color: '#101214', metalness: 0.9, roughness: 0.5, envMapIntensity: 0.5, transparent: true, opacity: 1 }), 0.5));
  const bright = keep(envd(new MeshPhysicalMaterial({ color: '#b4bac0', metalness: 1, roughness: 0.2, transparent: true, opacity: 1 }), 1.1));
  const barrelProfile = [
    [0, 74], [9.5, 74], [10.8, 74.8], [12.5, 77.5], [17.5, 84], [21.5, 89], [22.4, 91], [22.4, 150], [26, 151.5],
    [26, 160], [23.6, 161], [23.6, 270], [28, 272], [28, 460],
  ].map(([r, y]) => new Vector2(r, y));
  const barrel = new Mesh(keep(new LatheGeometry(barrelProfile, 96)), gun);
  const knurlGeo = keep(new CylinderGeometry(23.8, 23.8, 11, 180, 1, true));
  { // knurl: alternate the radius of every other column of vertices
    const p = knurlGeo.getAttribute('position');
    for (let v = 0; v < p.count; v++) {
      const k = v % 181;
      const s = k % 2 ? 1 : 0.955;
      p.setXYZ(v, p.getX(v) * s, p.getY(v), p.getZ(v) * s);
    }
    knurlGeo.computeVertexNormals();
  }
  const knurl = new Mesh(knurlGeo, gunDark);
  knurl.position.y = 112;
  const band1 = new Mesh(keep(new CylinderGeometry(22.6, 22.6, 1.2, 96, 1, true)), bright);
  band1.position.y = 131;
  const band2 = new Mesh(keep(new CylinderGeometry(22.6, 22.6, 0.8, 96, 1, true)), bright);
  band2.position.y = 100.5;
  const lensMat = keep(envd(new MeshPhysicalMaterial({
    color: '#05080c', metalness: 0, roughness: 0.02, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6,
    transparent: true, opacity: 1,
  }), 1.6));
  const lensRim = addRim(lensMat, LIGHT, 1.8, 4.0);          // the front element's faint cool glint
  const lensGeo = keep(new SphereGeometry(9.6, 64, 16, 0, Math.PI * 2, Math.PI * 0.72, Math.PI * 0.28));
  const lens = new Mesh(lensGeo, lensMat);
  lens.position.y = 74 + 9.6 * Math.cos(Math.PI * 0.28) - 0.2;
  objective.add(barrel, knurl, band1, band2, lens);
  // Directly above the specimen, as on a real stand: from any azimuth (the turntable) it hangs top-centre.
  objective.position.set(0, -20, 0);
  const objectiveMats = [gun, gunDark, bright, lensMat];
  root.add(objective);

  // ── dust (decoration, static): specks on the glass, and a few motes adrift in the air above the dish that the
  //    lens renders as bokeh discs. Never animated; never tissue hues. ──
  const rnd = mulberry32(0x5eed);
  const GLASS = 36, AIR = 30, LOW = 24, DUST = GLASS + AIR + LOW;
  const dPos = new Float32Array(DUST * 3), dSize = new Float32Array(DUST), dGlint = new Float32Array(DUST), dAir = new Float32Array(DUST);
  for (let i = 0; i < GLASS; i++) {
    const a = rnd() * Math.PI * 2;
    const onInsert = i % 4 === 0;
    const r = onInsert ? 116 + rnd() * 12 : 92 + rnd() * 18;
    dPos[3 * i] = Math.cos(a) * r; dPos[3 * i + 1] = onInsert ? -0.8 : 0.12; dPos[3 * i + 2] = Math.sin(a) * r;
    dSize[i] = 0.5 + rnd() * rnd() * 1.6;
    dGlint[i] = 0.12 + Math.pow(rnd(), 3) * 1.4;
  }
  for (let i = GLASS; i < DUST; i++) {
    // high motes sit above the dish wall (no prop in front of a disc to clip it); low ones drift over the agar outside
    // the organism's reach (r ≥ 58), where only the in-focus specimen can pass in front of them
    // (low ones spread by the golden angle, so whatever the azimuth a few hang behind the specimen)
    const low = i >= GLASS + AIR;
    const a = low ? (i - GLASS - AIR) * 2.39996 + rnd() * 0.3 : rnd() * Math.PI * 2;
    const r = low ? 60 + rnd() * 45 : 20 + Math.sqrt(rnd()) * 90;
    const y = low ? 2 + rnd() * 8 : 30 + rnd() * rnd() * 80;
    dPos[3 * i] = Math.cos(a) * r; dPos[3 * i + 1] = y; dPos[3 * i + 2] = Math.sin(a) * r;
    dSize[i] = 0.18 + rnd() * 0.3;
    dGlint[i] = 0.35 + rnd() * 1.1;
    dAir[i] = 1;
  }
  const dustGeo = keep(new BufferGeometry());
  dustGeo.setAttribute('position', new BufferAttribute(dPos, 3));
  dustGeo.setAttribute('aSize', new BufferAttribute(dSize, 1));
  dustGeo.setAttribute('aGlint', new BufferAttribute(dGlint, 1));
  dustGeo.setAttribute('aAir', new BufferAttribute(dAir, 1));
  const dustMat = keep(new ShaderMaterial({
    vertexShader: S.DUST_VERT, fragmentShader: S.DUST_FRAG, transparent: true, depthWrite: false, blending: AdditiveBlending,
    uniforms: { uCol: { value: new Color('#e9eef5') }, uScale: { value: 600 }, uDof: dofUniform || { value: new Vector4() } },
  }));
  const dust = new Points(dustGeo, dustMat);
  dust.renderOrder = 7;
  dust.frustumCulled = false;
  root.add(dust);

  // ── Apart plates: four edge-lit glass plates, each lit at its rim in its family colour ──
  const plates = new Group();
  plates.visible = false;
  const plateDiscGeo = keep(new CylinderGeometry(1, 1, 0.35, 128, 1));
  const plateItems = [];
  for (let k = 0; k < 4; k++) {
    const fam = new Color(TISSUE_HEX[FAMILY_TYPE[k]]);
    const famL = 0.2126 * fam.r + 0.7152 * fam.g + 0.0722 * fam.b;
    const famLit = fam.clone().multiplyScalar(Math.min(1.3, 0.3 / Math.max(famL, 0.05)));   // equal apparent glow
    const glass = keep(new ShaderMaterial({
      vertexShader: S.PLATE_VERT, fragmentShader: S.PLATE_FRAG, transparent: true, depthWrite: false,
      blending: AdditiveBlending, side: DoubleSide,
      uniforms: { uFam: { value: famLit }, uSheen: { value: new Color(LIGHT).multiplyScalar(0.3) }, uA: { value: 0 } },
    }));
    const edgeMat = keep(new MeshBasicMaterial({ color: fam.clone().multiplyScalar(1.35), transparent: true, opacity: 1 }));
    const disc = new Mesh(plateDiscGeo, glass);
    disc.renderOrder = 8;
    const edge = new Mesh(new TorusGeometry(1, 0.2, 8, 192), edgeMat);
    edge.rotation.x = Math.PI / 2;
    const g = new Group();
    g.add(disc, edge);
    plates.add(g);
    plateItems.push({ group: g, disc, edge, glass, edgeMat, builtR: 1 });
  }
  root.add(plates);

  // ── environment (props only): a black room with the illuminator ring below, the warm key's softbox and a
  //    cool card behind (the rim) ──
  const pmrem = new PMREMGenerator(renderer);
  const env = new Scene();
  const envTmp = [];
  const envMesh = (geo, colour, mul) => {
    const m = new MeshBasicMaterial({ color: new Color(colour).multiplyScalar(mul), side: DoubleSide });
    envTmp.push(m, geo);
    const mesh = new Mesh(geo, m);
    env.add(mesh);
    return mesh;
  };
  const eRing = envMesh(new TorusGeometry(160, 7, 12, 128), '#d9e6ff', 7);
  eRing.rotation.x = Math.PI / 2; eRing.position.y = -60;
  const eKey = envMesh(new PlaneGeometry(300, 200), KEY, 2.4);
  eKey.position.set(-300, 230, 120); eKey.lookAt(0, 0, 0);
  const eBack = envMesh(new PlaneGeometry(360, 120), LIGHT, 0.9);
  eBack.position.set(60, 90, -340); eBack.lookAt(0, 0, 0);
  const eTop = envMesh(new CircleGeometry(220, 48), '#9fb0c8', 0.1);
  eTop.position.set(0, 420, 0); eTop.lookAt(0, 0, 0);
  const envRT = pmrem.fromScene(env, 0.035, 1, 2000);
  for (const x of envTmp) x.dispose();
  pmrem.dispose();
  for (const [m, k] of envMats) { m.envMap = envRT.texture; m.envMapIntensity = k; }

  // ── lights. The stage re-aims them every frame from the camera's azimuth, like studio lights over a turntable:
  //    a warm key high on the camera's left (it casts the shadows), and a dim cool fill low on the right. The
  //    darkfield back light is analytic (cells.js), always behind the specimen as seen from the camera. ──
  const key = new DirectionalLight(KEY, 4.6);
  key.castShadow = true;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.3;
  key.shadow.radius = 3.5;
  const fill = new DirectionalLight('#a9bcff', 0.12);
  root.add(key, key.target, fill, fill.target);
  const KEY_REL = { az: -72 * Math.PI / 180, el: 24 * Math.PI / 180 };     // relative to the camera azimuth: a raking key
  const FILL_REL = { az: 70 * Math.PI / 180, el: 14 * Math.PI / 180 };
  const BACK_REL = { az: 150 * Math.PI / 180, el: 18 * Math.PI / 180 };
  const keyDir = new Vector3(), backDir = new Vector3(), fillDir = new Vector3();
  const dirOf = (out, az, el) => out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));

  return {
    root, agar, agarUniforms: AU, dish, dishRim, lensRim, objective, plates, key, fill, voidMat, dust, dustMat, lip,
    envTexture: envRT.texture, keyDir, backDir, rel: { key: KEY_REL, fill: FILL_REL, back: BACK_REL },

    setShadowSize(size) {
      key.castShadow = size > 0;
      if (size > 0 && key.shadow.mapSize.x !== size) {
        key.shadow.mapSize.set(size, size);
        if (key.shadow.map) { key.shadow.map.depthTexture?.dispose(); key.shadow.map.dispose(); key.shadow.map = null; }
      }
    },

    /** Aim the lights for the camera azimuth `az`, and fit the key's shadow frustum around (cx, cz) radius R
     *  up to height `top`. Returns true when the key moved (the shadow map must be redrawn). */
    aimLights(az, cx, cz, R, top) {
      dirOf(keyDir, az + KEY_REL.az, KEY_REL.el);
      dirOf(backDir, az + BACK_REL.az, BACK_REL.el);
      dirOf(fillDir, az + FILL_REL.az, FILL_REL.el);
      const D = 300;
      const moved = Math.abs(key.position.x - (cx + keyDir.x * D)) + Math.abs(key.position.z - (cz + keyDir.z * D)) > 0.05
        || Math.abs(key.shadow.camera.right - R) > 0.5;
      key.position.set(cx + keyDir.x * D, keyDir.y * D, cz + keyDir.z * D);
      key.target.position.set(cx, 0, cz);
      fill.position.set(cx + fillDir.x * D, fillDir.y * D, cz + fillDir.z * D);
      fill.target.position.set(cx, 0, cz);
      const sc = key.shadow.camera;
      if (moved) {
        sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R;
        sc.near = D - R - top - 20; sc.far = D + R + 40;
        sc.updateProjectionMatrix();
      }
      key.updateMatrixWorld(); key.target.updateMatrixWorld(); fill.target.updateMatrixWorld();
      return moved;
    },

    /** Objective fades out when the camera looks steeply down or in Apart (it would cut through the stack). */
    setObjectiveFade(a) {
      objective.visible = a > 0.01;
      for (const m of objectiveMats) { m.opacity = a; m.depthWrite = a > 0.99; }
    },

    /** Place and fade the Apart plates. y[k] = plate floor, r = plate radius, a = 0..1 visibility. */
    setPlates(y, r, a, cx, cz) {
      plates.visible = a > 0.005;
      if (!plates.visible) return;
      for (let k = 0; k < 4; k++) {
        const it = plateItems[k];
        it.group.position.set(cx, y[k] - 0.18, cz);
        it.disc.scale.set(r, 1, r);
        if (Math.abs(it.builtR - r) > 1.5) {         // rebuild the ring so its tube stays thin
          it.edge.geometry.dispose();
          it.edge.geometry = new TorusGeometry(r, 0.22, 8, 192);
          it.builtR = r;
        }
        // in between, scale the ring in its plane: it follows the disc every frame instead of jumping at a rebuild
        const s = r / it.builtR;
        it.edge.scale.set(s, s, 1);
        it.glass.uniforms.uA.value = a;
        it.edgeMat.opacity = a;
      }
    },

    /** Per render: void aspect, haze position, dust point scale (drawing-buffer px per world unit at distance 1). */
    update(camera, bufferHeight, hazeX, hazeY) {
      voidMat.uniforms.uAspect.value = camera.aspect;
      voidMat.uniforms.uHaze.value.x = hazeX;
      voidMat.uniforms.uHaze.value.y = hazeY;
      dustMat.uniforms.uScale.value = bufferHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    },

    dispose() {
      for (const d of disposables) d.dispose?.();
      for (const it of plateItems) it.edge.geometry.dispose();
      envRT.dispose();
      key.shadow.map?.depthTexture?.dispose();
      key.shadow.dispose();
    },
  };
}
