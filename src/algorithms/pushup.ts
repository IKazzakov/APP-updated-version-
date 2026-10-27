import {
  BODYWEIGHT_RULES,
  BodySmoother,
  bodyweightFeatures,
  validBody,
  type BodyFeatures,
  type BodySide,
  type BodyweightView,
} from './bodyweight.ts';

/**
 * Side-view push-ups: straight-body top → elbow flexion + shoulder descent → top.
 * All thresholds are new exercise heuristics; squat-v1 is unchanged.
 * Degrees: top >=155, descent <135, bottom <=95. Normalized shoulder descent
 * >=0.18 arm lengths and recovery <=0.12 reject elbow-only gestures.
 */
export const PUSHUP_RULES = Object.freeze({
  topAngle: 155,
  descendAngle: 135,
  bottomAngle: 95,
  bottomDrop: 0.18,
  returnDrop: 0.12,
  baselineMs: 450,
  bottomMs: 100,
  returnMs: 120,
  minCycleMs: 700,
  maxCycleMs: 15_000,
  smoothMs: 60,
});

export const pushupFeatures = bodyweightFeatures;

export class PushupCounter {
  phase: 'baseline' | 'top' | 'descending' | 'bottom' = 'baseline';
  side: BodySide | null = null;
  reason = 'Займите упор на прямых руках';
  private last: number | null = null;
  private candidate: number | null = null;
  private baselineAt: number | null = null;
  private baseHeight: number | null = null;
  private downAt: number | null = null;
  private bottomAt: number | null = null;
  private returnAt: number | null = null;
  private readonly elbow = new BodySmoother(PUSHUP_RULES.smoothMs);
  private readonly shoulder = new BodySmoother(PUSHUP_RULES.smoothMs);

  reset(reason = 'Займите упор на прямых руках') {
    this.phase = 'baseline';
    this.side = null;
    this.reason = reason;
    this.last = null;
    this.candidate = null;
    this.baselineAt = null;
    this.baseHeight = null;
    this.downAt = null;
    this.bottomAt = null;
    this.returnAt = null;
    this.elbow.reset();
    this.shoulder.reset();
  }
  private view(tracking: boolean, increment = 0): BodyweightView {
    return {
      phase: this.phase,
      reason: this.reason,
      ready: this.phase !== 'baseline',
      tracking,
      hint:
        this.phase === 'baseline'
          ? 'Займите упор на прямых руках'
          : this.phase === 'top'
            ? 'Опускайте грудь'
            : this.phase === 'bottom'
              ? 'Выпрямите руки'
              : 'Опуститесь ниже, сохраняя прямой корпус',
      increment,
      incrementMs: 0,
    };
  }
  update(features: BodyFeatures | null | undefined, time: number): BodyweightView {
    if (!validBody(features) || !Number.isFinite(time)) {
      this.reset(features?.valid === false ? features.reason : 'Выровняйте корпус в упоре лёжа');
      return this.view(false);
    }
    if (
      (this.last !== null && (time <= this.last || time - this.last > BODYWEIGHT_RULES.maxGapMs)) ||
      (this.side !== null && features.side !== this.side)
    )
      this.reset('Подтвердите упор на прямых руках');
    this.side = features.side;
    this.last = time;
    const elbow = this.elbow.next(features.angle, time);
    const height = this.shoulder.next(features.height, time);
    if (this.phase === 'baseline') {
      const top = elbow >= PUSHUP_RULES.topAngle;
      if (!top || this.candidate === null || Math.abs(height - this.candidate) > 0.08) {
        this.baselineAt = null;
        this.candidate = top ? height : null;
      }
      if (top) {
        this.baselineAt ??= time;
        if (time - this.baselineAt >= PUSHUP_RULES.baselineMs) {
          this.baseHeight = height;
          this.phase = 'top';
          this.reason = 'Исходное положение подтверждено';
        }
      }
      return this.view(true);
    }
    if (this.downAt !== null && time - this.downAt > PUSHUP_RULES.maxCycleMs) {
      this.reset('Движение слишком долгое: выпрямите руки');
      return this.view(true);
    }
    const drop = this.baseHeight! - height;
    if (this.phase === 'top' && elbow < PUSHUP_RULES.descendAngle) {
      this.phase = 'descending';
      this.downAt = time;
      this.reason = 'Опускание';
    }
    if (this.phase === 'descending') {
      if (elbow <= PUSHUP_RULES.bottomAngle && drop >= PUSHUP_RULES.bottomDrop) {
        this.bottomAt ??= time;
        if (time - this.bottomAt >= PUSHUP_RULES.bottomMs) {
          this.phase = 'bottom';
          this.reason = 'Нижнее положение подтверждено';
        }
      } else {
        this.bottomAt = null;
        if (elbow >= PUSHUP_RULES.topAngle && drop < PUSHUP_RULES.returnDrop) {
          this.phase = 'top';
          this.downAt = null;
          this.reason = 'Неполное движение';
        }
      }
    }
    let increment = 0;
    if (this.phase === 'bottom') {
      if (elbow >= PUSHUP_RULES.topAngle && drop < PUSHUP_RULES.returnDrop) {
        this.returnAt ??= time;
        if (time - this.returnAt >= PUSHUP_RULES.returnMs) {
          if (time - this.downAt! >= PUSHUP_RULES.minCycleMs) {
            increment = 1;
            this.reason = 'Повторение засчитано';
          } else this.reason = 'Слишком быстрое движение';
          this.phase = 'top';
          this.downAt = null;
          this.bottomAt = null;
          this.returnAt = null;
        }
      } else this.returnAt = null;
    }
    return this.view(true, increment);
  }
}
