import test from 'node:test';
import assert from 'node:assert/strict';
import {Outbox} from '../src/outbox.js';
import {api, ApiError} from '../src/api.js';

class MemoryStore {
  constructor(entries = []) {this.rows = new Map(entries.map(entry => [entry.event.id, structuredClone(entry)])); this.saved = false;}
  async open() {}
  async list() {return structuredClone([...this.rows.values()]);}
  async put(entry) {const existing = this.rows.get(entry.event.id); if (existing && JSON.stringify(existing.event) !== JSON.stringify(entry.event)) throw new ApiError('OUTBOX_CONFLICT', 409); this.saved = true; this.rows.set(entry.event.id, structuredClone(entry));}
  async remove(ids) {for (const id of ids) this.rows.delete(id);}
  close() {this.closed = true;}
}
const event = (id = 'repeat-1') => ({id, occurredAt: '2026-10-20T12:00:00.000Z'});
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function box(storage, options) {return new Outbox('test-user', {storage, autoRetry: false, ...options});}

test('persists before sending, confirms only after success, and excludes body/identity fields', async () => {
  const storage = new MemoryStore(), statuses = []; let release;
  const wait = new Promise(resolve => {release = resolve;});
  const outbox = box(storage, {onStatus: status => statuses.push(status), api: async (path, options) => {
    assert.equal(storage.saved, true); assert.equal(path, 'repetitions');
    assert.deepEqual(Object.keys(options.body.events[0]), ['id', 'occurredAt']);
    await wait; return {state: {today: {count: 1}}};
  }});
  await outbox.add({...event(), token: 'secret', landmarks: [{x: 1}], userId: 'someone-else'});
  assert.equal(await outbox.count(), 1); assert.ok(statuses.some(s => s.saving));
  assert.equal(statuses.some(s => s.state?.today?.count === 1), false);
  release(); const state = await outbox.flush();
  assert.equal(state.today.count, 1); assert.equal(await outbox.count(), 0);
  assert.ok(statuses.some(s => !s.saving && s.pending === 0 && s.state?.today?.count === 1));
  outbox.close();
});

test('a lost response and refresh resend the original event ID without a second reward', async () => {
  const storage = new MemoryStore(), serverIds = new Set(), sent = []; let loseResponse = true, rewards = 0;
  const server = async (_path, {body}) => {
    sent.push(body.events[0].id);
    for (const item of body.events) if (!serverIds.has(item.id)) {serverIds.add(item.id); rewards++;}
    if (loseResponse) {loseResponse = false; throw new ApiError('NETWORK');}
    return {state: {today: {count: serverIds.size}}};
  };
  const first = box(storage, {api: server}); await first.add(event());
  await assert.rejects(first.flush(), error => error.code === 'NETWORK');
  assert.equal(await first.count(), 1); first.close();
  const refreshed = box(storage, {api: server}); await refreshed.init();
  const confirmed = await refreshed.flush();
  assert.equal(confirmed.today.count, 1); assert.deepEqual(sent, ['repeat-1', 'repeat-1']);
  assert.equal(rewards, 1); assert.equal(await refreshed.count(), 0); refreshed.close();
});

test('two concurrent flush requests are serialized and include a repetition saved during the request', async () => {
  const storage = new MemoryStore(); let release, concurrent = 0, maximum = 0;
  const firstResponse = new Promise(resolve => {release = resolve;}); const sent = [];
  const outbox = box(storage, {api: async (_path, {body}) => {
    concurrent++; maximum = Math.max(maximum, concurrent); sent.push(body.events.map(item => item.id));
    if (sent.length === 1) await firstResponse;
    concurrent--; return {state: {confirmed: sent.flat().length}};
  }});
  await outbox.add(event('one')); await nextTurn();
  await outbox.add(event('two')); const flush = outbox.flush(); release();
  const state = await flush;
  assert.equal(maximum, 1); assert.deepEqual(sent.flat(), ['one', 'two']);
  assert.equal(state.confirmed, 2); assert.equal(await outbox.count(), 0); outbox.close();
});

test('a permanent rejection remains saved and visible until explicit retry', async () => {
  const storage = new MemoryStore(), statuses = []; let requests = 0;
  const outbox = box(storage, {onStatus: status => statuses.push(status), api: async () => {
    requests++; if (requests === 1) throw new ApiError('INVALID_EVENT_TIME', 400);
    return {state: {confirmed: true}};
  }});
  await outbox.add(event());
  await assert.rejects(outbox.flush(), error => error.status === 400);
  assert.equal(await outbox.count(), 1); assert.equal(statuses.at(-1).blocked, 1);
  await outbox.flush(); assert.equal(requests, 1);
  const confirmed = await outbox.flush({retryFailed: true});
  assert.equal(confirmed.confirmed, true); assert.equal(requests, 2); assert.equal(await outbox.count(), 0);
  outbox.close();
});

test('large pending queues are sent in bounded batches; separate profile stores stay isolated', async () => {
  const entries = Array.from({length: 101}, (_, index) => ({event: event(`id-${index}`), blocked: false}));
  const mine = new MemoryStore(entries), other = new MemoryStore([{event: event('other-user'), blocked: false}]), sizes = [];
  const outbox = box(mine, {api: async (_path, {body}) => {sizes.push(body.events.length); return {state: {ok: true}};}});
  await outbox.flush(); assert.deepEqual(sizes, [50, 50, 1]); assert.equal((await other.list()).length, 1); outbox.close();
});

test('local storage failure is reported instead of pretending the event was saved', async () => {
  const storage = new MemoryStore(); storage.put = async () => {throw new Error('quota details');};
  let requests = 0; const statuses = [];
  const outbox = box(storage, {onStatus: status => statuses.push(status), api: async () => {requests++;}});
  await assert.rejects(outbox.add(event()), error => error.code === 'LOCAL_STORAGE');
  assert.equal(requests, 0); assert.equal(statuses.at(-1).code, 'LOCAL_STORAGE'); outbox.close();
});

test('API uses same-origin authenticated requests and never surfaces raw response error data', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/state'); assert.equal(options.credentials, 'same-origin');
      assert.equal(Object.hasOwn(options.headers, 'Authorization'), false);
      return new Response(JSON.stringify({error: {code: 'SERVER_ERROR', message: 'SQL TOKEN https://private.example user@example.com'}}), {status: 500});
    };
    await assert.rejects(api('state'), error => error instanceof ApiError && !/SQL|TOKEN|https|@/.test(error.userMessage));
    await assert.rejects(api('https://foreign.example'), error => error.code === 'INVALID_REQUEST');
  } finally {globalThis.fetch = originalFetch;}
});
