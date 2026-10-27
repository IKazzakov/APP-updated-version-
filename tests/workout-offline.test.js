import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rememberWorkoutProfile,
  restoreWorkoutProfile,
  forgetWorkoutProfile,
} from '../src/features/workouts/offline.ts';

function setup(t) {
  const old = {
    location: globalThis.location,
    localStorage: globalThis.localStorage,
    navigator: globalThis.navigator,
  };
  const values = new Map();
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://workout.test' },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  });
  values.set('movement.device-session.https://workout.test', 'a'.repeat(64));
  t.after(() => {
    forgetWorkoutProfile();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, { configurable: true, value });
    }
  });
  return values;
}
function state(id = 'alice') {
  return {
    profile: { id, displayName: id, timeZone: 'UTC', rankingsEnabled: true },
    today: { date: '2026-10-26', count: 0, completed: false, goal: 10 },
    days: [],
    points: 0,
    last7: 0,
    rounds: [],
    competitions: [],
    activeRound: null,
    serverNow: Date.now(),
    rulesVersion: 'squat-v1',
    weekly: {
      activationWeek: '2026-10-19',
      sportsWeek: '2026-10-26',
      timeZone: 'Africa/Johannesburg',
      periods: [],
      yourWeek: {
        week: '2026-10-26',
        dates: [],
        completedDays: 0,
        remaining: 7,
        possible: true,
        canSyncPast: false,
        points: { daily: 0, fullWeek: 0, sport: 0, total: 0 },
      },
      places: { result: null, points: null },
      summaries: [],
    },
  };
}

test('offline profile cache is bound to the current credential and has no embedded secret', async (t) => {
  const values = setup(t);
  await rememberWorkoutProfile(state());
  assert.equal((await restoreWorkoutProfile()).profile.id, 'alice');
  const cache = [...values].find(([key]) => key.startsWith('movement.workout-profile-cache.'));
  assert.ok(cache);
  assert.equal(cache[1].includes('a'.repeat(64)), false);
  values.set('movement.device-session.https://workout.test', 'b'.repeat(64));
  assert.equal(await restoreWorkoutProfile(), null);
  navigator.onLine = true;
  assert.equal(await restoreWorkoutProfile(), null);
});

test('logout cancels a profile cache write waiting for hashing', async (t) => {
  const values = setup(t),
    original = crypto.subtle.digest;
  let finish;
  crypto.subtle.digest = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  t.after(() => {
    crypto.subtle.digest = original;
  });
  const remembering = rememberWorkoutProfile(state());
  forgetWorkoutProfile();
  finish(new Uint8Array(32).buffer);
  await remembering;
  assert.equal(
    [...values.keys()].some((key) => key.startsWith('movement.workout-profile-cache.')),
    false,
  );
});

test('a stale pre-logout cache write cannot replace the newly confirmed profile', async (t) => {
  const values = setup(t),
    original = crypto.subtle.digest;
  let finish;
  crypto.subtle.digest = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const old = rememberWorkoutProfile(state('alice'));
  forgetWorkoutProfile();
  crypto.subtle.digest = original;
  values.set('movement.device-session.https://workout.test', 'b'.repeat(64));
  await rememberWorkoutProfile(state('bob'));
  finish(new Uint8Array(32).buffer);
  await old;
  assert.equal((await restoreWorkoutProfile()).profile.id, 'bob');
});
