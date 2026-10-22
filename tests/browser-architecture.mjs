// Module boundaries: persistent DOM, one binding per action, camera cleanup and bad JSON.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { POSE_WORKER } from './browser-pose-fixture.mjs';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:4178';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const c = await browser.newContext({
    viewport: { width: 393, height: 852 },
    permissions: ['camera'],
    serviceWorkers: 'block',
  }),
  p = await c.newPage(),
  results = [],
  errors = [];
p.on('pageerror', (e) => errors.push(e.message));
try {
  await c.request.post(origin + '/__test/reset');
  await c.route('**/assets/vision.worker.js*', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: POSE_WORKER }),
  );
  await c.addInitScript(() => {
    window.cameraRequests = 0;
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (options) => {
      window.cameraRequests++;
      return get(options);
    };
  });
  await p.goto(origin);
  await p.locator('#quick-guest-btn').click();
  await p.waitForFunction(() =>
    document.getElementById('connection').textContent.includes('подтверждён'),
  );
  await p.evaluate(() => {
    window.originalVideo = document.getElementById('video');
    window.originalForm = document.getElementById('profile-form');
  });
  for (let i = 0; i < 3; i++)
    for (const tab of ['training', 'progress', 'competitions', 'today'])
      await p.locator(`[data-tab="${tab}"]`).click();
  assert.equal(
    await p.evaluate(
      () =>
        document.getElementById('video') === window.originalVideo &&
        document.getElementById('profile-form') === window.originalForm,
    ),
    true,
  );
  assert.equal(await p.locator('#diagnostics').count(), 1);
  assert.equal(await p.locator('.tab-content').count(), 4);
  assert.equal(await p.evaluate(() => window.cameraRequests), 0);
  results.push(
    'Repeated navigation keeps one set of screen roots, form, video and diagnostics without starting the camera',
  );
  await p.locator('#profile-toggle').click();
  await p.locator('#display-name').fill('Module test');
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  await p.waitForTimeout(600);
  assert.equal(await p.locator('#display-name').inputValue(), 'Module test');
  let saves = 0;
  p.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/(?:v2\/)?profile$/.test(r.url())) saves++;
  });
  await p.locator('#profile-form button').click();
  await p.locator('#profile-panel').waitFor({ state: 'hidden' });
  assert.equal(saves, 1);
  assert.equal(await p.locator('#profile-toggle').textContent(), 'Module test');
  results.push(
    'Focused profile edits survive background refresh and one submit sends one save after repeated navigation',
  );
  await p.locator('[data-tab="training"]').click();
  await p.locator('#start').click();
  await p.waitForFunction(() => document.getElementById('video').srcObject !== null);
  await p.evaluate(
    () => (window.originalTrack = document.getElementById('video').srcObject.getVideoTracks()[0]),
  );
  await p.locator('[data-tab="progress"]').click();
  await p.waitForFunction(
    () =>
      window.originalTrack.readyState === 'ended' &&
      document.getElementById('video').srcObject === null,
  );
  assert.equal(await p.evaluate(() => window.cameraRequests), 1);
  results.push('Leaving training releases the only video track while retaining the video element');
  await p.locator('[data-tab="training"]').click();
  await p.locator('#personal-mode').click();
  await p.locator('#start').click();
  await p.locator('#early-stop').waitFor({ state: 'visible' });
  await p.locator('#early-stop').click();
  await p.waitForFunction(() =>
    document
      .getElementById('round-result')
      .textContent.includes('Подтверждённые повторения учтены'),
  );
  assert.equal(await p.locator('#retry-round').count(), 0);
  await p.locator('#stop').click();
  await p.locator('[data-tab="progress"]').click();
  results.push(
    'An interrupted round is confirmed as interrupted without requesting a nonexistent completion button',
  );
  const record = await p.locator('#personal-record').textContent();
  await p.route(/\/api\/v2\/dashboard$/, async (route) => {
    const response = await route.fetch(),
      json = await response.json();
    return route.fulfill({ response, json: { ...json, serverNow: 'invalid' } });
  });
  await p.locator('#diagnostics>summary').click();
  await p.locator('#check-server').click();
  await p.waitForFunction(() =>
    document.getElementById('app-error').textContent.includes('страницу вместо данных'),
  );
  assert.equal(await p.locator('#personal-record').textContent(), record);
  assert.match(await p.locator('#server-result').textContent(), /API_RESPONSE_INVALID/);
  await p.unroute(/\/api\/v2\/dashboard$/);
  await p.locator('#check-server').click();
  await p.waitForFunction(() =>
    document.getElementById('connection').textContent.includes('подтверждён'),
  );
  results.push(
    'Malformed JSON is rejected before state changes, reported in diagnostics, and a healthy retry recovers',
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: results.length, results, pageErrors: errors }, null, 2));
} finally {
  await c.close();
  await browser.close();
}
