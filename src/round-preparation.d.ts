import type { TrainingState } from './training.js';
export type PreparationStatus =
  | 'idle'
  | 'loading'
  | 'waiting'
  | 'countdown'
  | 'starting'
  | 'running'
  | 'completed'
  | 'error';
export class RoundPreparation {
  constructor(options: {
    onChange: (state: { status: PreparationStatus }) => void;
    onSignal: (kind: string) => void;
    onStart: (context: { isCurrent: () => boolean }) => Promise<boolean>;
  });
  status: PreparationStatus;
  readonly pending: boolean;
  generation: number;
  number: number | null;
  arm(): number;
  wait(generation: number): boolean;
  cancel(): void;
  fail(): void;
  complete(): void;
  observe(state: TrainingState): void;
}
