export class RoundSound {
  constructor(options: { onChange: (message: string) => void });
  enabled: boolean;
  context: AudioContext | null;
  unlock(): Promise<boolean>;
  setEnabled(value: boolean): void;
  stop(): void;
  play(kind: string): boolean;
}
