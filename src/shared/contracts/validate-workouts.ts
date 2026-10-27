import type {
  ActivityProgress,
  WorkoutCatalogReply,
  WorkoutEndReply,
  WorkoutHistoryReply,
  WorkoutProgram,
  WorkoutSyncReply,
  WorkoutView,
} from './workouts.ts';
import { findWorkoutProgram, expandWorkoutSteps } from '../workouts/catalog.ts';

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const string = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const list = (v: unknown, check: (item: unknown) => boolean): v is unknown[] =>
  Array.isArray(v) && v.every(check);
function program(v: unknown): v is WorkoutProgram {
  return (
    object(v) &&
    string(v.id) &&
    v.version === 1 &&
    string(v.title) &&
    integer(v.rounds) &&
    v.rounds >= 1 &&
    v.rounds <= 10 &&
    integer(v.restMs) &&
    v.restMs <= 300000 &&
    list(
      v.steps,
      (step) =>
        object(step) &&
        integer(step.target) &&
        step.target > 0 &&
        step.target <= (step.unit === 'ms' ? 3600000 : 1000) &&
        ((step.exercise === 'plank' && step.unit === 'ms') ||
          ((step.exercise === 'squat' || step.exercise === 'pushup') && step.unit === 'reps')),
    ) &&
    v.steps.length > 0 &&
    v.steps.length <= 12
  );
}
export function isWorkoutView(v: unknown): v is WorkoutView {
  if (
    !object(v) ||
    !string(v.id) ||
    !string(v.programId) ||
    v.programVersion !== 1 ||
    v.rulesVersion !== 'workout-v1' ||
    !integer(v.startedAt) ||
    !integer(v.activeMs) ||
    !list(v.stepProgress, integer) ||
    v.stepProgress.length === 0 ||
    !['active', 'completed', 'aborted'].includes(String(v.status))
  )
    return false;
  const template = findWorkoutProgram(v.programId);
  if (!template || v.activeMs > 86400000) return false;
  const steps = expandWorkoutSteps(template);
  if (
    v.stepProgress.length !== steps.length ||
    v.stepProgress.some((progress, index) => (progress as number) > steps[index]!.target)
  )
    return false;
  if (
    v.status === 'completed' &&
    v.stepProgress.some((progress, index) => progress !== steps[index]!.target)
  )
    return false;
  if (v.status === 'active') return v.finishedAt === null;
  return (
    integer(v.finishedAt) &&
    v.finishedAt >= v.startedAt &&
    v.finishedAt - v.startedAt <= 86400000 &&
    v.activeMs <= v.finishedAt - v.startedAt
  );
}
export function isActivityProgress(v: unknown): v is ActivityProgress {
  if (
    !object(v) ||
    v.rulesVersion !== 'activity-v1' ||
    !integer(v.activatedAt) ||
    !integer(v.version) ||
    !integer(v.totalXp) ||
    !integer(v.level) ||
    v.level < 1 ||
    !integer(v.xpInLevel) ||
    v.xpInLevel >= 100 ||
    v.xpForNextLevel !== 100 ||
    v.level !== 1 + Math.floor(v.totalXp / 100) ||
    v.xpInLevel !== v.totalXp % 100 ||
    !integer(v.serverNow) ||
    !object(v.today) ||
    !object(v.streak)
  )
    return false;
  const today = v.today;
  return (
    date(today.date) &&
    integer(today.squats) &&
    integer(today.pushups) &&
    integer(today.plankMs) &&
    integer(today.units) &&
    today.units === today.squats + today.pushups + Math.floor(today.plankMs / 5000) &&
    integer(today.xp) &&
    today.xp <= 300 &&
    today.xp <= today.units &&
    today.goal === 10 &&
    today.completed === today.units >= 10 &&
    integer(v.streak.current) &&
    integer(v.streak.best) &&
    v.streak.best >= v.streak.current
  );
}
function required<T>(value: unknown, check: (v: unknown) => boolean): T {
  if (!check(value)) throw new Error('API_RESPONSE_INVALID');
  return value as T;
}
export const parseActivity = (value: unknown): ActivityProgress =>
  required(value, isActivityProgress);
export const parseWorkoutCatalog = (value: unknown): WorkoutCatalogReply =>
  required(
    value,
    (v) =>
      object(v) &&
      v.rulesVersion === 'workout-v1' &&
      integer(v.serverNow) &&
      list(v.programs, program),
  );
export const parseWorkoutSync = (value: unknown): WorkoutSyncReply =>
  required(
    value,
    (v) =>
      object(v) &&
      integer(v.accepted) &&
      integer(v.duplicate) &&
      isWorkoutView(v.workout) &&
      isActivityProgress(v.progress),
  );
export const parseWorkoutEnd = (value: unknown): WorkoutEndReply =>
  required(value, (v) => object(v) && isWorkoutView(v.workout) && isActivityProgress(v.progress));
export const parseWorkoutPage = (value: unknown): WorkoutHistoryReply =>
  required(
    value,
    (v) =>
      object(v) &&
      integer(v.serverNow) &&
      integer(v.limit) &&
      v.limit >= 1 &&
      v.limit <= 100 &&
      (v.nextCursor === null || string(v.nextCursor)) &&
      list(v.items, (item) => isWorkoutView(item) && item.status !== 'active'),
  );
export function parseWorkoutReply(path: string, value: unknown) {
  const route = path
    .replace(/^\/?api\//, '')
    .replace(/^v2\//, '')
    .split('?')[0];
  if (route === 'activity') return parseActivity(value);
  if (route === 'workouts/catalog') return parseWorkoutCatalog(value);
  if (route === 'workouts/sync') return parseWorkoutSync(value);
  if (route === 'workouts/history') return parseWorkoutPage(value);
  if (/^workouts\/[^/]+\/(finish|abort)$/.test(route)) return parseWorkoutEnd(value);
  throw new Error('API_RESPONSE_INVALID');
}
