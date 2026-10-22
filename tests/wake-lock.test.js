import test from 'node:test';
import assert from 'node:assert/strict';
import {ScreenWakeLock} from '../src/wake-lock.js';

function documentFixture(t, visibilityState = 'visible') {
  propertyFixture(t, globalThis, 'document', {visibilityState, addEventListener() {}, removeEventListener() {}});
}
function propertyFixture(t, object, name, value) {
  const previous = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, {configurable: true, value});
  t.after(() => previous ? Object.defineProperty(object, name, previous) : delete object[name]);
}

test('Android keeps the workout screen awake even without the Web Wake Lock API', async t => {
  documentFixture(t);
  const calls = [];
  const lock = new ScreenWakeLock({native: true, nativeScreen: {setEnabled: async value => calls.push(value.enabled)}});
  assert.equal(lock.isSupported, true);
  assert.equal(await lock.acquire(), true);
  lock.release();
  assert.deepEqual(calls, [true, false]);
  assert.equal(lock.desired, false);
});

test('a late Android wake confirmation cannot keep the screen on after camera stop', async t => {
  documentFixture(t);
  let confirm;
  const calls = [];
  const lock = new ScreenWakeLock({native: true, nativeScreen: {setEnabled: value => {calls.push(value.enabled); return value.enabled ? new Promise(resolve => {confirm = resolve;}) : Promise.resolve();}}});
  const pending = lock.acquire();
  lock.release();
  confirm();
  assert.equal(await pending, false);
  assert.equal(calls.at(-1), false);
});

test('a background Android view cannot acquire the screen lock', async t => {
  documentFixture(t, 'hidden');
  let calls = 0;
  const lock = new ScreenWakeLock({native: true, nativeScreen: {setEnabled: async () => {calls++;}}});
  assert.equal(await lock.acquire(), false);
  assert.equal(calls, 0);
  lock.destroy();
});

test('a late browser lock is released if pause occurs before the permission resolves', async t => {
  documentFixture(t);
  let confirm, released = 0;
  propertyFixture(t, globalThis.navigator, 'wakeLock', {request: () => new Promise(resolve => {confirm = resolve;})});
  const lock = new ScreenWakeLock({native: false});
  const pending = lock.acquire();
  lock.release();
  confirm({release: async () => {released++;}, addEventListener() {}});
  assert.equal(await pending, false);
  assert.equal(released, 1);
  assert.equal(lock.sentinel, null);
});
