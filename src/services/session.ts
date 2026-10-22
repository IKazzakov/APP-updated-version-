import { api as transport, ApiError, getTestUser } from '../api.js';
import { Outbox, type SyncStatus } from '../outbox.js';
import { HistoryLoader } from '../history.js';
import { profileStorageId } from '../platform.js';
import { createApiClient } from './api-client.ts';
import { AppStore } from '../app/store.ts';
import type {
  Snapshot,
  AppState,
  Profile,
  Today,
  Weekly,
  HistoryKind,
  HistoryItems,
  ApiRequest,
} from '../shared/contracts/api.ts';

export interface HistoryOptions {
  more?: boolean;
  refresh?: boolean;
  from?: string;
  to?: string;
}
export class SessionService {
  readonly store = new AppStore();
  readonly client = createApiClient(transport);
  private generation = 0;
  readonly api: ApiRequest = async (path, options) => {
    const generation = this.generation;
    const result = await this.client.request(path, options);
    if (generation !== this.generation) throw new ApiError('SESSION_REVOKED', 401);
    return result;
  };
  outbox: Outbox | null = null;
  outboxReady = false;
  outboxOwner: string | null = null;
  loading = false;
  loadError: unknown = null;
  authBusy = false;
  persistenceError = false;
  sync: SyncStatus = { pending: 0, saving: false, error: null };
  private quietBusy = false;
  private queueOpening: Promise<void> | null = null;
  private history: HistoryLoader;
  constructor(private readonly onError: (error: unknown) => void) {
    this.history = new HistoryLoader({
      api: this.api,
      onError,
      onPage: (
        kind: HistoryKind,
        items: HistoryItems[HistoryKind][],
        { append }: { append: boolean },
      ) => this.store.page(kind, items, append),
    });
  }
  get state() {
    return this.store.state;
  }
  requireState() {
    const s = this.state;
    if (!s?.profile || !s.today || !s.weekly) throw new ApiError('PROFILE_REQUIRED', 401);
    return s as AppState & { profile: Profile; today: Today; weekly: Weekly };
  }
  notify() {
    this.store.notify();
  }
  async apply(next: Snapshot, epoch = this.store.epoch) {
    if (epoch !== this.store.epoch) return;
    if (!next.profile) {
      await this.api('profile', {
        method: 'POST',
        body: {
          displayName: getTestUser() || 'Участник',
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        },
      });
      next = await this.api('state');
    }
    if (epoch !== this.store.epoch || !this.store.apply(next, epoch)) return;
    const s = this.requireState(),
      owner = profileStorageId(s.profile.id);
    this.history.setOwner(owner);
    if (this.outbox && this.outboxOwner !== owner) {
      this.outbox.close();
      this.outbox = null;
      this.outboxReady = false;
    }
    if (this.queueOpening) {
      await this.queueOpening;
      return;
    }
    if (!this.outbox) {
      this.outboxOwner = owner;
      const queue = new Outbox(owner, {
        api: this.api,
        flushDelayMs: 1500,
        onStatus: (status) => {
          if (epoch !== this.store.epoch || this.outboxOwner !== owner || !this.state?.profile)
            return;
          this.sync = status;
          if (status.state) this.store.apply(status.state, epoch);
          else this.notify();
        },
      });
      this.outbox = queue;
      const open = (async () => {
        try {
          await queue.init();
          if (epoch === this.store.epoch) this.outboxReady = true;
        } catch (error) {
          queue.close();
          if (this.outbox === queue) {
            this.outbox = null;
            this.outboxReady = false;
          }
          throw error;
        } finally {
          this.queueOpening = null;
          this.notify();
        }
      })();
      this.queueOpening = open;
      await open;
    }
    this.notify();
  }
  async refresh() {
    if (this.quietBusy || this.loading || this.authBusy || !navigator.onLine) return;
    this.quietBusy = true;
    const epoch = this.store.epoch;
    try {
      await this.apply(await this.api('state'), epoch);
      this.loadError = null;
      this.notify();
    } catch {
      /* retain confirmed data */
    } finally {
      this.quietBusy = false;
    }
  }
  async loadHistory(kind: HistoryKind, options: HistoryOptions = {}) {
    if (!this.client.compact || !this.state?.profile) return;
    const pending = this.history.load(kind, options);
    this.notify();
    try {
      await pending;
    } finally {
      this.notify();
    }
  }
  pageInfo(kind: HistoryKind) {
    return this.history.info(kind) as { next?: string | null; loading?: boolean };
  }
  async retry() {
    if (!this.outbox) return;
    try {
      const saved = await this.outbox.flush({ retryFailed: true });
      if (saved) await this.apply(saved);
    } catch (error) {
      this.onError(error);
    }
  }
  reset() {
    this.generation++;
    this.outboxOwner = null;
    this.outbox?.close();
    this.outbox = null;
    this.outboxReady = false;
    this.queueOpening = null;
    this.history.setOwner(null);
    this.sync = { pending: 0, saving: false, error: null };
    this.store.reset();
  }
  destroy() {
    this.reset();
  }
}
