import {ROUND_MS, RULES_VERSION} from './config.js';

export function comparableRounds(rounds, rulesVersion = RULES_VERSION) {
  const seen = new Set();
  const history = (Array.isArray(rounds) ? rounds : []).filter(round => {
    if (!round || typeof round.id !== 'string' || !round.id || !Number.isFinite(round.startsAt) || !Number.isFinite(round.endsAt) || seen.has(round.id) || round.status !== 'completed' || !['personal', 'competition'].includes(round.kind) || round.rulesVersion !== rulesVersion || !Number.isInteger(round.count) || round.count < 0 || round.endsAt - round.startsAt !== ROUND_MS) return false;
    seen.add(round.id); return true;
  }).sort((a, b) => b.endsAt - a.endsAt || String(b.id).localeCompare(String(a.id)));
  const last = history[0] || null, previous = history[1] || null;
  return {last, previous, delta: last && previous ? last.count - previous.count : null, record: history.length ? Math.max(...history.map(round => round.count)) : null, history};
}

export function dateInTimeZone(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(instant));
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// UTC is only a representation of dates here. The starting calendar date is
// supplied by the server/profile zone, never this device's timezone.
export function calendarDays(today, length = 28) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isInteger(length) || length < 1 || length > 366) return [];
  const end = Date.parse(`${today}T12:00:00Z`);
  if (!Number.isFinite(end) || new Date(end).toISOString().slice(0, 10) !== today) return [];
  return Array.from({length}, (_, index) => new Date(end - (length - index - 1) * 86400000).toISOString().slice(0, 10));
}

export function recentCompletedDays(days, today, length = 7) {
  const window = new Set(calendarDays(today, length));
  return new Set((Array.isArray(days) ? days : []).filter(day => window.has(day.date) && day.completed).map(day => day.date)).size;
}
