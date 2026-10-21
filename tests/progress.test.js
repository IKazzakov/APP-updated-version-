import test from 'node:test';
import assert from 'node:assert/strict';
import {comparableRounds, calendarDays, dateInTimeZone, recentCompletedDays} from '../src/progress.js';
const round = (id, count, startsAt, changes = {}) => ({id, count, startsAt, endsAt: startsAt + 60000, status: 'completed', kind: 'personal', rulesVersion: 'squat-v1', ...changes});

test('first completed minute is a baseline, never a fictitious improvement', () => {
  const empty = comparableRounds([]); assert.equal(empty.record, null); assert.equal(empty.delta, null);
  const first = comparableRounds([round('first', 10, 0)]);
  assert.equal(first.last.count, 10); assert.equal(first.previous, null); assert.equal(first.delta, null); assert.equal(first.record, 10);
});
test('history compares consecutive compatible minutes including competition once', () => {
  const competition = round('competition', 24, 200000, {kind: 'competition'});
  const result = comparableRounds([round('old', 21, 0), competition, {...competition}, round('latest', 22, 400000)]);
  assert.equal(result.last.count, 22); assert.equal(result.previous.count, 24); assert.equal(result.delta, -2);
  assert.equal(result.record, 24); assert.deepEqual(result.history.map(item => item.id), ['latest', 'competition', 'old']);
});
test('incomplete, aborted, practice and incompatible rule versions never set personal records', () => {
  const result = comparableRounds([
    round('good', 10, 0), round('abort', 100, 100000, {status: 'aborted'}),
    round('early', 100, 200000, {endsAt: 210000}), round('practice', 100, 300000, {kind: 'practice'}),
    round('future-rules', 100, 400000, {rulesVersion: 'squat-v2'}), round('invalid', NaN, 500000),
  ]);
  assert.equal(result.record, 10); assert.equal(result.history.length, 1);
});
test('profile timezone fixes the calendar date across devices and DST boundaries', () => {
  const instant = '2026-10-20T01:00:00Z';
  assert.equal(dateInTimeZone(instant, 'America/Los_Angeles'), '2026-10-19');
  assert.equal(dateInTimeZone(instant, 'Asia/Tokyo'), '2026-10-20');
  const dates = calendarDays('2026-03-10', 4);
  assert.deepEqual(dates, ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  assert.deepEqual(calendarDays('2026-01-02', 3), ['2025-12-31', '2026-01-01', '2026-01-02']);
});
test('regularity counts completed distinct calendar days in the last seven, without subtracting misses', () => {
  const days = [{date: '2026-10-13', completed: true}, {date: '2026-10-14', completed: true}, {date: '2026-10-19', completed: true}, {date: '2026-10-19', completed: true}, {date: '2026-10-20', completed: false}];
  assert.equal(recentCompletedDays(days, '2026-10-20'), 2);
});
