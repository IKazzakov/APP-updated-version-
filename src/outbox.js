import {activity} from './activity-log.js';
import {api as defaultApi, ApiError} from './api.js';

const DATABASE = 'exercise-counter-outbox-v1';
const STORE = 'repetitions';
function requestResult(request) {
  return new Promise((resolve, reject) => {request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new ApiError('LOCAL_STORAGE'));});
}
function transactionResult(transaction) {
  return new Promise((resolve, reject) => {transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = () => reject(new ApiError('LOCAL_STORAGE'));});
}

// Only unconfirmed repetition events live here, partitioned by the signed-in
// profile. No camera frames, body coordinates or account tokens are stored.
export class IndexedDbOutboxStore {
  constructor(userId) {this.userId = userId; this.db = null;}
  async open() {
    if (this.db) return;
    if (!globalThis.indexedDB) throw new ApiError('LOCAL_STORAGE');
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, {keyPath: 'key'});
      store.createIndex('userId', 'userId', {unique: false});
    };
    this.db = await requestResult(request);
    this.db.onversionchange = () => this.close();
  }
  async list() {
    await this.open();
    const transaction = this.db.transaction(STORE, 'readonly'), done = transactionResult(transaction);
    const result = await requestResult(transaction.objectStore(STORE).index('userId').getAll(this.userId));
    await done;
    return result.map(({key, userId, ...entry}) => entry).sort((a, b) => String(a.event.occurredAt).localeCompare(String(b.event.occurredAt)) || a.event.id.localeCompare(b.event.id));
  }
  async put(entry) {
    await this.open();
    const transaction = this.db.transaction(STORE, 'readwrite'), done = transactionResult(transaction);
    const store = transaction.objectStore(STORE), key = `${this.userId}:${entry.event.id}`;
    const existing = await requestResult(store.get(key));
    if (existing && JSON.stringify(existing.event) !== JSON.stringify(entry.event)) {transaction.abort(); await done.catch(() => {}); throw new ApiError('OUTBOX_CONFLICT', 409);}
    store.put({...entry, key, userId: this.userId}); await done;
  }
  async remove(ids) {
    await this.open();
    const transaction = this.db.transaction(STORE, 'readwrite'), done = transactionResult(transaction);
    const store = transaction.objectStore(STORE);
    for (const id of ids) store.delete(`${this.userId}:${id}`);
    await done;
  }
  close() {this.db?.close(); this.db = null;}
}

function cleanEvent(event) {
  if (!event || typeof event.id !== 'string' || !event.id || !Number.isFinite(Date.parse(event.occurredAt))) throw new ApiError('INVALID_EVENT', 400);
  // A projection ensures accidental camera/landmark fields can never cross
  // the network through the synchronization path.
  return {id: event.id, occurredAt: new Date(event.occurredAt).toISOString(), ...(event.roundId ? {roundId: event.roundId, elapsedMs: event.elapsedMs} : {})};
}

export class Outbox {
  constructor(userId, {api = defaultApi, onStatus = () => {}, storage, autoRetry = true, flushDelayMs=0} = {}) {
    if (!userId) throw new ApiError('AUTH_REQUIRED', 401);
    this.storage = storage || new IndexedDbOutboxStore(userId); this.api = api; this.onStatus = onStatus;
    this.flushDelayMs=flushDelayMs;this.flushTimer=null;this.latestState = null; this.autoRetry = autoRetry; this.closed = false; this.started = null; this.inflight = null; this.lastError = null;
    this.online = () => {this.flush().catch(() => {});};
  }
  async init() {
    if (!this.started) this.started = (async () => {
      await this.storage.open(); await this.notify(false);
      if (this.autoRetry) {
        globalThis.addEventListener?.('online', this.online);
        this.interval = setInterval(this.online, 10000); this.interval.unref?.();
        queueMicrotask(this.online);
      }
      return this;
    })().catch(error => {this.started = null; this.reportFailure(error); throw this.lastError;});
    return this.started;
  }
  async notify(saving) {
    if (this.closed) return;
    const entries = await this.storage.list();
    this.onStatus({pending: entries.length, saving, error: this.lastError?.userMessage || null, code: this.lastError?.code || null, blocked: entries.filter(e => e.blocked).length, state: this.latestState});
  }
  reportFailure(error) {
    this.lastError = error instanceof ApiError ? error : new ApiError('LOCAL_STORAGE');
    if (!this.closed) this.onStatus({pending: null, saving: false, error: this.lastError.userMessage, code: this.lastError.code});
  }
  async add(event) {
    await this.init();
    if (this.closed) throw new ApiError('LOCAL_STORAGE');
    const safe = cleanEvent(event);
    try {await this.storage.put({event: safe, blocked: false}); await this.notify(false);}
    catch (error) {this.reportFailure(error); throw this.lastError;}
    // Persistence completes before the first network request. A lost response
    // retries the same event ID instead of inventing another one.
    activity.record('queue.saved',{local:true});
    if(this.flushDelayMs>0){if(!this.flushTimer){this.flushTimer=setTimeout(()=>{this.flushTimer=null;this.flush().catch(()=>{});},this.flushDelayMs);this.flushTimer.unref?.();}}else this.flush().catch(() => {});
    return safe.id;
  }
  async count() {await this.init(); return (await this.storage.list()).length;}
  async flush({retryFailed = false} = {}) {
    clearTimeout(this.flushTimer);this.flushTimer=null;
    await this.init();
    if (this.closed) return null;
    if (this.inflight) {const previous = await this.inflight; return await this.flush({retryFailed}) || previous;}
    this.inflight = this.send(retryFailed).finally(() => {this.inflight = null; if (this.closed) this.storage.close();});
    return this.inflight;
  }
  async send(retryFailed) {
    let latestState = null;
    let entries = await this.storage.list();
    if (retryFailed) {
      for (const entry of entries.filter(e => e.blocked)) await this.storage.put({...entry, blocked: false});
      this.lastError = null; entries = await this.storage.list();
    }
    while (!this.closed) {
      const batch = entries.filter(entry => !entry.blocked).slice(0, 50);
      if (!batch.length) {await this.notify(false); return latestState;}
      await this.notify(true);
      try {
        activity.record('queue.sending',{items:batch.length});
        const result = await this.api('repetitions', {method: 'POST', body: {events: batch.map(entry => entry.event)}});
        await this.storage.remove(batch.map(entry => entry.event.id));
        activity.record('queue.confirmed',{items:batch.length});
        latestState = result.state || latestState; this.latestState = latestState || this.latestState; this.lastError = null;
      } catch (caught) {
        const error = caught instanceof ApiError ? caught : new ApiError('NETWORK');
        this.lastError = error;activity.record('queue.error',{code:error.code,items:batch.length});
        if (error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status)) {
          // Rejected data remains visible for an explicit retry; never discard
          // a failed batch or loop forever against a validation error.
          for (const entry of batch) await this.storage.put({...entry, blocked: true});
        }
        await this.notify(false); throw error;
      }
      entries = await this.storage.list();
    }
    return latestState;
  }
  close() {
    this.closed = true; clearTimeout(this.flushTimer);clearInterval(this.interval); globalThis.removeEventListener?.('online', this.online);
    if (!this.inflight) this.storage.close();
  }
}
