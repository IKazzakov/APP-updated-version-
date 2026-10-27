import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './server-db.js';
import { handleApi } from '../server/api.js';
import { parseReply } from '../src/shared/contracts/validate.ts';
import {
  parseActivity,
  parseWorkoutCatalog,
  parseWorkoutSync,
  parseWorkoutEnd,
  parseWorkoutPage,
} from '../src/shared/contracts/validate-workouts.ts';
import { createApiClient } from '../src/services/api-client.ts';
import { expandWorkoutSteps } from '../src/shared/workouts/catalog.ts';

async function fixture(t) {
  const db = createTestDatabase();
  t.after(() => db.close());
  const nextDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const now = Date.parse(nextDate + 'T12:00:00Z');
  const call = async (path, body) => {
    const response = await handleApi(
      new Request('https://test.example/api/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'oai-authenticated-user-id': 'contracts',
          origin: 'https://test.example',
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { DB: db },
      { now: () => now },
    );
    const value = await response.json();
    assert.equal(response.status, 200, path + ': ' + JSON.stringify(value));
    return value;
  };
  await call('v2/profile', { displayName: 'Контракт', timeZone: 'Africa/Johannesburg' });
  return { call, now };
}
test('new wire parsers accept the real catalog, all four programs, receipts and history', async (t) => {
  const { call, now } = await fixture(t);
  const catalog = parseWorkoutCatalog(await call('v2/workouts/catalog'));
  assert.equal(catalog.programs.length, 4);
  assert.deepEqual(
    catalog.programs.map((p) => p.id),
    ['squats-5-v1', 'pushups-5-v1', 'plank-15-v1', 'starter-circuit-v1'],
  );
  assert.equal(parseActivity(await call('v2/activity')).today.goal, 10);
  let progress;
  for (const [programIndex, program] of catalog.programs.entries()) {
    const workout = {
      id: crypto.randomUUID(),
      programId: program.id,
      startedAt: now - (catalog.programs.length - programIndex) * 60000,
    };
    const events = [];
    let at = workout.startedAt + 1000;
    for (const [stepIndex, step] of expandWorkoutSteps(program).entries()) {
      const count = step.unit === 'ms' ? step.target / 1000 : step.target;
      for (let index = 0; index < count; index++) {
        events.push({
          id: crypto.randomUUID(),
          stepIndex,
          occurredAt: at,
          ...(step.unit === 'ms' ? { durationMs: 1000 } : {}),
        });
        at += step.unit === 'ms' ? 1000 : 700;
      }
    }
    const sync = parseWorkoutSync(await call('v2/workouts/sync', { workout, events }));
    assert.equal(sync.accepted, events.length);
    const repeat = parseReply(
      'v2/workouts/sync',
      await call('v2/workouts/sync', { workout, events }),
    );
    assert.equal(repeat.accepted, 0);
    assert.equal(repeat.duplicate, events.length);
    assert.equal(repeat.progress.totalXp, sync.progress.totalXp);
    const reply = parseWorkoutEnd(
      await call('v2/workouts/' + workout.id + '/finish', {
        endedAt: workout.startedAt + 45000,
        activeMs: 45000,
      }),
    );
    assert.equal(reply.workout.status, 'completed');
    assert.deepEqual(
      reply.workout.stepProgress,
      expandWorkoutSteps(program).map((s) => s.target),
    );
    progress = reply.progress;
  }
  assert.equal(progress.totalXp, 26);
  assert.equal(progress.today.units, 26);
  assert.equal(progress.streak.current, 1);
  const page = parseWorkoutPage(await call('v2/workouts/history?limit=2'));
  assert.equal(page.items.length, 2);
  assert.equal(page.limit, 2);
  assert.ok(page.nextCursor);
});

test('external JSON cannot claim impossible completion, counters or giant catalogs', async (t) => {
  const { call, now } = await fixture(t);
  const activity = parseActivity(await call('v2/activity'));
  assert.throws(
    () => parseActivity({ ...activity, today: { ...activity.today, units: 10, completed: true } }),
    /API_RESPONSE_INVALID/,
  );
  assert.throws(() => parseActivity({ ...activity, totalXp: 100 }), /API_RESPONSE_INVALID/);
  const catalog = parseWorkoutCatalog(await call('v2/workouts/catalog'));
  assert.throws(
    () =>
      parseWorkoutCatalog({
        ...catalog,
        programs: [{ ...catalog.programs[0], rounds: 100000000 }],
      }),
    /API_RESPONSE_INVALID/,
  );
  assert.equal(parseWorkoutCatalog({ ...catalog, additiveMetadata: 'allowed' }).programs.length, 4);
  const sync = parseWorkoutSync(
    await call('v2/workouts/sync', {
      workout: { id: crypto.randomUUID(), programId: 'squats-5-v1', startedAt: now - 1000 },
      events: [],
    }),
  );
  assert.throws(
    () =>
      parseWorkoutEnd({
        progress: sync.progress,
        workout: { ...sync.workout, status: 'completed', finishedAt: now, stepProgress: [0] },
      }),
    /API_RESPONSE_INVALID/,
  );
  assert.throws(
    () =>
      parseWorkoutEnd({
        progress: sync.progress,
        workout: {
          ...sync.workout,
          status: 'aborted',
          finishedAt: sync.workout.startedAt + 86400001,
        },
      }),
    /API_RESPONSE_INVALID/,
  );
});

test('explicit workout v2 transport uses one prefix and never falls back on API errors', async (t) => {
  const { call } = await fixture(t);
  const catalog = await call('v2/workouts/catalog');
  const paths = [];
  const client = createApiClient(async (path) => {
    paths.push(path);
    return catalog;
  });
  assert.equal((await client.request('v2/workouts/catalog')).programs.length, 4);
  assert.deepEqual(paths, ['v2/workouts/catalog']);
  const missing = createApiClient(async (path) => {
    paths.push(path);
    const error = new Error('not found');
    error.status = 404;
    error.code = 'NOT_FOUND';
    throw error;
  });
  await assert.rejects(missing.request('v2/workouts/catalog'), /not found/);
  assert.deepEqual(paths, ['v2/workouts/catalog', 'v2/workouts/catalog']);
});
