import type { TrainingMode, Repetition, Round, RoundResult } from './shared/contracts/api.ts';
export interface TrainingState {
  cameraOn: boolean;
  starting: boolean;
  modelStatus: string;
  cameraStatus: string;
  hint: string;
  reason: string;
  ready: boolean;
  poseReady: boolean;
  poseTimestamp: number | null;
  count: number;
  paused: boolean;
  phase: string;
  mode: TrainingMode;
  roundStatus: string;
  timerMs: number;
  fps: number;
  inferenceMs: number;
  resolution: string;
  facing: string;
  overlayVisible: boolean;
}
export class Training {
  constructor(
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    callbacks: {
      onChange: (state: TrainingState) => void;
      onRepetition: (event: Omit<Repetition, 'id'>) => void;
      onError: (error: Error) => void;
      onRoundEnd: (result: RoundResult) => void;
    },
  );
  readonly state: TrainingState;
  mode: TrainingMode;
  roundStatus: string;
  clock: { id: string | null };
  stopCamera(reason?: string): void;
  startPractice(): Promise<boolean>;
  prepareRound(mode: TrainingMode): Promise<boolean>;
  captureStartPermit(): unknown;
  beginRound(round: Round & { serverNow: number }, permit: unknown): boolean;
  pause(): void;
  resume(): void;
  reset(): void;
  switchCamera(): Promise<boolean>;
  abortRound(reason: string): void;
  setOverlay(value: boolean): void;
  destroy(): void;
}
