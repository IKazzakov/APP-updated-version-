// The installed 2.5.2 APK keeps /api/*; new clients negotiate /api/v2/*.
export function createDataClient(transport) {
  let compact = null;
  return {
    get compact() {
      return compact === true;
    },
    async request(path, options) {
      const target = path === 'state' ? 'dashboard' : path;
      if (compact !== false) {
        try {
          const data = await transport('v2/' + target, options);
          compact = true;
          return data;
        } catch (error) {
          if (error.status !== 404 || !['NOT_FOUND', 'API_NOT_FOUND'].includes(error.code))
            throw error;
          compact = false;
        }
      }
      return transport(path, options);
    },
  };
}
const merge = (old = [], next = [], key) => [
  ...new Map([...old, ...next].map((v) => [v[key], v])).values(),
];
export function mergeState(current, next) {
  if (!current || !next?.profile || current.profile?.id !== next.profile.id) return next;
  if (
    Number.isSafeInteger(current.version) &&
    Number.isSafeInteger(next.version) &&
    next.version < current.version
  )
    return current;
  if (!next.partial && !next.compact) return next;
  const state = { ...current, ...next, partial: false };
  state.days = merge(current.days, next.days, 'date').sort((a, b) => b.date.localeCompare(a.date));
  state.rounds = merge(current.rounds, next.rounds, 'id').sort(
    (a, b) => (b.finishedAt || b.endsAt) - (a.finishedAt || a.endsAt) || b.id.localeCompare(a.id),
  );
  state.competitions = next.compact
    ? current.competitions
    : next.competitions || current.competitions;
  if (next.weekly)
    state.weekly = {
      ...next.weekly,
      periods: merge(current.weekly?.periods, next.weekly.periods, 'week').sort((a, b) =>
        b.week.localeCompare(a.week),
      ),
      summaries: merge(current.weekly?.summaries, next.weekly.summaries, 'week').sort((a, b) =>
        b.week.localeCompare(a.week),
      ),
    };
  return state;
}
