// The phone and server share this immutable version identifier. A rule change
// requires a new identifier; results from different versions are not comparable.
export const RULES_VERSION = 'squat-v1';
export const ROUND_MS = 60_000;
export const DELIVERY_GRACE_MS = 15_000;
export const DAILY_GOAL = 10;
export const DAILY_POINTS = 10;
export const COMPETITION_MS = 24 * 60 * 60 * 1000;
export const ATTEMPT_LIMIT = 3;
export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
