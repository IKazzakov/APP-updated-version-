import {
  BODYWEIGHT_RULES,
  bodyweightFeatures,
  validBody,
  type BodyFeatures,
  type BodySide,
  type BodyweightView,
} from './bodyweight.ts';

/**
 * Accumulated valid plank time. A stable 400ms entry arms tracking; only elapsed
 * time between subsequent valid frames (gap <=300ms) is returned for saving.
 * The caller owns the durable total, so reset/pause never erases saved seconds.
 * Forearm and straight-arm support use the same straight-body geometry.
 */
export const PLANK_RULES = Object.freeze({ baselineMs: 400 });
export const plankFeatures = bodyweightFeatures;

export class PlankCounter {
  phase: 'baseline' | 'holding' = 'baseline';
  side: BodySide | null = null;
  reason = 'Займите положение планки';
  private last: number | null = null;
  private baselineAt: number | null = null;

  reset(reason = 'Займите положение планки') {
    this.phase = 'baseline';
    this.side = null;
    this.reason = reason;
    this.last = null;
    this.baselineAt = null;
  }
  private view(tracking: boolean, incrementMs = 0): BodyweightView {
    return {
      phase: this.phase,
      ready: this.phase === 'holding',
      tracking,
      hint: this.phase === 'holding' ? 'Удерживайте прямой корпус' : 'Займите положение планки',
      reason: this.reason,
      increment: 0,
      incrementMs,
    };
  }
  update(features: BodyFeatures | null | undefined, time: number): BodyweightView {
    if (!validBody(features) || !Number.isFinite(time)) {
      this.reset(features?.valid === false ? features.reason : 'Выровняйте корпус в планке');
      return this.view(false);
    }
    if (
      (this.last !== null && (time <= this.last || time - this.last > BODYWEIGHT_RULES.maxGapMs)) ||
      (this.side !== null && features.side !== this.side)
    )
      this.reset('Подтвердите положение планки');
    this.side = features.side;
    const elapsed = this.last === null ? 0 : time - this.last;
    this.last = time;
    if (this.phase === 'baseline') {
      this.baselineAt ??= time;
      if (time - this.baselineAt >= PLANK_RULES.baselineMs) {
        this.phase = 'holding';
        this.reason = 'Положение подтверждено';
      }
      return this.view(true);
    }
    this.reason = 'Корректное удержание';
    return this.view(true, elapsed);
  }
}
