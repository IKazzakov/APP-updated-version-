import type { ApiRequest, Snapshot, Repetition } from './shared/contracts/api.ts';
export interface SyncStatus {
  pending: number | null;
  saving: boolean;
  error: string | null;
  code?: string | null;
  blocked?: number;
  state?: Snapshot | null;
}
export class Outbox {
  constructor(
    owner: string,
    options: { api: ApiRequest; flushDelayMs?: number; onStatus: (status: SyncStatus) => void },
  );
  init(): Promise<void>;
  add(event: Repetition): Promise<void>;
  flush(options?: { retryFailed?: boolean }): Promise<Snapshot | null>;
  count(): Promise<number>;
  close(): void;
}
