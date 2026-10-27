import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/api.js';
import { WorkoutsService } from '../src/services/workouts.ts';
import { WorkoutStorageConflict, WorkoutStorageError } from '../src/services/workout-storage.ts';
import { quantizeHoldInterval } from '../src/features/workouts/hold-interval.ts';
import {
  expandWorkoutSteps,
  findWorkoutProgram,
  WORKOUT_PROGRAMS,
} from '../src/shared/workouts/catalog.ts';

const clone = (value) => (value == null ? value : structuredClone(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function progress(units = 0, version = units) {
  return {
    rulesVersion: 'activity-v1',
    activatedAt: 0,
    version,
    totalXp: Math.min(300, units),
    level: 1 + Math.floor(Math.min(300, units) / 100),
    xpInLevel: Math.min(300, units) % 100,
    xpForNextLevel: 100,
    today: {
      date: '2026-10-26',
      squats: units,
      pushups: 0,
      plankMs: 0,
      units,
      xp: Math.min(300, units),
      goal: 10,
      completed: units >= 10,
    },
    streak: { current: units >= 10 ? 1 : 0, best: units >= 10 ? 1 : 0 },
    serverNow: Date.now(),
  };
}
function session(id = 'alice') {
  return { state: { profile: { id }, activeRound: null }, store: { epoch: 0 }, notify() {} };
}
function memoryStorage() {
  const records = new Map(),
    instances = [];
  const hooks = { beforeSave: null, beforeLoad: null };
  return {
    records,
    instances,
    hooks,
    factory(owner) {
      const storage = {
        owner,
        closed: false,
        async init() {},
        async load() {
          if (hooks.beforeLoad) await hooks.beforeLoad(owner);
          return clone(records.get(owner) ?? null);
        },
        async save(record) {
          const copy = clone(record);
          if (hooks.beforeSave) await hooks.beforeSave(copy, owner);
          records.set(owner, copy);
        },
        async clear(id) {
          if (records.get(owner)?.workout.id === id) records.delete(owner);
        },
        close() {
          this.closed = true;
        },
      };
      instances.push(storage);
      return storage;
    },
  };
}
/** Simulates only the remote contract; tests assert service-visible guarantees. */
function remote() {
  const calls = [],
    sessions = new Map(),
    events = new Map();
  let units = 0;
  const hooks = { beforeSync: null, afterSync: null, afterEnd: null };
  const transport = async (path, options = {}) => {
    const body = clone(options.body);
    calls.push({ path, body });
    if (path === 'v2/activity') return progress(units);
    if (path === 'v2/workouts/catalog')
      return { programs: WORKOUT_PROGRAMS, rulesVersion: 'workout-v1', serverNow: Date.now() };
    if (path === 'v2/workouts/sync') {
      if (hooks.beforeSync) await hooks.beforeSync(body);
      let workout = sessions.get(body.workout.id);
      if (!workout) {
        const program = findWorkoutProgram(body.workout.programId);
        workout = {
          ...body.workout,
          programVersion: 1,
          rulesVersion: 'workout-v1',
          status: 'active',
          finishedAt: null,
          activeMs: 0,
          stepProgress: expandWorkoutSteps(program).map(() => 0),
        };
        sessions.set(workout.id, workout);
      }
      let accepted = 0;
      for (const event of body.events) {
        if (events.has(event.id)) continue;
        events.set(event.id, clone(event));
        workout.stepProgress[event.stepIndex] += event.durationMs ?? 1;
        units++;
        accepted++;
      }
      const reply = {
        accepted,
        duplicate: body.events.length - accepted,
        workout: clone(workout),
        progress: progress(units),
      };
      if (hooks.afterSync) return hooks.afterSync(reply, body);
      return reply;
    }
    if (/^v2\/workouts\/[^/]+\/(finish|abort)$/.test(path)) {
      const [, , id, action] = path.split('/');
      const workout = sessions.get(id);
      if (workout.status === 'active')
        Object.assign(workout, {
          status: action === 'finish' ? 'completed' : 'aborted',
          finishedAt: body.endedAt,
          activeMs: body.activeMs,
        });
      const reply = { workout: clone(workout), progress: progress(units) };
      if (hooks.afterEnd) return hooks.afterEnd(reply, body);
      return reply;
    }
    throw new Error(`Unexpected test transport route: ${path}`);
  };
  return { calls, sessions, events, hooks, transport };
}
async function offline(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
}
async function setup() {
  const state = session(),
    storage = memoryStorage(),
    server = remote();
  const service = new WorkoutsService(state, {
    transport: server.transport,
    storageFactory: (owner) => storage.factory(owner),
  });
  await service.start('squats-5-v1');
  return { state, storage, server, service };
}

test('workout event and UUID commit locally before transport and before visible progress', () =>
  offline(async () => {
    const { storage, server, service } = await setup();
    const gate = deferred(),
      entered = deferred();
    storage.hooks.beforeSave = async (record) => {
      if (record.events.length) {
        entered.resolve();
        await gate.promise;
      }
    };
    const writing = service.recordEvent(0);
    await entered.promise;
    assert.equal(service.record.stepProgress[0], 0);
    assert.equal(server.calls.length, 0);
    gate.resolve();
    await writing;
    await service.sync();
    const sent = server.calls.find((call) => call.path.endsWith('/sync'));
    assert.equal(sent.body.events.length, 1);
    assert.match(sent.body.events[0].id, /^[a-f0-9-]{36}$/);
    assert.equal(service.record.stepProgress[0], 1);
    assert.equal(server.events.size, 1);
    service.destroy();
  }));

test('workout finalization waits for the complete event acknowledgement', () =>
  offline(async () => {
    const { server, service } = await setup();
    const gate = deferred(),
      entered = deferred();
    server.hooks.beforeSync = async () => {
      entered.resolve();
      await gate.promise;
    };
    await service.recordEvent(0);
    await entered.promise;
    const ending = service.end('abort', 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(server.calls.filter((call) => call.path.endsWith('/abort')).length, 0);
    assert.equal(service.record.pendingEnd.action, 'abort');
    gate.resolve();
    await ending;
    assert.equal(server.calls.filter((call) => call.path.endsWith('/abort')).length, 1);
    assert.equal(service.record.events.length, 0);
    assert.equal(service.record.status, 'aborted');
    assert.equal(service.activity.totalXp, 1);
    service.destroy();
  }));

test('a partial in-flight acknowledgement preserves a newer durable event', () =>
  offline(async () => {
    const { server, service } = await setup();
    const gate = deferred(),
      entered = deferred();
    let first = true;
    server.hooks.beforeSync = async () => {
      if (first) {
        first = false;
        entered.resolve();
        await gate.promise;
      }
    };
    await service.recordEvent(0);
    await entered.promise;
    const originalId = service.record.events[0].id;
    await service.recordEvent(0);
    const nextId = service.record.events.find((event) => event.id !== originalId).id;
    assert.notEqual(originalId, nextId);
    gate.resolve();
    await service.sync();
    assert.deepEqual([...server.events.keys()].sort(), [originalId, nextId].sort());
    assert.equal(service.record.events.length, 0);
    assert.equal(service.record.stepProgress[0], 2);
    assert.equal(service.activity.totalXp, 2);
    service.destroy();
  }));

test('a lost sync response retries the original UUID without duplicating activity', () =>
  offline(async () => {
    const { server, service } = await setup();
    const gate = deferred(),
      entered = deferred();
    let lose = true;
    server.hooks.beforeSync = async () => {
      entered.resolve();
      await gate.promise;
    };
    server.hooks.afterSync = (reply) => {
      if (lose) {
        lose = false;
        throw new Error('Lost response after commit');
      }
      return reply;
    };
    await service.recordEvent(0);
    await entered.promise;
    const original = service.record.events[0].id,
      sending = service.sync();
    gate.resolve();
    await assert.rejects(sending, /Lost response/);
    assert.equal(service.record.events[0].id, original);
    await service.sync();
    const batches = server.calls.filter((call) => call.path.endsWith('/sync'));
    assert.equal(batches[0].body.events[0].id, batches[1].body.events[0].id);
    assert.equal(server.events.size, 1);
    assert.equal(service.record.events.length, 0);
    assert.equal(service.activity.totalXp, 1);
    service.destroy();
  }));

test('a lost final response preserves its finalization intent for an idempotent retry', () =>
  offline(async () => {
    const { server, service } = await setup();
    await service.recordEvent(0);
    await service.sync();
    let lose = true;
    server.hooks.afterEnd = (reply) => {
      if (lose) {
        lose = false;
        throw new Error('Lost final response');
      }
      return reply;
    };
    await assert.rejects(service.end('abort', 0), /Lost final/);
    const intent = clone(service.record.pendingEnd);
    assert.equal(service.record.status, 'active');
    await service.sync();
    const ends = server.calls.filter((call) => call.path.endsWith('/abort'));
    assert.equal(ends.length, 2);
    assert.deepEqual(ends[0].body, ends[1].body);
    assert.equal(ends[0].body.endedAt, intent.endedAt);
    assert.equal(service.record.status, 'aborted');
    assert.equal(service.record.pendingEnd, undefined);
    assert.equal(service.history.length, 1);
    assert.equal(server.events.size, 1);
    service.destroy();
  }));

test('malformed acknowledgements cannot remove durable events', () =>
  offline(async () => {
    for (const corrupt of [
      (reply) => ({ ...reply, workout: { ...reply.workout, id: crypto.randomUUID() } }),
      (reply) => ({ ...reply, accepted: 0, duplicate: 0 }),
      (reply) => ({ ...reply, workout: { ...reply.workout, programId: 'pushups-5-v1' } }),
      (reply) => ({
        ...reply,
        workout: { ...reply.workout, startedAt: reply.workout.startedAt + 1 },
      }),
    ]) {
      const { server, service } = await setup();
      const gate = deferred(),
        entered = deferred();
      server.hooks.beforeSync = async () => {
        entered.resolve();
        await gate.promise;
      };
      server.hooks.afterSync = corrupt;
      await service.recordEvent(0);
      await entered.promise;
      const sending = service.sync();
      gate.resolve();
      await assert.rejects(sending, /API_RESPONSE_INVALID/);
      assert.equal(service.record.events.length, 1);
      assert.equal(service.activity, null);
      service.destroy();
    }
  }));

test('an active final reply cannot discard the pending finalization intent', () =>
  offline(async () => {
    const { server, service } = await setup();
    await service.recordEvent(0);
    await service.sync();
    server.hooks.afterEnd = (reply) => ({
      ...reply,
      workout: { ...reply.workout, status: 'active', finishedAt: null },
    });
    await assert.rejects(service.end('abort', 0), /API_RESPONSE_INVALID/);
    assert.equal(service.record.status, 'active');
    assert.equal(service.record.pendingEnd.action, 'abort');
    assert.equal(service.history.length, 0);
    server.hooks.afterEnd = null;
    await service.sync();
    assert.equal(service.record.status, 'aborted');
    assert.equal(service.record.pendingEnd, undefined);
    service.destroy();
  }));

test('an old owner response cannot mutate the newly connected profile', () =>
  offline(async () => {
    const { state, storage, server, service } = await setup();
    const gate = deferred(),
      entered = deferred();
    server.hooks.beforeSync = async () => {
      entered.resolve();
      await gate.promise;
    };
    await service.recordEvent(0);
    await entered.promise;
    const sending = service.sync();
    state.state = { profile: { id: 'bob' }, activeRound: null };
    state.store.epoch++;
    service.observeSession();
    await service.connect();
    assert.equal(service.record, null);
    gate.resolve();
    await sending;
    assert.equal(service.record, null);
    assert.equal(service.activity, null);
    assert.equal(service.history.length, 0);
    assert.equal(storage.records.get('alice').events.length, 1);
    assert.equal(storage.records.has('bob'), false);
    service.destroy();
  }));

test('owner changes during a storage acknowledgement cannot restore the previous session', () =>
  offline(async () => {
    const { state, storage, server, service } = await setup();
    const gate = deferred(),
      entered = deferred();
    storage.hooks.beforeSave = async (record, owner) => {
      if (owner === 'alice' && record.synced && !record.events.length) {
        entered.resolve();
        await gate.promise;
      }
    };
    await service.recordEvent(0);
    await entered.promise;
    const sending = service.sync();
    state.state = { profile: { id: 'bob' }, activeRound: null };
    state.store.epoch++;
    service.observeSession();
    await service.connect();
    gate.resolve();
    await sending.catch((error) => assert.equal(error.code, 'SESSION_REVOKED'));
    assert.equal(service.record, null);
    assert.equal(service.activity, null);
    assert.equal(storage.records.has('bob'), false);
    assert.equal(server.events.size, 1);
    service.destroy();
  }));

test('older activity revisions do not roll back confirmed XP', () =>
  offline(async () => {
    const state = session(),
      storage = memoryStorage();
    let response = progress(15, 2);
    const service = new WorkoutsService(state, {
      transport: async () => clone(response),
      storageFactory: (owner) => storage.factory(owner),
    });
    await service.connect();
    await service.refresh();
    response = progress(5, 1);
    await service.refresh();
    assert.equal(service.activity.totalXp, 15);
    assert.equal(service.activity.version, 2);
    service.destroy();
  }));

test('a durable storage failure stops new activity without a memory-only fallback', () =>
  offline(async () => {
    const { storage, server, service } = await setup();
    storage.hooks.beforeSave = async () => {
      throw new Error('Storage full');
    };
    await assert.rejects(service.recordEvent(0), /Storage full/);
    assert.equal(service.record.stepProgress[0], 0);
    assert.equal(service.record.events.length, 0);
    assert.equal(server.calls.length, 0);
    service.destroy();
  }));

test('a durable acknowledgement-write failure retains the original UUID and exposes fail-stop state', () =>
  offline(async () => {
    const { storage, server, service } = await setup();
    const gate = deferred(),
      entered = deferred();
    server.hooks.beforeSync = async () => {
      entered.resolve();
      await gate.promise;
    };
    storage.hooks.beforeSave = async (record) => {
      if (record.synced && record.events.length === 0) throw new WorkoutStorageError();
    };
    await service.recordEvent(0);
    await entered.promise;
    const id = service.record.events[0].id,
      sending = service.sync();
    gate.resolve();
    await assert.rejects(sending, (error) => error.code === 'LOCAL_STORAGE');
    assert.equal(server.events.size, 1);
    assert.equal(service.record.events.length, 1);
    assert.equal(service.record.events[0].id, id);
    assert.equal(service.error.code, 'LOCAL_STORAGE');
    assert.equal(service.persistenceFailed, true);
    storage.hooks.beforeSave = null;
    await service.sync();
    assert.equal(server.events.size, 1);
    assert.equal(service.record.events.length, 0);
    assert.equal(service.persistenceFailed, false);
    service.destroy();
  }));

test('a storage conflict reloads the other tab journal without sending the stale edit', () =>
  offline(async () => {
    const { storage, server, service } = await setup();
    const latest = clone(service.record);
    latest.storageRevision = 7;
    latest.stepProgress[0] = 2;
    latest.events = Array.from({ length: 2 }, () => ({
      id: crypto.randomUUID(),
      stepIndex: 0,
      occurredAt: Date.now(),
    }));
    storage.records.set('alice', clone(latest));
    storage.hooks.beforeSave = async () => {
      throw new WorkoutStorageConflict();
    };
    await assert.rejects(
      service.recordEvent(0),
      (error) => error.code === 'WORKOUT_STORAGE_CONFLICT',
    );
    assert.deepEqual(service.record, latest);
    assert.equal(service.error.code, 'WORKOUT_STORAGE_CONFLICT');
    assert.equal(server.calls.length, 0);
    service.destroy();
  }));

test('an old owner history request does not block or populate the new owner history', () =>
  offline(async () => {
    const state = session(),
      storage = memoryStorage(),
      first = deferred();
    let requests = 0;
    const service = new WorkoutsService(state, {
      storageFactory: (owner) => storage.factory(owner),
      transport: async (path) => {
        assert.match(path, /^v2\/workouts\/history\?/);
        requests++;
        if (requests === 1) return first.promise;
        return { items: [], nextCursor: null, limit: 20, serverNow: Date.now() };
      },
    });
    await service.connect();
    const previous = service.loadHistory();
    assert.equal(service.loadingHistory, true);
    state.state = { profile: { id: 'bob' }, activeRound: null };
    state.store.epoch++;
    service.observeSession();
    await service.connect();
    assert.equal(service.loadingHistory, false);
    await service.loadHistory();
    assert.equal(requests, 2);
    const now = Date.now();
    first.resolve({
      items: [
        {
          id: crypto.randomUUID(),
          programId: 'squats-5-v1',
          programVersion: 1,
          rulesVersion: 'workout-v1',
          startedAt: now - 1000,
          finishedAt: now,
          status: 'aborted',
          stepProgress: [1],
          activeMs: 1000,
        },
      ],
      nextCursor: null,
      limit: 20,
      serverNow: now,
    });
    await previous;
    assert.deepEqual(service.history, []);
    assert.equal(service.loadingHistory, false);
    service.destroy();
  }));

test('an older server clock at the same revision cannot restore yesterday activity', () =>
  offline(async () => {
    const state = session(),
      storage = memoryStorage();
    let response = progress(15, 2);
    const service = new WorkoutsService(state, {
      transport: async () => clone(response),
      storageFactory: (owner) => storage.factory(owner),
    });
    await service.connect();
    await service.refresh();
    const latest = clone(service.activity);
    response = {
      ...latest,
      serverNow: latest.serverNow - 1000,
      today: { ...progress(0, 2).today, date: '2026-10-25' },
    };
    await service.refresh();
    assert.deepEqual(service.activity, latest);
    service.destroy();
  }));

test('logout is blocked while the durable workout journal cannot be opened or read', () =>
  offline(async () => {
    for (const failedPhase of ['init', 'load']) {
      const state = session(),
        storage = memoryStorage();
      let requests = 0;
      const service = new WorkoutsService(state, {
        transport: async () => {
          requests++;
          throw new Error('Unexpected network call');
        },
        storageFactory: (owner) => {
          const journal = storage.factory(owner);
          journal[failedPhase] = async () => {
            throw new Error('Unread durable journal');
          };
          return journal;
        },
      });
      await assert.rejects(service.prepareLogout(), /Unread durable journal/);
      assert.equal(service.ready, false);
      assert.equal(requests, 0);
      service.destroy();
    }
  }));

test('adjacent fractional camera intervals at a UTC epoch cannot overlap by one millisecond', () => {
  const origin = 1793082000000.2;
  const first = quantizeHoldInterval(origin, 140425.8, 26);
  assert.ok(first);
  const second = quantizeHoldInterval(
    origin,
    140529.9,
    104.10000000000582,
    first.occurredAt + first.durationMs,
  );
  assert.ok(second);
  assert.ok(second.occurredAt >= first.occurredAt + first.durationMs);
  assert.ok(first.occurredAt >= Math.ceil(origin + (140425.8 - 26)));
  assert.ok(second.occurredAt + second.durationMs <= Math.floor(origin + 140529.9));
  assert.equal(first.durationMs + second.durationMs, 130);
});

test('quantized holds stay inside observed time, respect the remaining goal and discard invalid fragments', () => {
  for (let fraction = 0; fraction < 10; fraction++) {
    const origin = 1793082000000 + fraction / 10;
    let time = 100.1,
      previousEnd = 0,
      credited = 0;
    for (let index = 0; index < 300; index++) {
      const delta = [16.7, 33.3, 50, 66.6, 100.1][index % 5];
      time += delta;
      const remaining = 15000 - credited;
      const interval = quantizeHoldInterval(origin, time, delta, previousEnd, remaining);
      if (!interval) continue;
      assert.ok(Number.isSafeInteger(interval.occurredAt));
      assert.ok(Number.isSafeInteger(interval.durationMs));
      assert.ok(interval.occurredAt >= previousEnd);
      assert.ok(interval.occurredAt >= Math.ceil(origin + (time - delta)));
      assert.ok(interval.occurredAt + interval.durationMs <= Math.floor(origin + time));
      assert.ok(interval.durationMs <= remaining);
      credited += interval.durationMs;
      previousEnd = interval.occurredAt + interval.durationMs;
    }
    assert.ok(credited <= 15000);
    assert.ok(credited <= Math.floor(time - 100.1));
  }
  assert.equal(quantizeHoldInterval(NaN, 1, 1), null);
  assert.equal(quantizeHoldInterval(0, Infinity, 1), null);
  assert.equal(quantizeHoldInterval(0, 100, 0), null);
  assert.equal(quantizeHoldInterval(0, 100, -1), null);
  assert.equal(quantizeHoldInterval(0, 100, 0.1, 0, 0), null);
  assert.equal(quantizeHoldInterval(0, 100, 0.1), null);
});

const catalogReply = () => ({
  programs: WORKOUT_PROGRAMS,
  rulesVersion: 'workout-v1',
  serverNow: Date.now(),
});

test('online readiness rejects missing catalog/activity before replacing any durable record or sending POST', async () => {
  for (const missing of ['v2/workouts/catalog', 'v2/activity']) {
    const storage = memoryStorage(),
      state = session(),
      calls = [];
    const previous = {
      workout: { id: crypto.randomUUID(), programId: 'squats-5-v1', startedAt: Date.now() },
      status: 'aborted',
      activeMs: 0,
      synced: true,
      events: [],
      stepProgress: [0],
    };
    storage.records.set('alice', clone(previous));
    const service = new WorkoutsService(state, {
      storageFactory: storage.factory,
      transport: async (path, options) => {
        calls.push({ path, options });
        if (path === missing) throw new ApiError('NOT_FOUND', 404);
        return path.endsWith('/catalog') ? catalogReply() : progress();
      },
    });
    await assert.rejects(
      service.start('pushups-5-v1'),
      (error) => error.code === 'WORKOUT_API_UNSUPPORTED',
    );
    assert.equal(service.apiUnavailable, true);
    assert.deepEqual(storage.records.get('alice'), previous);
    assert.equal(
      calls.some((call) => call.options?.method === 'POST'),
      false,
    );
    await service.refresh();
    await service.refreshCatalog();
    assert.equal(calls.length, missing.endsWith('/catalog') ? 1 : 2);
    service.destroy();
  }
});

test('NETWORK, TIMEOUT, auth, profile and invalid JSON are distinct from unsupported routes', async () => {
  for (const failure of [
    new ApiError('NETWORK'),
    new ApiError('TIMEOUT'),
    new ApiError('DEVICE_AUTH_REQUIRED', 401),
    new ApiError('PROFILE_REQUIRED', 409),
    new ApiError('WORKOUT_NOT_FOUND', 404),
    { not: 'catalog' },
  ]) {
    const storage = memoryStorage(),
      service = new WorkoutsService(session(), {
        storageFactory: storage.factory,
        transport: async () => {
          if (failure instanceof Error) throw failure;
          return failure;
        },
      });
    await assert.rejects(service.start('squats-5-v1'));
    assert.equal(service.apiUnavailable, false);
    assert.equal(service.record, null);
    assert.equal(storage.records.size, 0);
    if (failure instanceof ApiError) assert.equal(service.availabilityError.code, failure.code);
    service.destroy();
  }
});

test('parallel readiness checks share catalog/activity and stale owner failure cannot poison a new epoch', async () => {
  const storage = memoryStorage(),
    state = session(),
    gate = deferred(),
    calls = [];
  const service = new WorkoutsService(state, {
    storageFactory: storage.factory,
    transport: async (path) => {
      calls.push(path);
      if (path.endsWith('/catalog')) await gate.promise;
      return path.endsWith('/catalog') ? catalogReply() : progress();
    },
  });
  const checking = Promise.all([
    service.ensureSupported(),
    service.ensureSupported(),
    service.refresh(),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['v2/workouts/catalog']);
  gate.resolve();
  await checking;
  assert.deepEqual(calls, ['v2/workouts/catalog', 'v2/activity']);
  assert.equal(service.apiState, 'ready');
  service.destroy();
  for (const responseLost of [true, false]) {
    const slow = deferred(),
      lateCalls = [];
    const late = new WorkoutsService(state, {
      storageFactory: storage.factory,
      transport: async (path) => {
        lateCalls.push(path);
        return slow.promise;
      },
    });
    const old = late.ensureSupported();
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.state = { profile: { id: responseLost ? 'bob' : 'carol' }, activeRound: null };
    state.store.epoch++;
    late.observeSession();
    await late.connect();
    if (responseLost) slow.reject(new ApiError('NOT_FOUND', 404));
    else slow.resolve(catalogReply());
    await assert.rejects(old, {
      code: responseLost ? 'WORKOUT_API_UNSUPPORTED' : 'SESSION_REVOKED',
    });
    assert.deepEqual(lateCalls, ['v2/workouts/catalog']);
    assert.equal(late.apiUnavailable, false);
    assert.equal(late.availabilityError, null);
    late.destroy();
  }
});

test('404 pending abort survives reload; explicit retry sends original identity and intent then permits another program', async () => {
  const storage = memoryStorage(),
    state = session(),
    server = remote(),
    calls = [];
  let missing = true;
  const transport = async (path, options) => {
    calls.push({ path, body: clone(options?.body) });
    if (missing) throw new ApiError('NOT_FOUND', 404);
    return server.transport(path, options);
  };
  const first = new WorkoutsService(state, { storageFactory: storage.factory, transport });
  await offline(async () => {
    await first.start('squats-5-v1');
    await assert.rejects(first.end('abort', 0));
  });
  const saved = clone(first.record);
  assert.equal(saved.synced, false);
  assert.equal(saved.pendingEnd.action, 'abort');
  first.destroy();
  calls.length = 0;
  const restored = new WorkoutsService(state, { storageFactory: storage.factory, transport });
  await restored.connect();
  await assert.rejects(restored.sync(), (error) => error.code === 'WORKOUT_API_UNSUPPORTED');
  for (let i = 0; i < 3; i++) {
    await restored.refresh();
    await restored.refreshCatalog();
    await assert.rejects(restored.sync());
  }
  assert.equal(
    calls.some((call) => call.body),
    false,
  );
  assert.deepEqual(restored.record, saved);
  missing = false;
  await restored.retry();
  assert.equal(restored.record.status, 'aborted');
  assert.equal(restored.unfinished, false);
  assert.deepEqual(calls.find((call) => call.path.endsWith('/sync')).body.workout, saved.workout);
  assert.deepEqual(calls.find((call) => call.path.endsWith('/abort')).body, {
    endedAt: saved.pendingEnd.endedAt,
    activeMs: saved.pendingEnd.activeMs,
  });
  await restored.start('pushups-5-v1');
  assert.notEqual(restored.record.workout.id, saved.workout.id);
  assert.equal(restored.record.workout.programId, 'pushups-5-v1');
  restored.destroy();
});

test('successful activity refresh cannot clear an unconfirmed finalization error', async () => {
  const { service, server } = await setup();
  server.hooks.afterEnd = () => {
    throw new ApiError('TIMEOUT');
  };
  await assert.rejects(service.end('abort', 0));
  const intent = clone(service.record.pendingEnd),
    error = service.error;
  await service.refresh();
  assert.equal(service.error, error);
  assert.deepEqual(service.record.pendingEnd, intent);
  server.hooks.afterEnd = null;
  await service.retry();
  assert.equal(service.record.status, 'aborted');
  assert.equal(service.error, null);
  service.destroy();
});

test('lost event response plus missing API retains UUID/pendingEnd and retry cannot duplicate XP', async () => {
  const state = session(),
    storage = memoryStorage(),
    server = remote();
  let missing = false,
    lose = true;
  const transport = async (path, options) => {
    if (missing) throw new ApiError('NOT_FOUND', 404);
    return server.transport(path, options);
  };
  const first = new WorkoutsService(state, { storageFactory: storage.factory, transport });
  await offline(async () => {
    await first.start('squats-5-v1');
    server.hooks.afterSync = (reply) => {
      if (lose) {
        lose = false;
        throw new ApiError('TIMEOUT');
      }
      return reply;
    };
    await first.recordEvent(0);
    await assert.rejects(first.sync(), (error) => error.code === 'TIMEOUT');
    assert.equal(server.events.size, 1);
    missing = true;
    await assert.rejects(
      first.end('abort', 0),
      (error) => error.code === 'WORKOUT_API_UNSUPPORTED',
    );
  });
  const saved = clone(first.record);
  first.destroy();
  const service = new WorkoutsService(state, { storageFactory: storage.factory, transport });
  await service.connect();
  assert.deepEqual(service.record, saved);
  assert.equal(
    server.calls.some((call) => call.path.endsWith('/abort')),
    false,
  );
  missing = false;
  await service.retry();
  assert.equal(service.activity.totalXp, 1);
  assert.equal(server.events.size, 1);
  assert.equal(service.record.status, 'aborted');
  assert.equal(service.record.events.length, 0);
  const deliveries = server.calls.filter(
    (call) => call.path.endsWith('/sync') && call.body.events.length,
  );
  assert.equal(deliveries[0].body.events[0].id, saved.events[0].id);
  assert.equal(deliveries.at(-1).body.events[0].id, saved.events[0].id);
  service.destroy();
});
