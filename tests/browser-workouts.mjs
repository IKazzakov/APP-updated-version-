// TEST ONLY: synthetic local pose observations, real device auth/API/SQLite.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:4178';
await mkdir('work/browser-workouts', { recursive: true });

// These poses run through production feature extraction and counters. No
// workout service, queue, acknowledgement or server response is mocked here.
const WORKOUT_WORKER = `self.onmessage=async({data})=>{
  if(data.type==='load'){postMessage({type:'ready',delegate:'CPU'});return;}
  if(data.type!=='frame')return;
  const width=data.bitmap.width,height=data.bitmap.height;
  data.bitmap.close();
  const phase=await fetch('/__test/workout-pose',{cache:'no-store'}).then(r=>r.json()).then(p=>p.name);
  let points=[];
  if(phase!=='missing'){
    points=Array.from({length:33},()=>({x:.5,y:.5,visibility:0,presence:0}));
    if(phase.startsWith('squat-')){
      const pose=phase==='squat-bottom'?[[.43,.38],[.45,.65],[.60,.66],[.5,.85]]:[[.5,.15],[.5,.35],[.5,.60],[.5,.85]];
      for(const side of [[11,23,25,27,29,31],[12,24,26,28,30,32]])side.forEach((id,i)=>{
        const p=pose[Math.min(i,3)];points[id]={x:p[0]+(i>3?.01:0),y:p[1]+(i>3?.01:0),visibility:side[0]===11?.98:.8,presence:1};
      });
    }else{
      const scale=Math.min(width/8,height/6),ox=(width-6*scale)/2,oy=(height-3*scale)/2;
      const skeleton=phase==='push-bottom'?{11:[0,2],13:[1.2,2.5],15:[0,3],23:[2.4,2],25:[4.3,2.1],27:[6,2.2]}:{11:[0,0],13:[0,1.5],15:[0,3],23:[2.4,.12],25:[4.3,.2],27:[6,.3]};
      for(const [id,[x,y]] of Object.entries(skeleton))points[id]={x:(ox+x*scale)/width,y:(oy+y*scale)/height,visibility:.99,presence:.99};
    }
  }
  postMessage({type:'result',epoch:data.epoch,timestamp:data.timestamp,ms:2,inputWidth:width,inputHeight:height,landmarks:points.length?[points]:[],testWorkoutPose:phase});
};`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const contexts = [],
  errors = [],
  results = [],
  requestErrors = [];
async function actor({ unsupported = false } = {}) {
  const c = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    permissions: ['camera'],
    serviceWorkers: 'block',
  });
  contexts.push(c);
  c.setDefaultTimeout(25000);
  const fixture = { name: 'squat-top' };
  const support = { missing: unsupported, posts: [] };
  await c.route(/\/api\/v2\/(workouts(?:\/|\?)|activity)/, async (route) => {
    if (route.request().method() === 'POST')
      support.posts.push({ url: route.request().url(), body: route.request().postDataJSON() });
    if (support.missing)
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'NOT_FOUND' } }),
      });
    await route.continue();
  });
  await c.route('**/__test/workout-pose', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(fixture),
    }),
  );
  await c.route('**/assets/vision.worker.js*', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: WORKOUT_WORKER,
    }),
  );
  await c.addInitScript(() => {
    const OriginalWorker = window.Worker;
    window.testWorkoutPose = null;
    window.cameraRequests = 0;
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          if (data.testWorkoutPose) window.testWorkoutPose = data.testWorkoutPose;
        });
      }
    };
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (options) => {
      window.cameraRequests++;
      return get(options);
    };
  });
  const p = await c.newPage();
  p.on('pageerror', (error) => errors.push(error.message));
  p.on('response', async (response) => {
    if (response.status() >= 400 && /\/api\/v2\/(workouts|activity)/.test(response.url())) {
      const value = await response.json().catch(() => null);
      requestErrors.push({ status: response.status(), code: value?.error?.code });
    }
  });
  await p.goto(origin);
  await p.locator('#quick-guest-btn').click();
  await p.locator('#tab-today [data-program-id]').first().waitFor({ state: 'visible' });
  if (!unsupported) await p.locator('[data-workout-xp]').waitFor({ state: 'visible' });
  return { c, p, fixture, support };
}
async function api(p, path) {
  return p.evaluate(async (path) => {
    const key = Object.keys(localStorage).find((name) =>
      name.startsWith('movement.device-session.'),
    );
    const response = await fetch('/api/v2/' + path, {
      cache: 'no-store',
      headers: key ? { Authorization: 'Bearer ' + localStorage.getItem(key) } : {},
    });
    return { status: response.status, body: await response.json() };
  }, path);
}
async function poll(read, predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error('Timed out: ' + description + '; last=' + JSON.stringify(value));
}
async function history(p) {
  const reply = await api(p, 'workouts/history?limit=100');
  assert.equal(reply.status, 200);
  return reply.body.items;
}
async function activity(p) {
  const reply = await api(p, 'activity');
  assert.equal(reply.status, 200);
  return reply.body;
}
async function count(p) {
  const value = (await p.locator('[data-workout-count]').textContent()).trim().replace(',', '.');
  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}
async function pose(a, name, duration = 0) {
  a.fixture.name = name;
  await a.p.waitForFunction((name) => window.testWorkoutPose === name, name);
  if (duration) await a.p.waitForTimeout(duration);
}
async function start(a, programId, initial = 'squat-top') {
  a.fixture.name = initial;
  const beforeXp = (await activity(a.p)).totalXp;
  await a.p.locator('[data-tab="today"]').click();
  await a.p.locator(`#tab-today [data-program-id="${programId}"]`).click();
  await a.p.locator('[data-workout-start]').click();
  await a.p.waitForFunction(() => !!document.querySelector('[data-workout-video]')?.srcObject);
  await pose(a, initial);
  await a.p.locator('[data-workout-stage="countdown"]').waitFor({ state: 'visible' });
  assert.equal(
    (await activity(a.p)).totalXp,
    beforeXp,
    'pose preparation and countdown cannot award activity',
  );
  await a.p.locator('[data-workout-stage="running"]').waitFor({ state: 'visible' });
  await pose(a, initial, 900);
}
async function repetitions(a, exercise, target) {
  const top = exercise === 'squat' ? 'squat-top' : 'push-top';
  const bottom = exercise === 'squat' ? 'squat-bottom' : 'push-bottom';
  a.fixture.name = top;
  await a.p.locator('[data-workout-stage="running"]').waitFor({ state: 'visible' });
  const initialStep = await a.p.locator('[data-workout-step]').textContent();
  const advanced = async () =>
    (await a.p.locator('[data-workout-step]').textContent()) !== initialStep ||
    (await a.p.locator('[data-workout-count]').textContent()).includes('✓');
  await pose(a, top, 900);
  for (let goal = 1; goal <= target; goal++) {
    for (
      let attempt = 0;
      attempt < 3 && !(await advanced()) && (await count(a.p)) < goal;
      attempt++
    ) {
      await pose(a, bottom, 900);
      await pose(a, top, 900);
    }
    if (goal === target && (await advanced())) return;
    assert.equal(await count(a.p), goal, `${exercise} count ${goal}`);
  }
}
async function closed(a, programId, status = 'completed') {
  return poll(
    () => history(a.p),
    (items) => items.some((item) => item.programId === programId && item.status === status),
    programId + ' confirmed ' + status,
  ).then((items) => items.find((item) => item.programId === programId && item.status === status));
}

async function recovery() {
  const a = await actor({ unsupported: true });
  await a.p.locator('#tab-today [data-workout-check]').waitFor({ state: 'visible' });
  assert.equal(await a.p.evaluate(() => window.cameraRequests), 0);
  assert.ok(
    await a.p
      .locator('#tab-today [data-program-id]')
      .evaluateAll((buttons) => buttons.every((b) => b.disabled)),
  );
  const owner = (await api(a.p, 'dashboard')).body.profile.id;
  const read = () =>
    a.p.evaluate(
      (owner) =>
        new Promise((resolve, reject) => {
          const r = indexedDB.open('movement-workouts-v1');
          r.onsuccess = () => {
            const db = r.result,
              tx = db.transaction('sessions', 'readonly'),
              get = tx.objectStore('sessions').get(owner);
            get.onsuccess = () => resolve(get.result?.record ?? null);
            tx.oncomplete = () => db.close();
            tx.onerror = () => reject(Error('IDB'));
          };
        }),
      owner,
    );
  assert.equal(await read(), null);
  const now = Date.now();
  const record = {
    storageRevision: 1,
    workout: { id: crypto.randomUUID(), programId: 'squats-5-v1', startedAt: now - 2000 },
    stepProgress: [0],
    events: [],
    activeMs: 0,
    status: 'active',
    synced: false,
    pendingEnd: { action: 'abort', endedAt: now - 1000, activeMs: 0 },
  };
  await a.p.evaluate(
    ({ owner, record }) =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('movement-workouts-v1');
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction('sessions', 'readwrite');
          tx.objectStore('sessions').put({ owner, record });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(Error('IDB'));
        };
      }),
    { owner, record },
  );
  await a.p.reload();
  await a.p.locator('[data-tab="training"]').click();
  const host = a.p.locator('[data-workout-runner]');
  await host.locator('[data-workout-check]').waitFor({ state: 'visible' });
  assert.match(await host.locator('[data-workout-status]').textContent(), /несовместим/i);
  assert.equal(await host.locator('[data-workout-start]').isVisible(), false);
  assert.deepEqual(await read(), record);
  for (const tab of ['today', 'progress', 'training', 'today', 'training'])
    await a.p.locator(`[data-tab="${tab}"]`).click();
  assert.equal(a.support.posts.length, 0, 'known 404 must never trigger automatic sync POST');
  assert.equal(await a.p.evaluate(() => window.cameraRequests), 0);
  a.support.missing = false;
  await host.locator('[data-workout-check]').click();
  await host.locator('[data-workout-result]').waitFor({ state: 'visible' });
  assert.equal((await read()).status, 'aborted');
  const sync = a.support.posts.find((r) => r.url.endsWith('/sync')),
    end = a.support.posts.find((r) => r.url.endsWith('/abort'));
  assert.equal(sync.body.workout.id, record.workout.id);
  assert.deepEqual(end.body, {
    endedAt: record.pendingEnd.endedAt,
    activeMs: record.pendingEnd.activeMs,
  });
  assert.equal(await a.p.evaluate(() => window.cameraRequests), 0, 'retry must not start a camera');
  await host.locator('[data-workout-new]').click();
  await a.p.locator('#tab-today [data-program-id="pushups-5-v1"]').click();
  await host.locator('[data-workout-start]').click();
  await a.p.waitForFunction(() => !!document.querySelector('[data-workout-video]').srcObject);
  assert.equal((await read()).workout.programId, 'pushups-5-v1');
  assert.equal(await a.p.evaluate(() => window.cameraRequests), 1);
  await host.locator('[data-workout-stop]').click();
  await host.locator('[data-workout-result]').waitFor({ state: 'visible' });
  assert.equal((await read()).status, 'aborted');
  await a.c.close();
  results.push(
    '404 prevents new records/camera; pending abort survives real IndexedDB reload and navigation without POST; explicit retry preserves identity/intent and unlocks another program without reload',
  );
}

try {
  const reset = await fetch(origin + '/__test/reset', { method: 'POST' });
  assert.equal(reset.status, 200);
  if (process.env.WORKOUT_RECOVERY_ONLY !== '1') {
    const a = await actor();
    const ids = await a.p
      .locator('#tab-today [data-program-id]')
      .evaluateAll((cards) => cards.map((card) => card.dataset.programId));
    assert.deepEqual(ids, ['squats-5-v1', 'pushups-5-v1', 'plank-15-v1', 'starter-circuit-v1']);
    assert.equal(await a.p.locator('.tab-content').count(), 4);
    assert.equal(await a.p.evaluate(() => window.cameraRequests), 0);
    await a.p.locator('[data-workout-xp]').waitFor({ state: 'visible' });
    await a.p.screenshot({ path: 'work/browser-workouts/today.png', fullPage: true });
    assert.equal(
      await a.p
        .getByRole('button', {
          name: /создать тренировку|добавить упражнение|пропустить упражнение/i,
        })
        .count(),
      0,
    );
    results.push(
      'Каталог содержит четыре авторские программы; прежние четыре раздела сохранены, камера сама не запускается, конструктора и пропуска упражнения нет',
    );

    await start(a, 'squats-5-v1');
    await a.p.screenshot({ path: 'work/browser-workouts/program.png', fullPage: true });
    await repetitions(a, 'squat', 4);
    await poll(
      () => activity(a.p),
      (value) => value.today.squats === 4,
      'four acknowledged squats',
    );
    let releaseLast,
      lastRequested,
      holding = true,
      finals = 0,
      loseFinal = true;
    const held = new Promise((resolve) => (releaseLast = resolve));
    const requested = new Promise((resolve) => (lastRequested = resolve));
    const syncRoute = /\/api\/v2\/workouts\/sync$/;
    const endRoute = /\/api\/v2\/workouts\/[^/]+\/finish$/;
    await a.p.route(syncRoute, async (route) => {
      if (holding && route.request().postDataJSON().events.length) {
        lastRequested();
        await held;
      }
      await route.continue();
    });
    await a.p.route(endRoute, async (route) => {
      finals++;
      const response = await route.fetch();
      if (loseFinal) {
        loseFinal = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'SERVER_ERROR' } }),
        });
      } else await route.fulfill({ response });
    });
    try {
      await pose(a, 'squat-bottom', 900);
      await pose(a, 'squat-top', 900);
      await requested;
      assert.match(await a.p.locator('[data-workout-count]').textContent(), /✓|5/);
      await a.p.waitForTimeout(250);
      assert.equal(finals, 0, 'finish must wait for the last sync acknowledgement');
      holding = false;
      releaseLast();
      await poll(
        async () => finals,
        (value) => value === 1,
        'first finalization request',
      );
      await a.p.locator('[data-workout-retry]').waitFor({ state: 'visible' });
      assert.equal(finals, 1);
      await a.p.locator('[data-workout-retry]').click();
      // Server history already contains the first finish whose response was lost.
      // Await the client's durable end ack, including the readiness GETs on retry.
      await a.p.locator('[data-workout-result]').waitFor({ state: 'visible' });
      const saved = await closed(a, 'squats-5-v1');
      assert.deepEqual(saved.stepProgress, [5]);
      assert.equal(finals, 2);
      assert.equal((await history(a.p)).filter((item) => item.id === saved.id).length, 1);
      assert.equal((await activity(a.p)).totalXp, 5);
      await a.p.screenshot({ path: 'work/browser-workouts/result.png', fullPage: true });
    } finally {
      holding = false;
      releaseLast();
      await a.p.unroute(syncRoute);
      await a.p.unroute(endRoute);
    }
    results.push(
      'Пять приседаний проходят через камеру и IndexedDB; finish ждёт последнего ack, потерянный ответ повторяется без дублей результата и XP',
    );

    await start(a, 'plank-15-v1', 'push-top');
    await poll(
      () => count(a.p),
      (value) => value >= 5,
      'five seconds plank',
      20000,
    );
    await a.p.locator('[data-workout-pause]').click();
    await a.p.waitForTimeout(250);
    const paused = await count(a.p);
    await a.p.waitForTimeout(1600);
    assert.equal(await count(a.p), paused);
    await a.p.locator('[data-workout-start]').click();
    await poll(
      () => count(a.p),
      (value) => value >= 8,
      'plank resumed without reset',
      15000,
    );
    await pose(a, 'missing', 350);
    const missing = await count(a.p);
    await a.p.waitForTimeout(1000);
    assert.equal(await count(a.p), missing);
    a.fixture.name = 'push-top';
    await a.p.reload();
    await a.p.locator('[data-tab="training"]').click();
    await a.p.locator('[data-workout-start]').waitFor({ state: 'visible' });
    assert.equal(
      await a.p.evaluate(() => document.querySelector('[data-workout-video]').srcObject),
      null,
    );
    assert.equal(await a.p.evaluate(() => window.cameraRequests), 0);
    const restored = await count(a.p);
    assert.ok(restored >= 8 && restored < 15);
    await a.p.waitForTimeout(1000);
    assert.equal(await count(a.p), restored);
    await a.p.locator('[data-workout-start]').click();
    const plank = await closed(a, 'plank-15-v1');
    assert.deepEqual(plank.stepProgress, [15000]);
    assert.equal((await activity(a.p)).totalXp, 8);
    results.push(
      'Планка накапливает 15 секунд через паузу, потерю позы и reload; невидимые/закрытые интервалы не начисляются, камера возобновляется только действием',
    );

    await start(a, 'pushups-5-v1', 'push-top');
    await repetitions(a, 'pushup', 5);
    const pushups = await closed(a, 'pushups-5-v1');
    assert.deepEqual(pushups.stepProgress, [5]);
    const afterPushups = await activity(a.p);
    assert.equal(afterPushups.totalXp, 13);
    assert.equal(afterPushups.today.completed, true);
    assert.equal(afterPushups.streak.current, 1);
    results.push(
      'Пять отжиманий распознаются как полные циклы; работа разных программ суммируется в XP и дне серии',
    );

    await start(a, 'starter-circuit-v1', 'push-top');
    await repetitions(a, 'pushup', 5);
    a.fixture.name = 'squat-top';
    await a.p.locator('[data-workout-rest-skip]').waitFor({ state: 'visible' });
    await a.p.waitForTimeout(1200);
    assert.equal(await count(a.p), 0);
    await a.p.locator('[data-workout-rest-skip]').waitFor({ state: 'hidden' });
    await repetitions(a, 'squat', 5);
    a.fixture.name = 'push-top';
    await a.p.locator('[data-workout-rest-skip]').waitFor({ state: 'visible' });
    await a.p.locator('[data-workout-rest-skip]').waitFor({ state: 'hidden' });
    const circuit = await closed(a, 'starter-circuit-v1');
    assert.deepEqual(circuit.stepProgress, [5, 5, 15000]);
    assert.equal((await activity(a.p)).totalXp, 26);
    assert.equal((await history(a.p)).length, 4);
    results.push(
      'Круг проходит в заданном порядке: пять отжиманий, пять приседаний, 15 секунд планки; отдых не создаёт повторы и итог подтверждает все цели',
    );

    await start(a, 'squats-5-v1');
    await repetitions(a, 'squat', 1);
    await a.p.locator('[data-workout-stop]').click();
    await poll(
      () => history(a.p),
      (items) =>
        items.some((item) => item.programId === 'squats-5-v1' && item.status === 'aborted'),
      'partial result',
    );
    const partial = (await history(a.p)).find((item) => item.status === 'aborted');
    assert.deepEqual(partial.stepProgress, [1]);
    assert.equal((await activity(a.p)).totalXp, 27);
    await a.p.locator('[data-tab="progress"]').click();
    await a.p.locator('[data-workout-history]').waitFor({ state: 'visible' });
    assert.match(
      await a.p.locator('[data-workout-history]').textContent(),
      /частич|прерван|досроч/i,
    );
    results.push(
      'Ранний выход сохраняет частичный объём и XP; история показывает досрочный результат без полного завершения',
    );
    await a.p.locator('#profile-toggle').click();
    await a.p.locator('#sign-out-btn').click();
    await a.p.locator('#quick-guest-btn').waitFor({ state: 'visible' });
    await a.p.locator('#quick-guest-btn').click();
    await poll(
      () => api(a.p, 'activity'),
      (value) => value.status === 200 && value.body.totalXp === 0,
      'new owner has no XP',
    );
    assert.equal((await history(a.p)).length, 0);
    results.push(
      'После выхода новый гостевой профиль не получает чужую очередь, XP или результаты программ',
    );
  }
  await recovery();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: results.length, results, pageErrors: errors }, null, 2));
} catch (error) {
  for (const context of contexts)
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      console.error(
        'Workout browser failure:',
        JSON.stringify(
          await page.evaluate(() => ({
            stage: document.querySelector('[data-workout-body]')?.dataset.workoutStage,
            count: document.querySelector('[data-workout-count]')?.textContent,
            hint: document.querySelector('[data-workout-hint]')?.textContent,
            status: document.querySelector('[data-workout-status]')?.textContent,
            camera: !!document.querySelector('[data-workout-video]')?.srcObject,
            pose: window.testWorkoutPose,
          })),
        ),
      );
      await page.screenshot({ path: 'work/browser-workouts/failure.png', fullPage: true });
    }
  console.error('Workout HTTP failures:', JSON.stringify(requestErrors));
  throw error;
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
