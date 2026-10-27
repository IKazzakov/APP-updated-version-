import type { ApiResponse, Snapshot } from './api';
import { parseWorkoutReply } from './validate-workouts.ts';
export {
  parseActivity,
  parseWorkoutCatalog,
  parseWorkoutSync,
  parseWorkoutEnd,
  parseWorkoutPage,
} from './validate-workouts.ts';
export { parseWorkoutReply };

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const nullable = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v);
const list = (v: unknown, check: (v: unknown) => boolean) => Array.isArray(v) && v.every(check);
const fields = (v: unknown, checks: Record<string, (v: unknown) => boolean>) =>
  object(v) && Object.entries(checks).every(([key, check]) => check(v[key]));
const oneOf =
  (...values: unknown[]) =>
  (v: unknown) =>
    values.includes(v);
const date = (v: unknown) => str(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
const profile = (v: unknown) =>
  fields(v, { id: str, displayName: str, timeZone: str, rankingsEnabled: bool });
const day = (v: unknown) => fields(v, { date, count: num, completed: bool });
const round = (v: unknown) =>
  fields(v, {
    id: str,
    kind: oneOf('personal', 'competition'),
    status: oneOf('active', 'completed', 'aborted'),
    competitionId: nullable(str),
    rulesVersion: str,
    startsAt: num,
    endsAt: num,
    finishedAt: nullable(num),
    count: num,
  });
const points = (v: unknown) => fields(v, { daily: num, fullWeek: num, sport: num, total: num });
const period = (v: unknown) =>
  fields(v, { week: date, startsAt: num, endsAt: num, closed: bool, rulesVersion: str });
const place = (v: unknown) => fields(v, { place: num, value: num });
const summary = (v: unknown) =>
  fields(v, {
    week: date,
    completedDays: num,
    best: nullable(num),
    place: nullable(num),
    participated: bool,
    points,
    revision: num,
    seen: bool,
    updatedSinceSeen: bool,
    rulesVersion: str,
    pointsMayUpdate: bool,
  });
const competition = (v: unknown) =>
  fields(v, {
    id: str,
    rulesVersion: str,
    status: oneOf('invited', 'active', 'settling', 'finished', 'cancelled'),
    createdAt: num,
    acceptedAt: nullable(num),
    expiresAt: nullable(num),
    participants: (v) =>
      list(v, (p) =>
        fields(p, {
          role: oneOf('creator', 'opponent'),
          name: str,
          isYou: bool,
          best: nullable(num),
          attemptsUsed: num,
          attemptsLeft: num,
          activeAttempt: bool,
        }),
      ),
    result: nullable((v) =>
      fields(v, {
        type: oneOf('not_held', 'tie', 'winner'),
        winner: oneOf(null, 'creator', 'opponent'),
      }),
    ),
    canCancel: bool,
    canStart: bool,
    preliminary: bool,
  });
const weekly = (v: unknown) =>
  fields(v, {
    activationWeek: date,
    sportsWeek: date,
    timeZone: str,
    periods: (v) => list(v, period),
    yourWeek: (v) =>
      fields(v, {
        week: date,
        dates: (v) => list(v, (d) => fields(d, { date, completed: bool, past: bool, today: bool })),
        completedDays: num,
        remaining: num,
        possible: bool,
        canSyncPast: bool,
        points,
      }),
    places: (v) => fields(v, { result: nullable(place), points: nullable(place) }),
    summaries: (v) => list(v, summary),
  });
export function isSnapshot(v: unknown): v is Snapshot {
  if (
    !fields(v, {
      profile: nullable(profile),
      today: nullable((v) => day(v) && fields(v, { goal: num })),
      days: (v) => list(v, day),
      points: num,
      last7: num,
      activeRound: nullable(round),
      serverNow: num,
      rulesVersion: str,
    }) ||
    !object(v)
  )
    return false;
  if (v.version !== undefined && !Number.isSafeInteger(v.version)) return false;
  if (v.bonusPoints !== undefined && !num(v.bonusPoints)) return false;
  if (v.weekly !== undefined && !weekly(v.weekly)) return false;
  if (v.profile !== null && (!v.today || (!v.weekly && v.partial !== true))) return false;
  if (v.partial === true) return v.compact !== true;
  return (
    (v.compact === undefined || bool(v.compact)) &&
    list(v.rounds, round) &&
    list(v.competitions, competition) &&
    (v.stats === undefined || fields(v.stats, { record: nullable(num) }))
  );
}
const preview = (v: unknown) =>
  fields(v, {
    competitionId: str,
    creatorName: str,
    status: str,
    rulesVersion: str,
    canAccept: bool,
  });
/** Validate external JSON before committing it. Unknown additive fields are allowed. */
export function parseReply<P extends string>(path: P, value: unknown): ApiResponse<P> {
  const route = path.split('?')[0];
  if (route === 'v2/activity' || route.startsWith('v2/workouts/'))
    return parseWorkoutReply(path, value) as ApiResponse<P>;
  let valid = false;
  if (route === 'state') valid = isSnapshot(value) && value.partial !== true;
  else if (route === 'rounds/start') valid = fields(value, { round, serverNow: num });
  else if (route === 'invitations/preview') valid = preview(value) || fields(value, { preview });
  else if (route === 'leaderboards')
    valid = fields(value, {
      type: oneOf('result', 'points'),
      period: oneOf('week', 'all'),
      week: date,
      periodInfo: period,
      serverNow: num,
      timeZone: str,
      entries: (v) => list(v, (p) => place(p) && fields(p, { name: str, isYou: bool })),
      you: nullable(place),
      totalParticipants: num,
      pointsMayUpdate: bool,
    });
  else if (route.startsWith('history/') || (route === 'competitions' && path.includes('?'))) {
    const check = (
      {
        'history/rounds': round,
        'history/progress': day,
        'history/weeks': summary,
        competitions: competition,
      } as Record<string, (v: unknown) => boolean>
    )[route];
    valid =
      !!check &&
      fields(value, {
        items: (v) => list(v, check),
        nextCursor: nullable(str),
        serverNow: num,
        limit: num,
      });
  } else if (route === 'competitions') valid = fields(value, { competition });
  else {
    valid = fields(value, { state: isSnapshot });
    if (route === 'profile') valid = valid && fields(value, { profile });
    if (route === 'repetitions') valid = valid && fields(value, { accepted: num, duplicate: num });
    if (route.startsWith('rounds/')) valid = valid && fields(value, { round });
    if (route.startsWith('competitions/') || route === 'invitations/accept')
      valid = valid && fields(value, { competition });
  }
  if (!valid) throw new Error('API_RESPONSE_INVALID');
  return value as ApiResponse<P>;
}
