import test from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostics } from '../src/diagnostics.js';
import { VERSION, RULES_VERSION } from '../src/config.js';

test('support report includes technical versions before camera start', () => {
  const report = new Diagnostics().report();
  assert.equal(report.version, VERSION);
  assert.equal(report.rulesVersion, RULES_VERSION);
  assert.equal(report.vision, '0.10.32');
  assert.equal(report.report, 'squat-support-v1');
  assert.deepEqual(report.errors, []);
});
test('only allowed camera and recognition metadata is copied', () => {
  const diagnostics = new Diagnostics();
  diagnostics.update({
    mode: 'competition',
    cameraOn: true,
    facing: 'user',
    modelStatus: 'Готово',
    ready: true,
    paused: false,
    phase: 'bottom',
    roundStatus: 'running',
    resolution: '720 × 1280 @ 30 fps',
    fps: 15.25,
    inferenceMs: 48.31,
    landmarks: [{ x: 0.1, y: 0.2 }],
    token: 'ACCESS_SECRET',
    invitationToken: 'INVITATION_SECRET',
    name: 'PRIVATE_NAME',
    count: 90,
    email: 'PRIVATE_EMAIL',
    roundId: 'PRIVATE_ROUND',
    hint: 'PRIVATE_HINT',
    reason: 'PRIVATE_REASON',
  });
  const report = diagnostics.report(),
    text = diagnostics.reportText();
  assert.equal(report.camera, 'Включена');
  assert.equal(report.model, 'Pose Landmarker Full');
  assert.equal(report.fps, 15.3);
  assert.equal(report.inferenceMs, 48.3);
  assert.equal(report.resolution, '720 × 1280 @ 30 fps');
  assert.equal(report.mode, 'competition');
  for (const privateValue of [
    'ACCESS_SECRET',
    'INVITATION_SECRET',
    'PRIVATE_',
    'landmarks',
    'count',
    'roundId',
    'email',
  ])
    assert.equal(text.includes(privateValue), false, privateValue);
});
test('untrusted exception messages and arbitrary status strings never enter the report', () => {
  const diagnostics = new Diagnostics();
  diagnostics.error(
    new Error('https://private.example/#invite=TOKEN user@example.com coordinates=0.1'),
  );
  diagnostics.error({ code: 'SERVER_ERROR', message: 'PRIVATE_NAME' });
  diagnostics.error({ name: 'NotAllowedError' });
  diagnostics.update({
    mode: 'PRIVATE_NAME',
    phase: 'user@example.com',
    modelStatus: 'https://private.example',
    resolution: 'https://private.example',
    fps: Infinity,
    inferenceMs: -1,
  });
  const report = diagnostics.report(),
    text = diagnostics.reportText();
  assert.deepEqual(
    report.errors.map((error) => error.code),
    ['UNKNOWN_ERROR', 'SERVER_ERROR', 'CAMERA_DENIED'],
  );
  assert.equal(report.mode, null);
  assert.equal(report.phase, null);
  assert.equal(report.resolution, null);
  assert.equal(report.fps, null);
  assert.equal(report.inferenceMs, null);
  assert.equal(/private\.example|TOKEN|@|PRIVATE_NAME|coordinates/.test(text), false);
});
test('diagnostic journal stays in memory, is bounded, and snapshots cannot mutate it', () => {
  const diagnostics = new Diagnostics();
  for (let index = 0; index < 30; index++) diagnostics.error('NETWORK');
  const report = diagnostics.report();
  assert.equal(report.errors.length, 12);
  report.errors[0].code = 'PRIVATE_NAME';
  assert.equal(diagnostics.report().errors[0].code, 'NETWORK');
  assert.ok(diagnostics.reportText().length < 100000);
});
test('model statuses distinguish stopped, loading and failed loading', () => {
  const d = new Diagnostics();
  for (const [modelStatus, expected] of [
    ['Не загружена', 'Не запущена'],
    ['Загрузка модели · файл', 'Загрузка модели'],
    ['Ошибка загрузки / обработки', 'Ошибка загрузки'],
    ['Готово', 'Готово'],
  ]) {
    d.update({ modelStatus });
    assert.equal(d.report().modelStatus, expected);
  }
});
test('start diagnostics retain bounded technical outcomes and latency without identifiers', () => {
  const d = new Diagnostics();
  d.startEvent('requesting');
  d.startEvent('PRIVATE_NAME', 200);
  d.startEvent('confirmed', 1820);
  d.error('ROUND_START_FAILED');
  assert.deepEqual(
    d.report().startEvents.map((e) => e.status),
    ['requesting', 'confirmed'],
  );
  assert.equal(d.report().startEvents[1].requestMs, 1820);
  assert.equal(d.report().errors[0].code, 'ROUND_START_FAILED');
  assert.equal(d.reportText().includes('PRIVATE_NAME'), false);
  for (let i = 0; i < 15; i++) d.startEvent('rejected', Infinity);
  assert.equal(d.report().startEvents.length, 8);
  assert.equal(d.report().startEvents[0].requestMs, null);
});

test('copy report has immutable client build and the current safe API address before auth/camera, offline', () => {
  let api = 'https://api.example/api?token=PRIVATE#PRIVATE';
  const build = { version: VERSION, versionCode: 20600, sourceSha: 'a'.repeat(40), dirty: false };
  const d = new Diagnostics({ getApiBaseUrl: () => api, build });
  build.sourceSha = 'PRIVATE';
  let report = JSON.parse(d.reportText());
  assert.deepEqual(report.build, {
    version: VERSION,
    versionCode: 20600,
    sourceSha: 'a'.repeat(40),
    dirty: false,
  });
  assert.equal(report.apiBaseUrl, 'https://api.example/api');
  assert.equal(d.reportText().includes('PRIVATE'), false);
  api = 'https://next.example/path/api?secret=PRIVATE';
  d.update({ build: { sourceSha: 'PRIVATE' }, apiBaseUrl: 'PRIVATE' });
  report = d.report();
  assert.equal(report.apiBaseUrl, 'https://next.example/path/api');
  assert.equal(report.build.sourceSha, 'a'.repeat(40));
  api = 'https://PRIVATE:PRIVATE@example.com/api';
  assert.equal(d.report().apiBaseUrl, null);
  api = 'javascript:PRIVATE';
  assert.equal(d.report().apiBaseUrl, null);
  d.errors = [];
  assert.equal(d.report().build.versionCode, 20600);
});
test('dev build metadata is explicitly unknown and relative web API is resolved safely', async () => {
  const { safeApiBaseUrl, versionCodeFor } = await import('../src/shared/build.ts');
  const d = new Diagnostics();
  assert.equal(d.report().build.sourceSha, null);
  assert.equal(d.report().build.dirty, null);
  assert.equal(safeApiBaseUrl('/api', 'https://web.example'), 'https://web.example/api');
  assert.equal(safeApiBaseUrl('/api'), null);
  assert.equal(safeApiBaseUrl('data:text/plain,PRIVATE'), null);
  assert.equal(versionCodeFor('2.6.0'), 20600);
});
