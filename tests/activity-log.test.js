import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityLog, activityRoute } from '../src/activity-log.js';
test('activity strips private payloads, raw error messages, arbitrary codes and identities from routes', () => {
  const a = new ActivityLog();
  a.record('request.error', {
    route: activityRoute('v2/rounds/PRIVATE_ID/finish?token=PRIVATE_TOKEN'),
    code: 'PRIVATE_NAME',
    status: 500,
    body: { email: 'PRIVATE_EMAIL' },
    message: 'PRIVATE_SECRET',
    url: 'https://PRIVATE_URL',
  });
  const text = JSON.stringify(a.snapshot());
  assert.equal(text.includes('PRIVATE'), false);
  assert.equal(a.snapshot()[0].route, 'rounds.finish');
  assert.equal(a.snapshot()[0].code, 'UNKNOWN_ERROR');
  a.record('ui.action', { action: 'PRIVATE_NAME' });
  assert.equal('action' in a.snapshot()[1], false);
});
test('journal is bounded, has immutable snapshots, survives screen changes and notifies without breaking actions', () => {
  const a = new ActivityLog({ limit: 3 });
  a.subscribe(() => {
    throw new Error('subscriber');
  });
  for (let i = 0; i < 8; i++) a.record('request.end', { status: 200 });
  const data = a.snapshot();
  assert.equal(data.length, 3);
  data[0].status = 500;
  assert.equal(a.snapshot()[0].status, 200);
  a.record('ui.tab', { action: 'training' });
  assert.equal(a.snapshot().at(-1).action, 'training');
  a.clear();
  assert.equal(a.snapshot().length, 1);
});

test('workout routes and fixed actions/errors are distinguishable without UUID/query/hash or payload', () => {
  const a = new ActivityLog();
  for (const [path, expected] of [
    ['v2/workouts/catalog?token=PRIVATE', 'workouts.catalog'],
    ['/api/v2/workouts/PRIVATE/sync', 'other'],
    ['v2/workouts/sync#PRIVATE', 'workouts.sync'],
    ['v2/workouts/PRIVATE/abort?secret=PRIVATE', 'workouts.abort'],
    ['v2/workouts/PRIVATE/finish', 'workouts.finish'],
    ['v2/workouts/history?cursor=PRIVATE', 'workouts.history'],
    ['v2/activity', 'activity'],
  ]) {
    assert.equal(activityRoute(path), expected);
    a.record('request.error', {
      route: activityRoute(path),
      code: 'WORKOUT_API_UNSUPPORTED',
      url: path,
      body: { id: 'PRIVATE' },
    });
  }
  a.record('ui.action', { action: 'workout.retry', workoutId: 'PRIVATE' });
  assert.equal(a.snapshot().at(-1).action, 'workout.retry');
  assert.equal(JSON.stringify(a.snapshot()).includes('PRIVATE'), false);
  assert.ok(
    a
      .snapshot()
      .filter((e) => e.event === 'request.error')
      .every((e) => e.code === 'WORKOUT_API_UNSUPPORTED'),
  );
});
