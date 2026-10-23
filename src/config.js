export const VERSION = '2.5.4';
export const VISION_VERSION = '0.10.32';
export const RULES_VERSION = 'squat-v1';
export const MODELS = Object.freeze({
  full: Object.freeze({name: 'Pose Landmarker Full', file: 'pose_landmarker_full.task'}),
});
// Published squat-v1 rules: all modes use the same Full model and thresholds.
// Durations are milliseconds, not frame counts. Entry/exit thresholds provide
// hysteresis. The original tested squat thresholds are deliberately unchanged.
export const SQUAT = Object.freeze({
  standAngle: 160, descendAngle: 145, bottomAngle: 108,
  // BOTH knee flexion and a hip drop relative to leg length are required:
  // bending at the waist while keeping the knees straight cannot score.
  bottomDrop: 0.16, returnDrop: 0.09,
  baselineMs: 650, bottomMs: 90, returnMs: 120, minCycleMs: 650,
  maxCycleMs: 15000, maxGapMs: 400, smoothMs: 65, visibility: 0.6,
});
export const SETTLE_MS = 2000;
export const ROUND_MS = 60000;
