import test from 'node:test';
import assert from 'node:assert/strict';
import { PushupCounter, pushupFeatures } from '../src/algorithms/pushup.ts';
import { PlankCounter, plankFeatures } from '../src/algorithms/plank.ts';

const top = {
  valid: true,
  side: 'left',
  angle: 175,
  height: 0.95,
  bodyAngle: 178,
  kneeAngle: 178,
  horizontal: true,
  aligned: true,
  supported: true,
};
const descent = { ...top, angle: 125, height: 0.75 };
const bottom = { ...top, angle: 80, height: 0.5 };
function driver(counter, step = 40) {
  let time = 0,
    count = 0,
    heldMs = 0;
  return {
    hold(features, milliseconds) {
      let result;
      for (let i = 0; i < Math.ceil(milliseconds / step); i++) {
        time += step;
        result = counter.update(features, time);
        count += result.increment;
        heldMs += result.incrementMs;
      }
      return result;
    },
    get time() {
      return time;
    },
    get count() {
      return count;
    },
    get heldMs() {
      return heldMs;
    },
  };
}
function fullPushup(d) {
  d.hold(descent, 300);
  d.hold(bottom, 400);
  d.hold(descent, 200);
  d.hold(top, 500);
}

// Side-on landmark fixtures are defined in physical image coordinates. Resizing
// or changing aspect ratio must not change the measured elbow/body angles.
function pose(width = 1280, height = 720, points = {}) {
  const scale = Math.min(width / 8, height / 6);
  const ox = (width - 6 * scale) / 2,
    oy = (height - 3 * scale) / 2;
  const result = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
  const skeleton = {
    11: [0, 0],
    13: [0, 1.5],
    15: [0, 3],
    23: [2.4, 0.12],
    25: [4.3, 0.2],
    27: [6, 0.3],
    ...points,
  };
  for (const [id, [x, y]] of Object.entries(skeleton))
    result[id] = {
      x: (ox + x * scale) / width,
      y: (oy + y * scale) / height,
      visibility: 0.99,
      presence: 0.99,
    };
  return result;
}

test('push-up requires a complete straight-body down/up cycle and counts repeated cycles', () => {
  for (const step of [20, 40, 100]) {
    const counter = new PushupCounter(),
      d = driver(counter, step);
    assert.equal(d.hold(top, 800).ready, true);
    assert.equal(counter.phase, 'top');
    fullPushup(d);
    fullPushup(d);
    assert.equal(d.count, 2, `frame step ${step}ms`);
  }
});

test('starting at the bottom, partial movements and elbow-only gestures create no push-up', () => {
  const counter = new PushupCounter(),
    d = driver(counter);
  d.hold(bottom, 1600);
  d.hold(top, 900);
  assert.equal(d.count, 0);
  d.hold(descent, 700);
  d.hold(top, 500);
  assert.equal(d.count, 0);
  d.hold({ ...bottom, height: top.height }, 900);
  d.hold(top, 500);
  assert.equal(d.count, 0);
  fullPushup(d);
  assert.equal(d.count, 1);
});

test('bottom oscillations cannot create repeated push-ups before a full top recovery', () => {
  const d = driver(new PushupCounter());
  d.hold(top, 900);
  d.hold(descent, 300);
  d.hold(bottom, 400);
  for (let i = 0; i < 10; i++) {
    d.hold({ ...bottom, angle: 88, height: 0.54 }, 160);
    d.hold(bottom, 160);
  }
  assert.equal(d.count, 0);
  d.hold(top, 500);
  assert.equal(d.count, 1);
});

test('lost tracking, side changes and explicit pause reset cannot complete an old push-up', () => {
  for (const interruption of ['invalid', 'side', 'reset']) {
    const counter = new PushupCounter(),
      d = driver(counter);
    d.hold(top, 900);
    d.hold(descent, 300);
    d.hold(bottom, 400);
    if (interruption === 'invalid') d.hold({ valid: false, reason: 'Нет тела' }, 40);
    if (interruption === 'side') d.hold({ ...top, side: 'right' }, 40);
    if (interruption === 'reset') counter.reset('Пауза');
    d.hold(top, 1000);
    assert.equal(d.count, 0, interruption);
    fullPushup(d);
    assert.equal(d.count, 1, interruption);
  }
});

test('push-up rejects gaps, repeated timestamps, non-finite data and unsupported body posture', () => {
  for (const interruption of ['gap', 'time', 'nan', 'body']) {
    const counter = new PushupCounter(),
      d = driver(counter);
    d.hold(top, 900);
    d.hold(descent, 300);
    d.hold(bottom, 400);
    const view =
      interruption === 'gap'
        ? counter.update(top, d.time + 1000)
        : interruption === 'time'
          ? counter.update(top, d.time)
          : counter.update(
              { ...top, ...(interruption === 'nan' ? { height: NaN } : { aligned: false }) },
              d.time + 40,
            );
    assert.equal(view.increment, 0);
    assert.equal(view.ready, false);
    d.hold(top, 1000);
    assert.equal(d.count, 0);
  }
});

test('rapid push-up gestures below the minimum cycle duration do not score', () => {
  const d = driver(new PushupCounter(), 10);
  d.hold(top, 900);
  d.hold(descent, 50);
  d.hold(bottom, 250);
  d.hold(top, 350);
  assert.equal(d.count, 0);
});

test('new bodyweight features account for pixel aspect, scale and visible side', () => {
  const results = [
    [1280, 720],
    [720, 1280],
    [1920, 1080],
  ].map(([w, h]) => pushupFeatures(pose(w, h), w, h));
  assert.ok(results.every((f) => f.valid));
  for (const f of results) {
    assert.equal(f.side, 'left');
    assert.ok(Math.abs(f.angle - 180) < 1e-6);
    assert.ok(Math.abs(f.height - 1) < 1e-6);
    assert.ok(Math.abs(f.bodyAngle - results[0].bodyAngle) < 1e-6);
  }
  const p = pose();
  for (const [left, right] of [
    [11, 12],
    [13, 14],
    [15, 16],
    [23, 24],
    [25, 26],
    [27, 28],
  ])
    p[right] = { ...p[left], visibility: 0.8 };
  assert.equal(pushupFeatures(p, 1280, 720, 'right').side, 'right');
});

test('bodyweight features reject invisible, out-of-frame, non-finite, standing and bent-body poses', () => {
  assert.equal(pushupFeatures([], 1280, 720).valid, false);
  assert.equal(pushupFeatures(pose(), 0, 720).valid, false);
  for (const fault of ['invisible', 'outside', 'nan', 'confidence']) {
    const p = pose();
    if (fault === 'invisible') p[15].visibility = 0.2;
    if (fault === 'outside') p[15].x = 1.1;
    if (fault === 'nan') p[15].y = NaN;
    if (fault === 'confidence') p[15].presence = NaN;
    assert.equal(pushupFeatures(p, 1280, 720).valid, false, fault);
  }
  assert.equal(plankFeatures(pose(1280, 720, { 23: [2.4, -1] }), 1280, 720).valid, false);
  assert.equal(plankFeatures(pose(1280, 720, { 25: [3, 2] }), 1280, 720).valid, false);
  assert.equal(
    plankFeatures(
      pose(1280, 720, { 11: [0, 0], 23: [0.1, 1.8], 25: [0.15, 3.0], 27: [0.2, 4.2] }),
      1280,
      720,
    ).valid,
    false,
  );
});

test('push-up landmarks require shoulder descent as well as elbow flexion', () => {
  const width = 1280,
    height = 720;
  const start = pushupFeatures(pose(width, height), width, height);
  const lowered = pushupFeatures(
    pose(width, height, {
      11: [0, 2],
      13: [1.2, 2.5],
      15: [0, 3],
      23: [2.4, 2],
      25: [4.3, 2.1],
      27: [6, 2.2],
    }),
    width,
    height,
  );
  assert.equal(lowered.valid, true);
  assert.ok(lowered.angle < 95);
  assert.ok(start.height - lowered.height > 0.18);
  const d = driver(new PushupCounter());
  d.hold(start, 900);
  d.hold(lowered, 900);
  d.hold(start, 600);
  assert.equal(d.count, 1);
});

test('plank accumulates only monotonic valid intervals after stable entry', () => {
  const counter = new PlankCounter();
  for (const time of [0, 100, 200, 300, 400])
    assert.equal(counter.update(top, time).incrementMs, 0);
  assert.equal(counter.phase, 'holding');
  assert.equal(counter.update(top, 500).incrementMs, 100);
  assert.equal(counter.update(top, 700).incrementMs, 200);
  assert.equal(counter.update(top, 800).increment, 0);
});

test('plank fragments accumulate externally across pause without crediting the pause', () => {
  const counter = new PlankCounter(),
    d = driver(counter);
  d.hold(top, 1400);
  assert.equal(d.heldMs, 960);
  counter.reset('Пауза');
  d.hold(top, 1400);
  assert.equal(d.heldMs, 1920);
  d.hold({ valid: false, reason: 'Выровняйте корпус' }, 400);
  assert.equal(d.heldMs, 1920);
  d.hold(top, 1400);
  assert.equal(d.heldMs, 2880);
});

test('plank does not credit missing frames, side changes, duplicate/backward timestamps or invalid posture', () => {
  for (const interruption of ['gap', 'side', 'duplicate', 'backward', 'nan', 'posture']) {
    const counter = new PlankCounter(),
      d = driver(counter);
    d.hold(top, 1400);
    let view;
    if (interruption === 'gap') view = counter.update(top, d.time + 1000);
    if (interruption === 'side') view = counter.update({ ...top, side: 'right' }, d.time + 40);
    if (interruption === 'duplicate') view = counter.update(top, d.time);
    if (interruption === 'backward') view = counter.update(top, d.time - 40);
    if (interruption === 'nan') view = counter.update(top, NaN);
    if (interruption === 'posture') view = counter.update({ ...top, bodyAngle: 100 }, d.time + 40);
    assert.equal(view.incrementMs, 0, interruption);
    assert.equal(view.ready, false, interruption);
    assert.equal(d.heldMs, 960);
  }
});

test('untrusted partial features never arm a counter or increment a hold', () => {
  for (const features of [null, undefined, {}, { valid: true }, { ...top, height: Infinity }]) {
    assert.equal(new PushupCounter().update(features, 0).tracking, false);
    const view = new PlankCounter().update(features, 0);
    assert.equal(view.tracking, false);
    assert.equal(view.incrementMs, 0);
  }
});
