/** Durable journal for one workout, partitioned by API base and profile owner. */
export interface WorkoutEvent {
  id: string;
  stepIndex: number;
  occurredAt: number;
  durationMs?: number;
}

export interface StoredWorkout {
  /** Local optimistic revision; never sent over HTTP. */
  storageRevision?: number;
  workout: { id: string; programId: string; startedAt: number };
  stepProgress: number[];
  events: WorkoutEvent[];
  pendingEnd?: { action: 'finish' | 'abort'; endedAt: number; activeMs: number };
  activeMs: number;
  status: 'active' | 'completed' | 'aborted';
  synced: boolean;
}

export class WorkoutStorageError extends Error {
  readonly code: string = 'LOCAL_STORAGE';
  constructor() {
    super('Не удалось надёжно сохранить тренировку на устройстве. Учёт остановлен.');
    this.name = 'WorkoutStorageError';
  }
}
export class WorkoutStorageConflict extends WorkoutStorageError {
  readonly code = 'WORKOUT_STORAGE_CONFLICT';
  constructor() {
    super();
    this.name = 'WorkoutStorageConflict';
    this.message =
      'Тренировка изменена в другой вкладке. Учёт остановлен; продолжите с сохранённого состояния.';
  }
}

const DATABASE = 'movement-workouts-v1';
const STORE = 'sessions';
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Project persisted fields; frames, landmarks and credentials never enter this journal. */
function snapshot(value: unknown): StoredWorkout {
  if (
    !object(value) ||
    !object(value.workout) ||
    !text(value.workout.id) ||
    !text(value.workout.programId) ||
    !integer(value.workout.startedAt) ||
    !Array.isArray(value.stepProgress) ||
    value.stepProgress.length === 0 ||
    !value.stepProgress.every(integer) ||
    !Array.isArray(value.events) ||
    !integer(value.activeMs) ||
    !['active', 'completed', 'aborted'].includes(String(value.status)) ||
    typeof value.synced !== 'boolean' ||
    (value.storageRevision !== undefined && !integer(value.storageRevision))
  )
    throw new WorkoutStorageError();
  const events: WorkoutEvent[] = [],
    ids = new Set<string>();
  for (const event of value.events) {
    if (
      !object(event) ||
      !text(event.id) ||
      ids.has(event.id) ||
      !integer(event.stepIndex) ||
      event.stepIndex >= value.stepProgress.length ||
      !integer(event.occurredAt) ||
      (event.durationMs !== undefined &&
        (!integer(event.durationMs) || event.durationMs < 1 || event.durationMs > 1000))
    )
      throw new WorkoutStorageError();
    ids.add(event.id);
    events.push({
      id: event.id,
      stepIndex: event.stepIndex,
      occurredAt: event.occurredAt,
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    });
  }
  let pendingEnd: StoredWorkout['pendingEnd'];
  if (value.pendingEnd !== undefined) {
    const end = value.pendingEnd;
    if (
      !object(end) ||
      !['finish', 'abort'].includes(String(end.action)) ||
      !integer(end.endedAt) ||
      !integer(end.activeMs)
    )
      throw new WorkoutStorageError();
    pendingEnd = {
      action: end.action as 'finish' | 'abort',
      endedAt: end.endedAt,
      activeMs: end.activeMs,
    };
  }
  return {
    ...(value.storageRevision === undefined
      ? {}
      : { storageRevision: value.storageRevision as number }),
    workout: {
      id: value.workout.id,
      programId: value.workout.programId,
      startedAt: value.workout.startedAt,
    },
    stepProgress: [...value.stepProgress],
    events,
    ...(pendingEnd ? { pendingEnd } : {}),
    activeMs: value.activeMs,
    status: value.status as StoredWorkout['status'],
    synced: value.synced,
  };
}

export class WorkoutStorage {
  readonly owner: string;
  private readonly factory: IDBFactory | undefined;
  private db: IDBDatabase | null = null;
  private opening: Promise<void> | null = null;
  private closed = false;
  private sequence: Promise<unknown> = Promise.resolve();
  private transactions = new Set<IDBTransaction>();
  private cleared = new Set<string>();
  private loadedRevision: number | null = null;

  constructor(owner: string, factory: IDBFactory | undefined = globalThis.indexedDB) {
    if (!owner) throw new WorkoutStorageError();
    this.owner = owner;
    this.factory = factory;
  }

  async init(): Promise<void> {
    if (this.closed || !this.factory) throw new WorkoutStorageError();
    if (this.db) return;
    if (this.opening) return this.opening;
    const pending = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = () => {
        settled = true;
        reject(new WorkoutStorageError());
      };
      try {
        const request = this.factory!.open(DATABASE, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE))
            request.result.createObjectStore(STORE, { keyPath: 'owner' });
        };
        request.onerror = fail;
        request.onblocked = fail;
        request.onsuccess = () => {
          const db = request.result;
          if (this.closed || settled) {
            db.close();
            fail();
            return;
          }
          settled = true;
          this.db = db;
          db.onversionchange = () => this.close();
          db.onclose = () => {
            if (this.db === db) this.close();
          };
          resolve();
        };
      } catch {
        fail();
      }
    });
    this.opening = pending.finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new WorkoutStorageError());
    const result = this.sequence.then(async () => {
      await this.init();
      if (this.closed) throw new WorkoutStorageError();
      return operation();
    });
    this.sequence = result.catch(() => {});
    return result;
  }

  private transaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore, result: (value: T) => void) => void,
    failure?: () => Error,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let value: T;
      try {
        if (!this.db || this.closed) throw new WorkoutStorageError();
        const tx = this.db.transaction(STORE, mode);
        this.transactions.add(tx);
        const done = () => this.transactions.delete(tx);
        tx.oncomplete = () => {
          done();
          if (this.closed) reject(new WorkoutStorageError());
          else resolve(value);
        };
        tx.onerror = tx.onabort = () => {
          done();
          reject(failure?.() ?? new WorkoutStorageError());
        };
        try {
          operation(tx.objectStore(STORE), (next) => (value = next));
        } catch {
          tx.abort();
        }
      } catch {
        reject(new WorkoutStorageError());
      }
    });
  }

  load(): Promise<StoredWorkout | null> {
    return this.enqueue(async () => {
      const value = await this.transaction<StoredWorkout | null>('readonly', (store, result) => {
        const request = store.get(this.owner);
        request.onsuccess = () => {
          try {
            result(request.result === undefined ? null : snapshot(request.result.record));
          } catch {
            request.transaction?.abort();
          }
        };
      });
      this.loadedRevision = value?.storageRevision ?? (value ? 0 : null);
      return value;
    });
  }

  async save(record: StoredWorkout): Promise<StoredWorkout> {
    // Copy before awaiting: callers may continue mutating their live runner state.
    const copy = snapshot(record);
    return this.enqueue(async () => {
      if (this.cleared.has(copy.workout.id)) throw new WorkoutStorageConflict();
      let conflict = false;
      const saved = await this.transaction<StoredWorkout>(
        'readwrite',
        (store, result) => {
          const request = store.get(this.owner);
          request.onsuccess = () => {
            try {
              const existing =
                request.result === undefined ? null : snapshot(request.result.record);
              if (
                (existing && existing.workout.id !== copy.workout.id) ||
                (existing?.storageRevision ?? 0) !== (copy.storageRevision ?? 0)
              ) {
                conflict = true;
                throw new WorkoutStorageConflict();
              }
              const next = { ...copy, storageRevision: (existing?.storageRevision ?? 0) + 1 };
              store.put({ owner: this.owner, record: next });
              result(next);
            } catch {
              request.transaction?.abort();
            }
          };
        },
        () => (conflict ? new WorkoutStorageConflict() : new WorkoutStorageError()),
      );
      this.loadedRevision = saved.storageRevision!;
      return saved;
    });
  }

  async clear(id: string): Promise<void> {
    if (!id) throw new WorkoutStorageError();
    return this.enqueue(async () => {
      let conflict = false;
      let deleted = false;
      await this.transaction<void>(
        'readwrite',
        (store) => {
          const request = store.get(this.owner);
          request.onsuccess = () => {
            try {
              if (request.result?.record?.workout?.id === id) {
                if ((request.result.record.storageRevision ?? 0) !== this.loadedRevision) {
                  conflict = true;
                  throw new WorkoutStorageConflict();
                }
                store.delete(this.owner);
                deleted = true;
              }
            } catch {
              request.transaction?.abort();
            }
          };
        },
        () => (conflict ? new WorkoutStorageConflict() : new WorkoutStorageError()),
      );
      this.cleared.add(id);
      if (deleted) this.loadedRevision = null;
    });
  }

  close(): void {
    this.closed = true;
    for (const tx of this.transactions) {
      try {
        tx.abort();
      } catch {
        /* A transaction may have committed immediately before close. */
      }
    }
    this.transactions.clear();
    const db = this.db;
    this.db = null;
    db?.close();
  }
}
