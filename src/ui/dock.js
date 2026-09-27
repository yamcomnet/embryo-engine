// src/ui/dock.js — the scene dock's model (DOM-free, so node tests can reach it).
//
// The dock floats over the 3D view and holds the scene controls: Apart (X), the camera presets (C), the turntable
// Orbit (O) and, only while the user has taken the camera, Frame (F). The HUD renders it from dockModel(state);
// main uses orbitTurning(state) to drive the stage, so the button's "idle" look and the stage cannot disagree.

import { CAMERA_PRESETS } from '../shared.js';

/** Is the turntable actually turning? Only while the run plays, auto-framing, live, without reduced motion, and not
 *  in the Map view (a top-down map has nothing to orbit). */
export function orbitTurning(s) {
  return !!(s && s.turntable && s.running && s.autoFrame !== false && !s.viewing && !s.reducedMotion && s.camera !== 'map');
}

/** Why a turntable that is on is not turning now ('' when it turns, or when it is off). Worded for the button's
 *  description and tooltip: names no keys (a touch device has none). */
export function orbitIdleReason(s) {
  if (!s || !s.turntable || orbitTurning(s)) return '';
  if (s.reducedMotion) return 'Held still by reduced motion';
  if (s.camera === 'map') return 'Not in the Map view';
  if (s.autoFrame === false) return 'Resumes when you press Frame';
  if (s.viewing) return 'Turns again back at live';
  return 'Turns while the run plays';
}

/** What the dock shows for an AppState. */
export function dockModel(s = {}) {
  const orbit = !!s.turntable;
  return {
    apart: !!s.exploded,
    camera: CAMERA_PRESETS.includes(s.camera) ? s.camera : CAMERA_PRESETS[0],
    orbit,
    orbitIdle: orbit && !orbitTurning(s),
    orbitNote: orbitIdleReason(s),
    frame: s.autoFrame === false,          // the Frame button shows only once the user has moved the camera
  };
}

/** The one-time "Try Apart" nudge: once the Four layers milestone has been reached live, while nothing else has the
 *  viewer's attention (a snapshot, a fast-forward, the guide), and only if Apart has never been used here. */
export function apartHintDue(s = {}, seen = false) {
  if (seen || !s.ready || !s.stageReady || s.error || s.exploded) return false;
  if (s.viewing || s.progress || s.helpOpen) return false;
  const m = (s.milestones || []).find((x) => x.key === 'layers');
  return !!m && typeof m.tick === 'number';
}
