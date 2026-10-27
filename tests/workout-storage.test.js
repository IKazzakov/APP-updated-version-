import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { transformSync } from 'esbuild';
import {
  WorkoutStorage,
  WorkoutStorageError,
  WorkoutStorageConflict,
} from '../src/services/workout-storage.ts';

test('unavailable IndexedDB fails explicitly without an in-memory durability promise', async () => {
  const storage = new WorkoutStorage('owner', undefined);
  await assert.rejects(storage.init(), WorkoutStorageError);
  await assert.rejects(storage.load(), WorkoutStorageError);
  storage.close();
  await assert.rejects(storage.clear('missing'), WorkoutStorageError);
});

// Transactional test double: writes become durable only on commit, aborted writes
// leave previous data intact. The optional Chromium scenario below uses real IDB.
function indexedDb() {
  let data = new Map(),
    upgraded = false;
  const opening = [];
  const factory = {
    deferOpen: false,
    failNextWrite: false,
    releaseOpen() {
      for (const open of opening.splice(0)) open();
    },
    open() {
      const request = {};
      const open = () => {
        request.result = {
          objectStoreNames: { contains: () => upgraded },
          createObjectStore() {
            upgraded = true;
          },
          close() {},
          transaction(_name, mode) {
            let pending = 0,
              completed = false,
              timer;
            const draft = new Map(structuredClone([...data]));
            const tx = {
              abort() {
                if (completed) return;
                completed = true;
                clearTimeout(timer);
                queueMicrotask(() => tx.onabort?.());
              },
              objectStore() {
                const operation = (run, writing = false) => {
                  if (completed) throw Error('TransactionInactiveError');
                  clearTimeout(timer);
                  pending++;
                  const result = { transaction: tx };
                  setTimeout(() => {
                    if (completed) return;
                    if (writing && factory.failNextWrite) {
                      factory.failNextWrite = false;
                      tx.abort();
                      return;
                    }
                    result.result = run();
                    result.onsuccess?.();
                    pending--;
                    if (!pending && !completed)
                      timer = setTimeout(() => {
                        if (completed) return;
                        completed = true;
                        if (mode === 'readwrite') data = draft;
                        tx.oncomplete?.();
                      }, 0);
                  }, 0);
                  return result;
                };
                return {
                  get: (key) => operation(() => structuredClone(draft.get(key))),
                  put: (value) =>
                    operation(() => draft.set(value.owner, structuredClone(value)), true),
                  delete: (key) => operation(() => draft.delete(key), true),
                };
              },
            };
            return tx;
          },
        };
        if (!upgraded) request.onupgradeneeded?.();
        request.onsuccess?.();
      };
      queueMicrotask(() => (factory.deferOpen ? opening.push(open) : open()));
      return request;
    },
  };
  return factory;
}
const journal = (id = 'workout-one') => ({
  workout: { id, programId: 'plank-15-v1', startedAt: 10000 },
  stepProgress: [500],
  events: [{ id: 'event-one', stepIndex: 0, occurredAt: 10000, durationMs: 500 }],
  activeMs: 500,
  status: 'active',
  synced: false,
});

test('journal commits before resolve and reload preserves UUID, hold and end intent per owner', async () => {
  const factory = indexedDb(),
    a = new WorkoutStorage('api-a:alice', factory);
  const first = journal(),
    saved = a.save(first);
  first.events[0].durationMs = 999;
  first.stepProgress[0] = 999;
  await saved;
  a.close();
  const resumed = new WorkoutStorage('api-a:alice', factory),
    b = new WorkoutStorage('api-a:bob', factory),
    other = new WorkoutStorage('api-b:alice', factory);
  assert.equal((await resumed.load()).events[0].durationMs, 500);
  assert.equal(await b.load(), null);
  assert.equal(await other.load(), null);
  const end = await resumed.load();
  end.pendingEnd = { action: 'abort', endedAt: 11000, activeMs: 500 };
  const saving = resumed.save(end),
    loading = resumed.load();
  await saving;
  assert.deepEqual((await loading).pendingEnd, end.pendingEnd);
  assert.equal((await resumed.load()).events[0].id, 'event-one');
  resumed.close();
  b.close();
  other.close();
});

test('write failure retains last commit and recovery retries the same durable event', async () => {
  const factory = indexedDb(),
    storage = new WorkoutStorage('alice', factory);
  await storage.save(journal());
  factory.failNextWrite = true;
  const next = await storage.load();
  next.events = [];
  next.synced = true;
  await assert.rejects(storage.save(next), WorkoutStorageError);
  const durable = await storage.load();
  assert.equal(durable.events[0].id, 'event-one');
  assert.equal(durable.synced, false);
  await storage.save(next);
  assert.deepEqual((await storage.load()).events, []);
  storage.close();
});

test('stale saves and cleanup from another tab cannot overwrite a committed UUID', async () => {
  const factory = indexedDb(),
    a = new WorkoutStorage('alice', factory),
    b = new WorkoutStorage('alice', factory);
  const first = await a.save(journal());
  assert.equal(first.storageRevision, 1);
  const snapshotA = await a.load(),
    snapshotB = await b.load();
  snapshotA.events.push({ id: 'event-a', stepIndex: 0, occurredAt: 10500, durationMs: 500 });
  snapshotA.stepProgress[0] += 500;
  const committed = await a.save(snapshotA);
  assert.equal(committed.storageRevision, 2);
  snapshotB.events.push({ id: 'event-b', stepIndex: 0, occurredAt: 11000, durationMs: 500 });
  snapshotB.stepProgress[0] += 500;
  await assert.rejects(b.save(snapshotB), WorkoutStorageConflict);
  await assert.rejects(b.clear(snapshotB.workout.id), WorkoutStorageConflict);
  assert.deepEqual(
    (await a.load()).events.map((event) => event.id),
    ['event-one', 'event-a'],
  );
  const fresh = await b.load();
  fresh.events.push({ id: 'event-c', stepIndex: 0, occurredAt: 11500, durationMs: 500 });
  fresh.stepProgress[0] += 500;
  await b.save(fresh);
  assert.deepEqual(
    (await b.load()).events.map((event) => event.id),
    ['event-one', 'event-a', 'event-c'],
  );
  a.close();
  b.close();
});

test('cleanup cannot delete a different workout and late writes cannot resurrect cleared data', async () => {
  const storage = new WorkoutStorage('alice', indexedDb());
  await storage.save(journal());
  await storage.clear('not-the-current-workout');
  assert.equal((await storage.load()).workout.id, 'workout-one');
  await assert.rejects(storage.save(journal('workout-two')), WorkoutStorageError);
  const clearing = storage.clear('workout-one'),
    stale = storage.save(journal());
  await clearing;
  await assert.rejects(stale, WorkoutStorageError);
  assert.equal(await storage.load(), null);
  await storage.save(journal('workout-two'));
  assert.equal((await storage.load()).workout.id, 'workout-two');
  storage.close();
});

test('closing during delayed open rejects pending operations and cannot write after owner change', async () => {
  const factory = indexedDb();
  factory.deferOpen = true;
  const storage = new WorkoutStorage('alice', factory),
    opening = storage.init();
  storage.close();
  await Promise.resolve();
  factory.releaseOpen();
  await assert.rejects(opening, WorkoutStorageError);
  await assert.rejects(storage.save(journal()), WorkoutStorageError);
  await assert.rejects(storage.load(), WorkoutStorageError);
  factory.deferOpen = false;
  const other = new WorkoutStorage('bob', factory);
  assert.equal(await other.load(), null);
  other.close();
});

const chromium = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
let browserAvailable = true;
try {
  accessSync(chromium);
} catch {
  browserAvailable = false;
}

test(
  'real IndexedDB retains owner-isolated journal through reload, aborts and close races',
  { skip: !browserAvailable || process.env.WORKOUT_STORAGE_BROWSER !== '1' },
  async () => {
    const source = transformSync(
      readFileSync(new URL('../src/services/workout-storage.ts', import.meta.url), 'utf8'),
      { loader: 'ts', format: 'esm', target: 'es2022' },
    ).code;
    const scenario = `
      import {WorkoutStorage} from '/storage.js';
      const check = (condition, message) => {if (!condition) throw Error(message)};
      const rejects = async (operation) => {
        try {await operation();} catch(error) {check(['LOCAL_STORAGE','WORKOUT_STORAGE_CONFLICT'].includes(error.code), 'safe error code');return;}
        throw Error('operation unexpectedly succeeded');
      };
      const record = (id = 'workout-one') => ({
        workout:{id, programId:'plank-15-v1', startedAt:10000},
        stepProgress:[500],
        events:[{id:'event-one',stepIndex:0,occurredAt:10000,durationMs:500}],
        activeMs:500,status:'active',synced:false,
      });
      let passed=0;
      try {
        const a = new WorkoutStorage('api-a:alice'), b = new WorkoutStorage('api-a:bob'),
          otherServer = new WorkoutStorage('api-b:alice');
        await Promise.all([a.init(),b.init(),otherServer.init()]);
        const first = record();
        const pendingSave = a.save(first);
        first.events[0].durationMs = 900;
        first.stepProgress[0] = 900;
        await pendingSave;
        const durable=await a.load();
        check(durable.events[0].durationMs===500&&durable.stepProgress[0]===500,'snapshot before async wait');
        check(await b.load()===null&&await otherServer.load()===null,'API and profile isolation');
        passed++;

        a.close();
        const reloaded = new WorkoutStorage('api-a:alice');
        const resumed=await reloaded.load();
        check(resumed.events[0].id==='event-one'&&resumed.stepProgress[0]===500,'reload retains event UUID and hold');
        resumed.events.length=0;
        check((await reloaded.load()).events.length===1,'read results do not mutate disk');
        passed++;

        const next=await reloaded.load();
        next.pendingEnd={action:'abort',endedAt:11000,activeMs:500};
        next.status='aborted';
        const saving=reloaded.save(next), loading=reloaded.load();
        await saving;
        check((await loading).pendingEnd.action==='abort','calls serialize with end intent persisted');
        await reloaded.clear('wrong-workout');
        check((await reloaded.load()).workout.id==='workout-one','stale cleanup does not delete current workout');
        passed++;

        const original=IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction=function(...args) {
          const tx=original.apply(this,args);
          if(args[1]==='readwrite')queueMicrotask(()=>tx.abort());
          return tx;
        };
        try {await rejects(()=>reloaded.save(record()));} finally {IDBDatabase.prototype.transaction=original;}
        check((await reloaded.load()).status==='aborted','failed write retains previous committed journal');
        passed++;

        await rejects(()=>reloaded.save(record('workout-two')));
        check((await reloaded.load()).workout.id==='workout-one','new workout cannot overwrite unsent old journal');
        const clearing=reloaded.clear('workout-one'), stale=reloaded.save(record());
        await clearing;
        await rejects(()=>stale);
        check(await reloaded.load()===null,'late save cannot resurrect cleared workout');
        await reloaded.save(record('workout-two'));
        passed++;

        const early = new WorkoutStorage('api-a:opening-close');
        const opening=early.init();
        early.close();
        await rejects(()=>opening);
        await rejects(()=>early.load());
        const saveAfterClose=reloaded.save(record('workout-two'));
        reloaded.close();
        await rejects(()=>saveAfterClose);
        const afterClose=new WorkoutStorage('api-a:alice');
        check((await afterClose.load()).workout.id==='workout-two','close retains previously committed journal');
        await afterClose.clear('workout-two');
        afterClose.close();b.close();otherServer.close();
        passed++;
        document.body.textContent=JSON.stringify({ok:true,passed});
      } catch(error) {document.body.textContent=JSON.stringify({ok:false,passed,error:String(error.stack||error)});}
    `;
    const directory = mkdtempSync(join(tmpdir(), 'movement-workout-storage-'));
    const profile = join(directory, 'profile');
    writeFileSync(join(directory, 'storage.js'), source);
    writeFileSync(
      join(directory, 'test.js'),
      scenario.replace("from '/storage.js'", "from './storage.js'"),
    );
    writeFileSync(
      join(directory, 'index.html'),
      '<!doctype html><body>pending<script type="module" src="./test.js"></script>',
    );
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(chromium, [
          '--headless',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--disable-background-networking',
          '--no-first-run',
          '--allow-file-access-from-files',
          '--user-data-dir=' + profile,
          '--virtual-time-budget=10000',
          '--dump-dom',
          pathToFileURL(join(directory, 'index.html')).href,
        ]);
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Chromium storage scenario timed out'));
        }, 30000);
        child.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timeout);
          if (code !== 0) reject(new Error(stderr || 'Chromium exited ' + code));
          else resolve(stdout);
        });
      });
      const body = result.match(/<body>([\s\S]*?)<\/body>/)?.[1];
      assert.ok(body, String(result));
      const report = JSON.parse(body.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
      assert.equal(report.ok, true, report.error);
      assert.equal(report.passed, 6);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
