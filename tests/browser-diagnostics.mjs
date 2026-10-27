// Real client/API and synthetic local camera; no production data or account.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { POSE_WORKER, OBSERVE_POSES } from './browser-pose-fixture.mjs';
const require = createRequire(import.meta.url),
  { chromium } = require('playwright-core');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:4178';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const results = [],
  errors = [];
let currentPage;
try {
  const c = await browser.newContext({
    viewport: { width: 393, height: 852 },
    serviceWorkers: 'block',
  });
  await c.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const p = await c.newPage();
  currentPage = p;
  p.on('pageerror', (e) => errors.push(e.message));
  await c.addInitScript(() => {
    window.cameraRequests = 0;
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => {
      window.cameraRequests++;
      return get(...args);
    };
  });
  const metadata = await c.request.get(origin + '/build-metadata.json').then((r) => r.json());
  await p.goto(origin);
  await p.locator('#quick-guest-btn').waitFor({ state: 'visible' });
  await c.setOffline(true);
  await p.locator('#diagnostics>summary').click();
  await p.locator('#copy').click();
  const text = await p.locator('#copy-fallback').inputValue(),
    report = JSON.parse(text);
  assert.deepEqual(report.build, metadata);
  assert.equal(
    metadata.sourceSha,
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  );
  assert.match(report.build.sourceSha, /^[a-f0-9]{40}$/);
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  const [major, minor, patch] = version.split('.').map(Number);
  assert.equal(report.build.version, version);
  assert.equal(report.build.versionCode, major * 10000 + minor * 100 + patch);
  assert.equal(report.apiBaseUrl, origin + '/api');
  assert.equal(report.version, metadata.version);
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), text);
  assert.equal(await p.evaluate(() => window.cameraRequests), 0);
  await p.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error('blocked');
        },
      },
    });
    document.execCommand = () => false;
  });
  await p.locator('#clear-activity').click();
  assert.deepEqual(JSON.parse(await p.locator('#copy-fallback').inputValue()).build, metadata);
  await p.locator('#copy').click();
  assert.match(await p.locator('#copy-status').textContent(), /вручную/);
  assert.deepEqual(JSON.parse(await p.locator('#copy-fallback').inputValue()).build, metadata);
  assert.equal(
    JSON.parse(await p.locator('#copy-fallback').inputValue()).apiBaseUrl,
    origin + '/api',
  );
  results.push(
    'Offline before guest/camera: clipboard and manual report contain the actual embedded build and current safe API; clearing the journal retains metadata',
  );
  await c.close();

  if (process.env.DIAGNOSTICS_COPY_ONLY !== '1') {
    for (const viewport of [
      { width: 393, height: 852 },
      { width: 1440, height: 1000 },
    ]) {
      const c = await browser.newContext({
          viewport,
          permissions: ['camera'],
          serviceWorkers: 'block',
        }),
        p = await c.newPage();
      c.setDefaultTimeout(20000);
      currentPage = p;
      p.on('pageerror', (e) => errors.push(e.message));
      await c.addInitScript(OBSERVE_POSES);
      await c.route('**/assets/vision.worker.js*', (r) =>
        r.fulfill({ contentType: 'text/javascript', body: POSE_WORKER }),
      );
      await p.goto(origin);
      await p.locator('#test-username-input').fill('PRIVATE_TEST_NAME');
      await p.locator('#test-login-btn').click();
      await p.waitForFunction(() =>
        document.getElementById('connection').textContent.includes('подтверждён'),
      );
      for (const tab of ['today', 'training', 'competitions', 'progress']) {
        await p.locator(`[data-tab="${tab}"]`).click();
        assert.equal(await p.locator('#diagnostics').count(), 1);
        const box = await p.locator('#diagnostics').boundingBox();
        assert.ok(Math.abs(box.y + box.height - viewport.height) < 3);
        assert.equal(await p.locator('.tab-content #check-server').count(), 0);
      }
      await p.locator('#diagnostics>summary').click();
      await p.locator('#check-server').click();
      await p.waitForFunction(() =>
        document.getElementById('server-result').textContent.includes('OK'),
      );
      assert.ok(
        await p
          .locator('#activity-list')
          .textContent()
          .then((t) => t.includes('Ответ сервера') && t.includes('Проверка сервера')),
      );
      await p.locator('#copy').click();
      const report = JSON.parse(await p.locator('#copy-fallback').inputValue());
      assert.ok(report.activity.some((e) => e.event === 'ui.tab'));
      assert.ok(report.activity.some((e) => e.route === 'dashboard'));
      assert.equal(JSON.stringify(report).includes('PRIVATE_TEST_NAME'), false);
      const secret = await p.evaluate(() => {
        const key = Object.keys(localStorage).find((k) => k.startsWith('movement.device-session.'));
        return key ? localStorage.getItem(key) : null;
      });
      if (secret) assert.equal(JSON.stringify(report).includes(secret), false);
      await p.screenshot({ path: `work/diagnostics-${viewport.width}.png` });
      results.push(
        `Диагностика ${viewport.width}px: закрепление на всех экранах, сервер внутри, журнал и безопасный отчёт`,
      );
      await p.locator('#diagnostics>summary').click();
      await p.locator('[data-tab="training"]').click();
      await p.locator('#start').click();
      await c.request.post(origin + '/__test/pose', { data: { name: 'stand' } });
      await p.waitForFunction(
        () => document.getElementById('state').textContent === 'Идёт подсчёт',
      );
      for (const name of ['down', 'bottom', 'down', 'stand']) {
        await c.request.post(origin + '/__test/pose', { data: { name } });
        await p.waitForFunction((expected) => window.testPoseFrames.name === expected, name);
        await new Promise((r) => setTimeout(r, 650));
      }
      await p.waitForFunction(() => document.getElementById('daily-number').textContent === '1');
      await p.locator('#stop').click();
      await p.locator('#diagnostics>summary').click();
      await p.locator('#copy').click();
      const saved = JSON.parse(await p.locator('#copy-fallback').inputValue());
      assert.ok(saved.activity.some((e) => e.event === 'queue.confirmed'));
      assert.ok(saved.activity.some((e) => e.event === 'training.changed'));
      results.push(
        `Тренировка ${viewport.width}px: локальная запись, компактная отправка и подтверждение видны в журнале`,
      );
      await c.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: results.length, results, pageErrors: errors }, null, 2));
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    console.error(await currentPage.locator('body').innerText());
    await currentPage.screenshot({ path: 'work/diagnostics-failure.png' });
  }
  throw error;
} finally {
  await browser.close();
}
