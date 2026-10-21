export const VERSION = '1.4.1';
export const VISION_VERSION = '0.10.32';
export const MODELS = {
  full: {name: 'Pose Landmarker Full', file: 'pose_landmarker_full.task'},
  lite: {name: 'Pose Landmarker Lite', file: 'pose_landmarker_lite.task'},
  hands: {name: 'Hand Landmarker · 2 кисти', file: 'hand_landmarker.task'},
};
// All durations use milliseconds, never frame counts. Distinct entry/exit
// thresholds give hysteresis. These are movement heuristics, not medical advice.
export const SQUAT = {
  standAngle: 160, descendAngle: 145, bottomAngle: 108,
  // Hip-to-ankle vertical height / standing leg length. A bend at the waist
  // keeps the legs straight and cannot satisfy BOTH knee and hip conditions.
  bottomDrop: 0.16, returnDrop: 0.09,
  baselineMs: 650, bottomMs: 90, returnMs: 120, minCycleMs: 650,
  maxCycleMs: 15000, maxGapMs: 400, smoothMs: 65, visibility: 0.6,
};
export const CLAP = {
  // Distance uses a median palm scale captured ONLY while stably open.
  // Both this scale and the open distance stay fixed throughout a cycle.
  close: 1.9, closeFraction: 0.75, minContraction: 0.7,
  open: 2.6, approachDrop: 0.3, baselineMs: 350, baselineJitter: 0.25,
  // In a hybrid stream, valid neural anchors can have missing optical frames
  // between them. Preserve preparation evidence briefly, never invent motion.
  baselineGapMs: 200,
  stableSpeed: 0.2,
  // After tracking loss, confirm a NEW open pose using current palm sizes.
  // Unlike first-session calibration this permits two moving observations.
  reacquireMs: 25, reacquireWindowMs: 220, reacquireScaleChange: 0.22,
  // No endpoint dwell: an observed close followed by a substantial outward
  // stroke completes the cycle. Initial arm spread is NOT a required endpoint.
  // 0.7 palm units is much larger than the direction/noise band (0.2).
  directionRise: 0.2, reopenRise: 0.55, maxReopenRise: 0.8,
  reopenFraction: 0.4, minReopenRatio: 1.2,
  // Partial-cycle duration differs from the interval between completed cycles.
  // These permit continuous 4 Hz motion, while rejecting tiny rapid bounces.
  minCycleMs: 70, minRepeatMs: 100, maxCycleMs: 10000,
  // Short gaps freeze evidence in every armed phase. They NEVER create a
  // minimum/contact. After recovery, continuity and actual close data are needed.
  // Five intervals allow four missing observations plus the recovery frame;
  // measured re-detection can take ~500 ms at 10 fps. The hard cap is 600 ms.
  gapMinMs: 250, gapMaxMs: 600, gapFrames: 5, gapPaddingMs: 80,
  // Once rhythm is known, do not bridge a gap covering most of a clap cycle.
  gapPeriodFraction: 0.65, rhythmGapMinMs: 380,
  maxGapMs: 600, smoothMs: 12,
  maxPalmSpeed: 28, positionSlack: 0.75, maxReturnExpansion: 1.8,
  attemptLimit: 12, attemptEventLimit: 16,
};
export const HAND_INPUT_MAX_EDGE = 960;
export const MOTION = {
  maxEdge: 320, minEdge: 256, maxFps: 60,
  // Real image correspondences may bridge missed neural detections, but never
  // an unseen motion: old anchors and large frame gaps invalidate the tracker.
  maxAnchorMs: 800, maxFrameGapMs: 105, historyMs: 350,
  minPoints: 4, maxPoints: 16, maxResidual: 22, maxBackwardError: 1.4,
};
export const HAND_BACKEND = {
  warmupFrames: 2, sampleFrames: 6, gpuAdvantage: 0.9,
  // Stop a clearly slow software GPU after two observations, instead of
  // spending seconds on a benchmark that cannot improve camera throughput.
  slowGpuMs: 100, slowGpuFactor: 3,
};
export const SETTLE_MS = 2000;
