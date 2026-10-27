import type { WorkoutProgram, WorkoutStep } from '../contracts/workouts.ts';

export const WORKOUT_RULES_VERSION = 'workout-v1' as const;
export const ACTIVITY_RULES_VERSION = 'activity-v1' as const;
export const WORKOUT_PROGRAMS: readonly WorkoutProgram[] = Object.freeze([
  {
    id: 'squats-5-v1',
    version: 1,
    title: '5 приседаний',
    rounds: 1,
    restMs: 10000,
    steps: [{ exercise: 'squat', target: 5, unit: 'reps' }],
  },
  {
    id: 'pushups-5-v1',
    version: 1,
    title: '5 отжиманий',
    rounds: 1,
    restMs: 10000,
    steps: [{ exercise: 'pushup', target: 5, unit: 'reps' }],
  },
  {
    id: 'plank-15-v1',
    version: 1,
    title: 'Планка 15 секунд',
    rounds: 1,
    restMs: 10000,
    steps: [{ exercise: 'plank', target: 15000, unit: 'ms' }],
  },
  {
    id: 'starter-circuit-v1',
    version: 1,
    title: 'Первый круг',
    rounds: 1,
    restMs: 10000,
    steps: [
      { exercise: 'pushup', target: 5, unit: 'reps' },
      { exercise: 'squat', target: 5, unit: 'reps' },
      { exercise: 'plank', target: 15000, unit: 'ms' },
    ],
  },
]);

export function findWorkoutProgram(id: string): WorkoutProgram | undefined {
  return WORKOUT_PROGRAMS.find((program) => program.id === id);
}
export function expandWorkoutSteps(program: WorkoutProgram): WorkoutStep[] {
  return Array.from({ length: program.rounds }, () => program.steps)
    .flat()
    .map((step) => ({ ...step }));
}
