/** Program/activity wire types. Numeric timestamps are Unix milliseconds. */
export type ExerciseId = 'squat' | 'pushup' | 'plank';
export interface WorkoutStep {
  exercise: ExerciseId;
  target: number;
  unit: 'reps' | 'ms';
}
export interface WorkoutProgram {
  id: string;
  version: 1;
  title: string;
  rounds: number;
  restMs: number;
  steps: readonly WorkoutStep[];
}
export interface WorkoutIdentity {
  id: string;
  programId: string;
  startedAt: number;
}
export interface WorkoutEvent {
  id: string;
  stepIndex: number;
  /** Start of a hold interval; instant for a repetition. */
  occurredAt: number;
  /** Holds only, 1..1000ms. Repetitions always represent one full movement. */
  durationMs?: number;
}
export interface WorkoutSyncInput {
  workout: WorkoutIdentity;
  events: WorkoutEvent[];
}
export interface WorkoutEndInput {
  endedAt: number;
  /** Exercise + rest time, excluding explicit pauses. */
  activeMs: number;
}
export interface WorkoutView {
  id: string;
  programId: string;
  programVersion: 1;
  rulesVersion: 'workout-v1';
  startedAt: number;
  finishedAt: number | null;
  status: 'active' | 'completed' | 'aborted';
  /** Repetitions or milliseconds, in expanded program order. */
  stepProgress: number[];
  activeMs: number;
}
export interface ActivityProgress {
  rulesVersion: 'activity-v1';
  activatedAt: number;
  version: number;
  totalXp: number;
  level: number;
  xpInLevel: number;
  xpForNextLevel: 100;
  today: {
    date: string;
    squats: number;
    pushups: number;
    plankMs: number;
    units: number;
    xp: number;
    goal: 10;
    completed: boolean;
  };
  streak: { current: number; best: number };
  serverNow: number;
}
export interface WorkoutCatalogReply {
  programs: WorkoutProgram[];
  rulesVersion: 'workout-v1';
  serverNow: number;
}
export interface WorkoutSyncReply {
  accepted: number;
  duplicate: number;
  workout: WorkoutView;
  progress: ActivityProgress;
}
export interface WorkoutEndReply {
  workout: WorkoutView;
  progress: ActivityProgress;
}
export interface WorkoutHistoryReply {
  items: WorkoutView[];
  nextCursor: string | null;
  limit: number;
  serverNow: number;
}
