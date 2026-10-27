import { angle, distance, pixel } from './geometry.js';

export type BodySide = 'left' | 'right';
export interface PosePoint {
  x: number;
  y: number;
  visibility?: number;
  presence?: number;
}
export interface InvalidBodyFeatures {
  valid: false;
  reason: string;
}
export interface ValidBodyFeatures {
  valid: true;
  side: BodySide;
  /** Elbow flexion angle in degrees, calculated in image pixels. */
  angle: number;
  /** Vertical shoulder-to-wrist distance divided by upper+lower arm length. */
  height: number;
  bodyAngle: number;
  kneeAngle: number;
  horizontal: true;
  aligned: true;
  supported: true;
}
export type BodyFeatures = InvalidBodyFeatures | ValidBodyFeatures;
export interface BodyweightView {
  phase: string;
  ready: boolean;
  tracking: boolean;
  hint: string;
  reason: string;
  increment: number;
  incrementMs: number;
}

/**
 * New side-view bodyweight rules, separate from immutable squat-v1.
 * These are conservative geometric heuristics, not a calibrated form score.
 * Validate framing, thresholds and accessibility on real phones before release.
 */
export const BODYWEIGHT_RULES = Object.freeze({
  visibility: 0.6,
  frameMargin: 0.01,
  minBodySize: 0.3,
  minBodyAngle: 155,
  minKneeAngle: 150,
  maxVerticalRatio: 0.45,
  minSupportDrop: 0.08,
  maxGapMs: 300,
});

const SIDES = [
  { name: 'left', ids: [11, 13, 15, 23, 25, 27] },
  { name: 'right', ids: [12, 14, 16, 24, 26, 28] },
] as const;

/** Select one visible side. A side change must rearm the exercise counter. */
export function bodyweightFeatures(
  points: readonly PosePoint[] | null | undefined,
  width: number,
  height: number,
  preferred?: BodySide | null,
): BodyFeatures {
  if (!points || points.length < 33) return { valid: false, reason: 'Займите положение в кадре' };
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)))
    return { valid: false, reason: 'Не удаётся распознать движение' };
  const confidence = (index: number) => {
    const p = points[index];
    const value = Math.min(p?.visibility ?? 0, p?.presence ?? 1);
    return Number.isFinite(value) ? value : 0;
  };
  const choices = SIDES.map((side) => ({
    ...side,
    score: Math.min(...side.ids.map(confidence)),
  })).sort((a, b) => b.score - a.score);
  const locked = choices.find((side) => side.name === preferred);
  const side = locked && locked.score >= BODYWEIGHT_RULES.visibility ? locked : choices[0]!;
  if (side.score < BODYWEIGHT_RULES.visibility)
    return { valid: false, reason: 'В кадре должны быть плечи, локти, кисти, таз, колени и стопы' };
  const margin = BODYWEIGHT_RULES.frameMargin;
  if (
    side.ids.some((index) => {
      const p = points[index];
      return (
        !p ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < margin ||
        p.x > 1 - margin ||
        p.y < margin ||
        p.y > 1 - margin
      );
    })
  )
    return { valid: false, reason: 'Отойдите дальше: тело и руки должны быть целиком в кадре' };
  const [shoulder, elbow, wrist, hip, knee, ankle] = side.ids.map((index) =>
    pixel(points[index]!, width, height),
  );
  const armLength = distance(shoulder, elbow) + distance(elbow, wrist);
  const bodyLength = distance(shoulder, hip) + distance(hip, knee) + distance(knee, ankle);
  const bodyAngle = angle(shoulder, hip, ankle);
  const kneeAngle = angle(hip, knee, ankle);
  const elbowAngle = angle(shoulder, elbow, wrist);
  if (
    ![armLength, bodyLength, bodyAngle, kneeAngle, elbowAngle].every(Number.isFinite) ||
    armLength <= 1 ||
    bodyLength < Math.min(width, height) * BODYWEIGHT_RULES.minBodySize
  )
    return { valid: false, reason: 'Подойдите ближе: плохо видно положение тела' };
  if (Math.abs(shoulder.y - ankle.y) > bodyLength * BODYWEIGHT_RULES.maxVerticalRatio)
    return { valid: false, reason: 'Займите упор лёжа боком к камере' };
  if (bodyAngle < BODYWEIGHT_RULES.minBodyAngle || kneeAngle < BODYWEIGHT_RULES.minKneeAngle)
    return { valid: false, reason: 'Выровняйте корпус и выпрямите ноги' };
  const normalizedHeight = (wrist.y - shoulder.y) / armLength;
  if (
    normalizedHeight < BODYWEIGHT_RULES.minSupportDrop ||
    Math.abs(wrist.x - shoulder.x) > armLength
  )
    return { valid: false, reason: 'Поставьте руки в упор под плечами' };
  return {
    valid: true,
    side: side.name,
    angle: elbowAngle,
    height: normalizedHeight,
    bodyAngle,
    kneeAngle,
    horizontal: true,
    aligned: true,
    supported: true,
  };
}

export function validBody(
  features: BodyFeatures | null | undefined,
): features is ValidBodyFeatures {
  return (
    features?.valid === true &&
    ['left', 'right'].includes(features.side) &&
    features.horizontal === true &&
    features.aligned === true &&
    features.supported === true &&
    [features.angle, features.height, features.bodyAngle, features.kneeAngle].every(
      Number.isFinite,
    ) &&
    features.height >= BODYWEIGHT_RULES.minSupportDrop &&
    features.bodyAngle >= BODYWEIGHT_RULES.minBodyAngle &&
    features.kneeAngle >= BODYWEIGHT_RULES.minKneeAngle
  );
}

/** Time-based smoothing keeps the same rules independent of inference FPS. */
export class BodySmoother {
  private value: number | null = null;
  private time: number | null = null;
  private readonly tau: number;
  constructor(tau: number) {
    this.tau = tau;
  }
  reset() {
    this.value = null;
    this.time = null;
  }
  next(value: number, time: number) {
    const alpha = this.time === null ? 1 : 1 - Math.exp(-Math.max(0, time - this.time) / this.tau);
    this.value = this.value === null ? value : this.value + alpha * (value - this.value);
    this.time = time;
    return this.value;
  }
}
