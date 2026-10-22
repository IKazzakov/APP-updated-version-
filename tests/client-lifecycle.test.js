import test from 'node:test';
import assert from 'node:assert/strict';
import { Lifecycle } from '../src/shared/lifecycle.ts';
import { Navigation } from '../src/app/navigation.ts';
import { RoundPersistence } from '../src/services/round-persistence.ts';

test('lifecycle removes listeners and interval callbacks and can be destroyed twice', async () => {
  const target = new EventTarget(),
    life = new Lifecycle();
  let calls = 0;
  life.listen(target, 'tick', () => calls++);
  target.dispatchEvent(new Event('tick'));
  assert.equal(calls, 1);
  life.interval(() => calls++, 5);
  life.destroy();
  life.destroy();
  await new Promise((r) => setTimeout(r, 20));
  target.dispatchEvent(new Event('tick'));
  assert.equal(calls, 1);
});
test('navigation closes the previous screen once and ignores unregistered targets', () => {
  let stopped = 0,
    destroyed = 0,
    opened = 0;
  const nav = new Navigation({ querySelectorAll: () => [] }, () => opened++);
  const today = { root: { hidden: false }, destroy: () => destroyed++ },
    training = { root: { hidden: true }, deactivate: () => stopped++, destroy: () => destroyed++ };
  nav.register('today', today);
  nav.register('training', training);
  nav.open('training');
  nav.open('training');
  assert.equal(stopped, 0);
  nav.open('progress');
  assert.equal(nav.current, 'training');
  nav.open('today');
  assert.equal(stopped, 1);
  assert.equal(training.root.hidden, true);
  assert.equal(opened, 3);
  nav.destroy();
  assert.equal(destroyed, 2);
});
test('round finish waits for local persistence and a blocked queue cannot confirm a round', async () => {
  let complete;
  const calls = [],
    storage = new Map();
  const previous = {
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
  };
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.sessionStorage = globalThis.localStorage;
  try {
    let pending = 1;
    const session = {
      state: { profile: { id: 'alice' } },
      requireState() {
        return this.state;
      },
      outboxReady: true,
      persistenceError: false,
      outbox: {
        add: () => new Promise((r) => (complete = r)),
        flush: async () => {
          calls.push('flush');
          return null;
        },
        count: async () => pending,
      },
      api: async () => {
        calls.push('finish');
        return { round: { id: 'r', status: 'completed' }, state: {} };
      },
      apply: async () => calls.push('apply'),
    };
    const p = new RoundPersistence(session),
      record = p.record({ occurredAt: '2026-10-22T00:00:00Z' }),
      result = { id: 'r', status: 'interrupted' };
    const finish = p.finish(result);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, []);
    complete('event-uuid');
    await record;
    await assert.rejects(finish, /pending/);
    assert.deepEqual(calls, ['flush']);
    pending = 0;
    p.remember(result);
    await p.finish(result);
    assert.deepEqual(calls, ['flush', 'flush', 'finish', 'apply']);
    assert.equal(p.pending(), null);
    storage.set([...storage.keys()][0] || 'invalid', 'broken');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
