import { mergeState } from '../data-client.js';
import type { AppState, Snapshot, HistoryKind, HistoryItems } from '../shared/contracts/api.ts';
const merge = <T, K extends keyof T>(a: T[], b: T[], key: K): T[] => [
  ...new Map([...a, ...b].map((v) => [v[key], v])).values(),
];
export class AppStore {
  private value: AppState | null = null;
  private listeners = new Set<() => void>();
  private revision = 0;
  get state() {
    return this.value;
  }
  /** Session epoch rejects late callbacks even when the same account is reopened. */
  get epoch() {
    return this.revision;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  notify() {
    for (const fn of this.listeners) fn();
  }
  reset() {
    this.revision++;
    this.value = null;
    this.notify();
  }
  apply(next: Snapshot, epoch = this.epoch) {
    if (epoch !== this.epoch) return false;
    if (next.partial && (!this.value || next.profile?.id !== this.value.profile?.id)) return false;
    this.value = mergeState(this.value, next) as AppState;
    this.notify();
    return true;
  }
  page<K extends HistoryKind>(
    kind: K,
    items: HistoryItems[K][],
    append: boolean,
    epoch = this.epoch,
  ) {
    const state = this.value;
    if (!state?.profile || epoch !== this.epoch) return;
    const next = { ...state };
    // This typed boundary pairs each history route with its item type.
    if (kind === 'rounds')
      next.rounds = merge(state.rounds, items as HistoryItems['rounds'][], 'id').sort(
        (a, b) =>
          (b.finishedAt || b.endsAt) - (a.finishedAt || a.endsAt) || b.id.localeCompare(a.id),
      );
    if (kind === 'competitions')
      next.competitions = merge(
        append ? state.competitions : [],
        items as HistoryItems['competitions'][],
        'id',
      );
    if (kind === 'progress')
      next.days = merge(
        state.days,
        (items as HistoryItems['progress'][]).map((d) => {
          const count = Math.max(d.count, state.days.find((o) => o.date === d.date)?.count || 0);
          return { ...d, count, completed: count >= 10 };
        }),
        'date',
      );
    if (kind === 'weeks' && state.weekly) {
      const weeks = items as HistoryItems['weeks'][];
      next.weekly = {
        ...state.weekly,
        summaries: merge(state.weekly.summaries, weeks, 'week').sort((a, b) =>
          b.week.localeCompare(a.week),
        ),
        periods: merge(
          state.weekly.periods,
          weeks.map((w) => ({
            week: w.week,
            closed: true,
            rulesVersion: w.rulesVersion,
            startsAt: Date.parse(w.week + 'T00:00:00+02:00'),
            endsAt: Date.parse(w.week + 'T00:00:00+02:00') + 604800000,
          })),
          'week',
        ).sort((a, b) => b.week.localeCompare(a.week)),
      };
    }
    this.value = next;
    this.notify();
  }
}
