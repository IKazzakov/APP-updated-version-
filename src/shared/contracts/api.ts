/** Wire data only: no database, platform, UI or server implementation imports. */
export interface Profile {
  id: string;
  displayName: string;
  timeZone: string;
  rankingsEnabled: boolean;
}
export interface DayProgress {
  date: string;
  count: number;
  completed: boolean;
}
export interface Today extends DayProgress {
  goal: number;
}
export type TrainingMode = 'practice' | 'personal' | 'competition';
export interface Round {
  id: string;
  kind: 'personal' | 'competition';
  status: 'active' | 'completed' | 'aborted';
  competitionId: string | null;
  rulesVersion: string;
  startsAt: number;
  endsAt: number;
  finishedAt: number | null;
  count: number;
}
export interface Participant {
  role: 'creator' | 'opponent';
  name: string;
  isYou: boolean;
  best: number | null;
  attemptsUsed: number;
  attemptsLeft: number;
  activeAttempt: boolean;
}
export interface Competition {
  id: string;
  rulesVersion: string;
  status: 'invited' | 'active' | 'settling' | 'finished' | 'cancelled';
  createdAt: number;
  acceptedAt: number | null;
  expiresAt: number | null;
  participants: Participant[];
  result: { type: 'not_held' | 'tie' | 'winner'; winner: 'creator' | 'opponent' | null } | null;
  canCancel: boolean;
  canStart: boolean;
  preliminary: boolean;
}
export interface Points {
  daily: number;
  fullWeek: number;
  sport: number;
  total: number;
}
export interface WeekPeriod {
  week: string;
  startsAt: number;
  endsAt: number;
  closed: boolean;
  rulesVersion: string;
}
export interface WeeklySummary {
  week: string;
  completedDays: number;
  best: number | null;
  place: number | null;
  participated: boolean;
  points: Points;
  revision: number;
  seen: boolean;
  updatedSinceSeen: boolean;
  rulesVersion: string;
  pointsMayUpdate: boolean;
}
export interface Place {
  value: number;
  place: number;
}
export interface Weekly {
  activationWeek: string;
  sportsWeek: string;
  timeZone: string;
  periods: WeekPeriod[];
  yourWeek: {
    week: string;
    dates: { date: string; completed: boolean; past: boolean; today: boolean }[];
    completedDays: number;
    remaining: number;
    possible: boolean;
    canSyncPast: boolean;
    points: Points;
  };
  places: { result: Place | null; points: Place | null };
  summaries: WeeklySummary[];
}
/** Calendar dates are YYYY-MM-DD; timestamps are Unix milliseconds. */
interface Counters {
  profile: Profile | null;
  today: Today | null;
  days: DayProgress[];
  points: number;
  last7: number;
  activeRound: Round | null;
  serverNow: number;
  rulesVersion: string;
  version?: number;
  bonusPoints?: number;
}
export interface LegacySnapshot extends Counters {
  partial?: false;
  compact?: false;
  rounds: Round[];
  competitions: Competition[];
  weekly?: Weekly;
  stats?: { record: number | null };
}
export interface Dashboard extends Counters {
  compact: true;
  partial?: false;
  rounds: Round[];
  competitions: Competition[];
  weekly?: Weekly;
  stats?: { record: number | null };
}
export interface WriteReceipt extends Counters {
  partial: true;
  compact?: false;
  weekly?: Weekly;
}
export type Snapshot = LegacySnapshot | Dashboard | WriteReceipt;
export type AppState = LegacySnapshot | Dashboard;
export type HistoryKind = 'rounds' | 'progress' | 'weeks' | 'competitions';
export interface HistoryItems {
  rounds: Round;
  progress: DayProgress;
  weeks: WeeklySummary;
  competitions: Competition;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  serverNow: number;
  limit: number;
}
export interface Leaderboard {
  type: 'result' | 'points';
  period: 'week' | 'all';
  week: string;
  periodInfo: WeekPeriod;
  serverNow: number;
  timeZone: string;
  entries: (Place & { id?: string; name: string; isYou: boolean })[];
  you: Place | null;
  totalParticipants: number;
  pointsMayUpdate: boolean;
}
export interface InvitationPreview {
  competitionId: string;
  creatorName: string;
  status: string;
  rulesVersion: string;
  canAccept: boolean;
}
export interface ApiOptions {
  method?: string;
  body?: unknown;
  keepalive?: boolean;
}
export interface RoundResult {
  id: string;
  status: 'completed' | 'interrupted' | 'aborted';
}
export interface Repetition {
  id: string;
  occurredAt: string;
  roundId?: string | null;
  rulesVersion: string;
}
export interface MutationReply {
  state: Snapshot;
}
export type ApiResponse<P extends string> = P extends 'state'
  ? AppState
  : P extends 'profile'
    ? MutationReply & { profile: Profile }
    : P extends 'repetitions'
      ? MutationReply & { accepted: number; duplicate: number }
      : P extends 'rounds/start'
        ? { round: Round; serverNow: number }
        : P extends `rounds/${string}`
          ? MutationReply & { round: Round }
          : P extends 'competitions'
            ? { competition: Competition; invitationToken?: string }
            : P extends `competitions/${string}` | 'invitations/accept'
              ? MutationReply & { competition: Competition }
              : P extends 'invitations/preview'
                ? InvitationPreview & { preview?: InvitationPreview }
                : P extends 'weeks/seen'
                  ? MutationReply
                  : P extends `leaderboards?${string}`
                    ? Leaderboard
                    : P extends `competitions?${string}`
                      ? Page<Competition>
                      : P extends `history/rounds?${string}`
                        ? Page<Round>
                        : P extends `history/progress?${string}`
                          ? Page<DayProgress>
                          : P extends `history/weeks?${string}`
                            ? Page<WeeklySummary>
                            : unknown;
export type ApiRequest = <P extends string>(
  path: P,
  options?: ApiOptions,
) => Promise<ApiResponse<P>>;
export type Transport = (path: string, options?: ApiOptions) => Promise<unknown>;
