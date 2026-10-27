import { api as defaultTransport, ApiError } from '../api.js';
import { profileStorageId } from '../platform.js';
import {
  expandWorkoutSteps,
  findWorkoutProgram,
  WORKOUT_PROGRAMS,
} from '../shared/workouts/catalog.ts';
import {
  parseActivity,
  parseWorkoutCatalog,
  parseWorkoutSync,
  parseWorkoutEnd,
  parseWorkoutPage,
} from '../shared/contracts/validate-workouts.ts';
import {
  WorkoutStorage,
  WorkoutStorageConflict,
  WorkoutStorageError,
  type StoredWorkout,
} from './workout-storage.ts';
import type { SessionService } from './session.ts';
import type { Transport } from '../shared/contracts/api.ts';
import type { ActivityProgress, WorkoutView, WorkoutEvent } from '../shared/contracts/workouts.ts';

const MAX_SESSION_MS = 24 * 60 * 60 * 1000;
type Storage = Pick<WorkoutStorage, 'init' | 'load' | 'save' | 'clear' | 'close'>;
/** A separate durable journal; program events never enter the legacy squat Outbox. */
export class WorkoutsService {
  private owner: string | null = null;
  private epoch = -1;
  private generation = 0;
  private storage: Storage | null = null;
  private current: StoredWorkout | null = null;
  private progress: ActivityProgress | null = null;
  private opening: Promise<void> | null = null;
  private sending: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private transport: Transport;
  private storageFactory: (owner: string) => Storage;
  private readonly session: SessionService;
  private items: WorkoutView[] = [];
  private cursor: string | null = null;
  private historyLoading = false;
  ready = false;
  saving = false;
  error: unknown = null;
  programs = WORKOUT_PROGRAMS;
  constructor(
    session: SessionService,
    options: { transport?: Transport; storageFactory?: (owner: string) => Storage } = {},
  ) {
    this.session = session;
    this.transport = options.transport ?? defaultTransport;
    this.storageFactory = options.storageFactory ?? ((owner) => new WorkoutStorage(owner));
  }
  private identity() {
    const id = this.session.state?.profile?.id;
    return id ? profileStorageId(id) : null;
  }
  private valid(generation = this.generation) {
    return (
      generation === this.generation &&
      this.owner === this.identity() &&
      this.epoch === this.session.store.epoch
    );
  }
  get record() {
    return this.valid() ? this.current : null;
  }
  get activity() {
    return this.valid() ? this.progress : null;
  }
  get history() {
    return this.valid() ? this.items : [];
  }
  get hasMore() {
    return this.cursor !== null;
  }
  get loadingHistory() {
    return this.historyLoading;
  }
  get unfinished() {
    return !!this.record && (this.record.status === 'active' || !!this.record.pendingEnd);
  }
  get pending() {
    return (this.record?.events.length ?? 0) + (this.record && !this.record.synced ? 1 : 0);
  }
  get expired() {
    return !!this.record && Date.now() - this.record.workout.startedAt >= MAX_SESSION_MS;
  }
  get conflicted() {
    return this.error instanceof WorkoutStorageConflict;
  }
  get persistenceFailed() {
    return (
      this.error instanceof WorkoutStorageError ||
      (this.error instanceof ApiError && this.error.code === 'LOCAL_STORAGE')
    );
  }
  get authorizationRequired() {
    return this.error instanceof ApiError && this.error.status === 401;
  }
  acknowledgeConflict() {
    // CAS recovery already loaded the durable snapshot. Only an explicit resume clears fail-stop.
    if (this.conflicted) {
      this.error = null;
      this.notify();
    }
  }
  /** Called synchronously when AppStore changes identity, before any view renders. */
  observeSession() {
    if (this.owner !== this.identity() || this.epoch !== this.session.store.epoch) this.detach();
  }
  private notify() {
    this.session.notify();
  }
  private detach() {
    this.generation++;
    this.storage?.close();
    this.storage = null;
    this.owner = this.identity();
    this.epoch = this.session.store.epoch;
    this.current = null;
    this.progress = null;
    this.items = [];
    this.cursor = null;
    this.historyLoading = false;
    this.programs = WORKOUT_PROGRAMS;
    this.ready = false;
    this.error = null;
    this.saving = false;
    this.opening = null;
    this.sending = null;
    this.writes = Promise.resolve();
  }
  async connect() {
    this.observeSession();
    if (!this.owner) return;
    if (this.ready) return;
    if (this.opening) return this.opening;
    const generation = this.generation,
      storage = this.storageFactory(this.owner);
    this.storage = storage;
    const operation = (async () => {
      try {
        await storage.init();
        const saved = await storage.load();
        if (!this.valid(generation)) {
          storage.close();
          return;
        }
        this.current = saved;
        this.ready = true;
        this.error = null;
      } catch (error) {
        if (this.valid(generation)) this.error = error;
        throw error;
      } finally {
        if (this.valid(generation)) {
          this.opening = null;
          this.notify();
        }
      }
    })();
    this.opening = operation;
    return operation;
  }
  private serial<T>(
    operation: (
      storage: Storage,
      save: (record: StoredWorkout) => Promise<void>,
      isCurrent: () => boolean,
    ) => Promise<T>,
  ): Promise<T> {
    const generation = this.generation;
    const next = this.writes.then(async () => {
      if (!this.valid(generation) || !this.storage || !this.ready)
        throw new ApiError('SESSION_REVOKED', 401);
      const storage = this.storage;
      const isCurrent = () => this.valid(generation) && this.storage === storage;
      const save = async (record: StoredWorkout) => {
        if (!isCurrent()) throw new ApiError('SESSION_REVOKED', 401);
        const committed = await storage.save(record);
        if (!isCurrent()) throw new ApiError('SESSION_REVOKED', 401);
        this.current = committed ?? record;
      };
      try {
        return await operation(storage, save, isCurrent);
      } catch (error) {
        if (error instanceof WorkoutStorageConflict && isCurrent()) {
          const latest = await storage.load();
          if (!isCurrent()) throw new ApiError('SESSION_REVOKED', 401);
          this.current = latest;
          this.error = error;
          this.notify();
        }
        throw error;
      }
    });
    this.writes = next.catch(() => {});
    return next;
  }
  private applyProgress(next: ActivityProgress) {
    if (
      !this.progress ||
      next.version > this.progress.version ||
      (next.version === this.progress.version && next.serverNow >= this.progress.serverNow)
    )
      this.progress = next;
  }
  private sameWorkout(view: WorkoutView, local: StoredWorkout) {
    const program = findWorkoutProgram(local.workout.programId);
    if (
      !program ||
      view.id !== local.workout.id ||
      view.programId !== local.workout.programId ||
      view.startedAt !== local.workout.startedAt ||
      view.programVersion !== program.version ||
      view.rulesVersion !== 'workout-v1'
    )
      return false;
    const steps = expandWorkoutSteps(program);
    return (
      view.stepProgress.length === steps.length &&
      view.stepProgress.every((amount, index) => amount <= steps[index].target)
    );
  }
  async refresh() {
    await this.connect();
    if (!this.owner) return;
    const generation = this.generation;
    try {
      const value = parseActivity(await this.transport('v2/activity'));
      if (!this.valid(generation)) return;
      this.applyProgress(value);
      this.error = null;
      this.notify();
    } catch (error) {
      if (this.valid(generation)) {
        this.error = error;
        this.notify();
      }
    }
  }
  async refreshCatalog() {
    const generation = this.generation;
    try {
      const result = parseWorkoutCatalog(await this.transport('v2/workouts/catalog'));
      if (!this.valid(generation)) return;
      // Local immutable definitions remain available when the device goes offline.
      this.programs = result.programs;
      this.notify();
    } catch {
      /* keep the packaged, versioned catalog */
    }
  }
  async start(programId: string) {
    this.observeSession();
    const generation = this.generation;
    await this.connect();
    if (!this.valid(generation)) throw new ApiError('SESSION_REVOKED', 401);
    if (!this.ready || !this.storage) throw new ApiError('LOCAL_STORAGE');
    if (this.session.state?.activeRound) throw new ApiError('ACTIVE_ROUND', 409);
    if (this.unfinished) throw new Error('Сначала продолжите или завершите текущую программу.');
    const program = findWorkoutProgram(programId);
    if (!program) throw new Error('Программа недоступна. Обновите приложение.');
    await this.serial(async (storage, save, isCurrent) => {
      if (this.current) await storage.clear(this.current.workout.id);
      if (!isCurrent()) throw new ApiError('SESSION_REVOKED', 401);
      const record: StoredWorkout = {
        workout: { id: crypto.randomUUID(), programId, startedAt: Date.now() },
        stepProgress: expandWorkoutSteps(program).map(() => 0),
        events: [],
        activeMs: 0,
        status: 'active',
        synced: false,
      };
      await save(record);
      if (isCurrent()) this.error = null;
    });
    if (!this.valid(generation)) throw new ApiError('SESSION_REVOKED', 401);
    this.notify();
    if (globalThis.navigator?.onLine !== false) {
      try {
        await this.sync();
      } catch (error) {
        if (error instanceof ApiError && !['NETWORK', 'TIMEOUT'].includes(error.code)) throw error;
      }
    }
  }
  /** Resolves only after the new UUID and progress commit in IndexedDB. */
  async recordEvent(
    stepIndex: number,
    durationMs?: number,
    occurredAt = Date.now(),
    activeMs?: number,
  ) {
    await this.serial(async (_storage, save, isCurrent) => {
      const old = this.current,
        program = old && findWorkoutProgram(old.workout.programId);
      if (!old || old.status !== 'active' || old.pendingEnd || !program || this.expired)
        throw new Error('Программа недоступна для продолжения.');
      const steps = expandWorkoutSteps(program),
        step = steps[stepIndex];
      const index = steps.findIndex((item, i) => old.stepProgress[i] < item.target);
      if (!step || stepIndex !== index) throw new Error('Порядок упражнений изменился.');
      const remaining = step.target - old.stepProgress[stepIndex];
      const amount =
        step.unit === 'ms' ? Math.min(remaining, Math.floor(durationMs ?? 0), 1000) : 1;
      if (amount < 1 || (step.unit === 'reps' && durationMs !== undefined))
        throw new Error('Некорректное событие упражнения.');
      const event: WorkoutEvent = {
        id: crypto.randomUUID(),
        stepIndex,
        occurredAt: Math.floor(occurredAt),
        ...(step.unit === 'ms' ? { durationMs: amount } : {}),
      };
      const next: StoredWorkout = {
        ...old,
        events: [...old.events, event],
        stepProgress: [...old.stepProgress],
        activeMs: Math.max(old.activeMs, Math.floor(activeMs ?? old.activeMs)),
      };
      next.stepProgress[stepIndex] += amount;
      await save(next);
      if (isCurrent()) this.error = null;
    });
    this.notify();
    void this.sync().catch(() => {});
  }
  async checkpoint(activeMs: number) {
    await this.serial(async (_storage, save) => {
      if (!this.current || this.current.status !== 'active') return;
      const next = {
        ...this.current,
        activeMs: Math.max(this.current.activeMs, Math.floor(activeMs)),
      };
      await save(next);
    });
  }
  async sync() {
    if (this.sending) return this.sending;
    if (!this.record || !this.ready) return;
    const generation = this.generation;
    const operation = (async () => {
      this.saving = true;
      this.notify();
      try {
        for (;;) {
          await this.writes;
          if (!this.valid(generation)) return;
          const old = this.current;
          if (!old || (old.synced && !old.events.length)) break;
          const batch = old.events.slice(0, 100);
          const reply = parseWorkoutSync(
            await this.transport('v2/workouts/sync', {
              method: 'POST',
              body: { workout: old.workout, events: batch },
            }),
          );
          if (!this.valid(generation)) return;
          if (
            !this.sameWorkout(reply.workout, old) ||
            reply.workout.status !== 'active' ||
            reply.accepted + reply.duplicate !== batch.length
          )
            throw new Error('API_RESPONSE_INVALID');
          await this.serial(async (_storage, save, isCurrent) => {
            if (!this.current || this.current.workout.id !== old.workout.id) return;
            const ids = new Set(batch.map((event) => event.id));
            const next = {
              ...this.current,
              events: this.current.events.filter((event) => !ids.has(event.id)),
              synced: true,
            };
            await save(next);
            if (!isCurrent()) return;
            this.applyProgress(reply.progress);
            this.error = null;
          });
        }
        if (!this.valid(generation) || !this.current?.pendingEnd) return;
        const old = this.current,
          end = old.pendingEnd!;
        const reply = parseWorkoutEnd(
          await this.transport(`v2/workouts/${old.workout.id}/${end.action}`, {
            method: 'POST',
            body: { endedAt: end.endedAt, activeMs: end.activeMs },
          }),
        );
        if (!this.valid(generation)) return;
        if (
          !this.sameWorkout(reply.workout, old) ||
          reply.workout.status !== (end.action === 'finish' ? 'completed' : 'aborted') ||
          reply.workout.finishedAt !== end.endedAt ||
          reply.workout.activeMs !== end.activeMs
        )
          throw new Error('API_RESPONSE_INVALID');
        await this.serial(async (_storage, save, isCurrent) => {
          if (!this.current || this.current.workout.id !== old.workout.id) return;
          const next = {
            ...this.current,
            status: reply.workout.status,
            pendingEnd: undefined,
            activeMs: reply.workout.activeMs,
          };
          await save(next);
          if (!isCurrent()) return;
          this.applyProgress(reply.progress);
          this.items = [
            reply.workout,
            ...this.items.filter((item) => item.id !== reply.workout.id),
          ];
        });
        this.error = null;
      } catch (error) {
        if (this.valid(generation)) this.error = error;
        throw error;
      } finally {
        if (this.valid(generation)) {
          this.saving = false;
          this.sending = null;
          this.notify();
        }
      }
    })();
    this.sending = operation;
    return operation;
  }
  async end(action: 'finish' | 'abort', activeMs: number, endedAt = Date.now()) {
    await this.serial(async (_storage, save) => {
      const old = this.current;
      if (!old || old.status !== 'active' || old.pendingEnd) return;
      const endTime = Math.max(
        old.workout.startedAt,
        Math.min(Math.floor(endedAt), old.workout.startedAt + MAX_SESSION_MS),
      );
      const end = {
        action,
        endedAt: endTime,
        activeMs: Math.max(0, Math.min(Math.floor(activeMs), endTime - old.workout.startedAt)),
      };
      const next = { ...old, activeMs: end.activeMs, pendingEnd: end };
      await save(next);
    });
    this.notify();
    // A flush in flight may have started before pendingEnd was committed.
    if (this.sending) await this.sending;
    await this.sync();
  }
  async loadHistory(more = false) {
    if (this.historyLoading || !this.owner || (more && !this.cursor)) return;
    this.historyLoading = true;
    const generation = this.generation;
    try {
      const query = new URLSearchParams({ limit: '20' });
      if (more && this.cursor) query.set('cursor', this.cursor);
      const reply = parseWorkoutPage(await this.transport(`v2/workouts/history?${query}`));
      if (!this.valid(generation)) return;
      const all = more ? [...this.items, ...reply.items] : reply.items;
      this.items = [...new Map(all.map((item) => [item.id, item])).values()];
      this.cursor = reply.nextCursor;
    } catch (error) {
      if (this.valid(generation)) this.error = error;
    } finally {
      if (this.valid(generation)) {
        this.historyLoading = false;
        this.notify();
      }
    }
  }
  async prepareLogout() {
    this.observeSession();
    const generation = this.generation;
    await this.connect();
    await this.writes;
    if (!this.valid(generation) || !this.ready || !this.storage)
      throw new ApiError('LOCAL_STORAGE');
    if (this.unfinished)
      throw new Error('Сначала завершите программу и дождитесь сохранения результата.');
    await this.sync();
    if (!this.valid(generation)) throw new ApiError('SESSION_REVOKED', 401);
    if (this.pending) throw new Error('Есть неподтверждённые упражнения. Повторите сохранение.');
  }
  destroy() {
    this.detach();
  }
}
