import test from 'node:test';
import assert from 'node:assert/strict';
import {CameraLease} from '../src/camera-lease.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
class FakeLocks {
  constructor() {this.busy = false; this.requests = 0; this.beforeDispatch = null;}
  async request(name, options, callback) {
    this.requests++;
    assert.equal(name, 'exercise-counter-camera'); assert.deepEqual(options, {ifAvailable: true});
    await this.beforeDispatch;
    if (this.busy) return callback(null);
    this.busy = true;
    try {return await callback({name});} finally {this.busy = false;}
  }
}

test('two tabs cannot hold the camera lease concurrently; release admits the other tab', async () => {
  const locks = new FakeLocks(), first = new CameraLease({locks}), second = new CameraLease({locks});
  assert.equal(await first.acquire(), true); assert.equal(await second.acquire(), false);
  assert.equal(second.reason, 'occupied'); assert.equal(first.held, true);
  first.release(); await turn();
  assert.equal(await second.acquire(), true); assert.equal(second.held, true);
  second.release(); await turn(); assert.equal(locks.busy, false);
});

test('concurrent acquire calls share one request, and acquiring an existing lease is immediate', async () => {
  const locks = new FakeLocks(), lease = new CameraLease({locks});
  const results = await Promise.all([lease.acquire(), lease.acquire(), lease.acquire()]);
  assert.deepEqual(results, [true, true, true]); assert.equal(locks.requests, 1);
  assert.equal(await lease.acquire(), true); assert.equal(locks.requests, 1);
  lease.release(); await turn();
});

test('release before the native grant settles pending calls and cannot leak a late lock', async () => {
  const locks = new FakeLocks(); let allowDispatch;
  locks.beforeDispatch = new Promise(resolve => {allowDispatch = resolve;});
  const lease = new CameraLease({locks}), pending = lease.acquire();
  lease.release(); assert.equal(await pending, false); assert.equal(lease.held, false);
  allowDispatch(); await turn(); assert.equal(locks.busy, false);
  assert.equal(await lease.acquire(), true); lease.release(); await turn();
  assert.equal(locks.busy, false);
});

test('a stale request cannot release or overwrite a newer lease', async () => {
  const locks = new FakeLocks(); let allowOld;
  locks.beforeDispatch = new Promise(resolve => {allowOld = resolve;});
  const lease = new CameraLease({locks}), old = lease.acquire(); lease.release();
  locks.beforeDispatch = null;
  assert.equal(await lease.acquire(), true); allowOld(); await old; await turn();
  assert.equal(lease.held, true); assert.equal(locks.busy, true);
  lease.release(); await turn(); assert.equal(locks.busy, false);
});

test('unsupported or failed browser lock APIs fail explicitly without a fallback lease', async () => {
  const unsupported = new CameraLease({locks: null});
  assert.equal(unsupported.supported, false); assert.equal(await unsupported.acquire(), false);
  assert.equal(unsupported.reason, 'unsupported'); unsupported.release();
  const failing = new CameraLease({locks: {request() {throw new Error('native failure');}}});
  assert.equal(failing.supported, true); assert.equal(await failing.acquire(), false);
  assert.equal(failing.reason, 'error'); assert.equal(failing.held, false);
});
