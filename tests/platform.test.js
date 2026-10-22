import test from 'node:test';
import assert from 'node:assert/strict';
import {getApiBaseUrl, invitationOrigin, nativeApiRequest, normalizeApiUrl, setNativeApiUrl, profileStorageId} from '../src/platform.js';

test('web requests stay relative; Android API and invitations use the public HTTPS server', () => {
  assert.equal(getApiBaseUrl(false), '/api');
  assert.match(getApiBaseUrl(true), /^https:\/\/[^/]+\/api$/);
  assert.equal(invitationOrigin('https://web.test', false), 'https://web.test');
  assert.equal(invitationOrigin('https://localhost', true), new URL(getApiBaseUrl(true)).origin);
});

test('native POST preserves the test profile and sends JSON with the origin accepted by the API', async () => {
  let sent;
  const http = {request: async options => {sent = options; return {status: 200, data: {accepted: 1}};}};
  const response = await nativeApiRequest('https://server.test/api/repetitions', {method: 'POST', headers: {'Content-Type': 'application/json', 'x-test-user-id': 'u_test'}, body: {events: [{id: 'event'}]}}, http);
  assert.equal(sent.headers.Origin, 'https://server.test');
  assert.equal(sent.headers['x-test-user-id'], 'u_test');
  assert.deepEqual(sent.data, {events: [{id: 'event'}]});
  assert.equal(sent.responseType, 'text');
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), {accepted: 1});
});

test('native HTTP errors retain status and payload for the existing API error handling', async () => {
  const response = await nativeApiRequest('https://server.test/api/state', {}, {request: async () => ({status: 401, data: '{"error":{"code":"SIGN_IN_REQUIRED"}}'})});
  assert.equal(response.ok, false);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'SIGN_IN_REQUIRED');
});

test('native transport rejects cleartext URLs and aborts an outstanding request on timeout', async () => {
  await assert.rejects(nativeApiRequest('http://server.test/api/state'), /HTTPS/);
  const controller = new AbortController();
  const request = nativeApiRequest('https://server.test/api/state', {signal: controller.signal}, {request: () => new Promise(() => {})});
  controller.abort();
  await assert.rejects(request, {name: 'AbortError'});
});

test('HTML from a preview/auth page preserves its HTTP status rather than becoming a network failure', async () => {
  const response=await nativeApiRequest('https://server.test/api/state', {}, {request:async()=>({status:200,data:'<html>Sign in</html>'})});
  assert.equal(response.status,200);
  await assert.rejects(response.json(), SyntaxError);
});

test('server configuration accepts HTTPS origins or API paths and excludes embedded credentials', () => {
  assert.equal(normalizeApiUrl(' https://server.test/ '),'https://server.test/api');
  assert.equal(normalizeApiUrl('https://server.test/custom/api/'),'https://server.test/custom/api');
  for(const url of ['http://server.test','https://name:pass@server.test','https://server.test/?token=secret','https://server.test/#invite=secret'])assert.throws(()=>normalizeApiUrl(url));
});

test('native server overrides persist, browser requests stay same-origin, and old queues stay isolated', () => {
  const values=new Map();
  globalThis.localStorage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const original=globalThis.Capacitor.isNativePlatform;
  globalThis.Capacitor.isNativePlatform=()=>true;
  try{
    assert.equal(profileStorageId('u_test'),`${getApiBaseUrl(true)}|u_test`);
    setNativeApiUrl('https://ais-pre-unwfcvynbcdvpumsvvws2k-220077059769.europe-west2.run.app');
    assert.equal(profileStorageId('u_test'),'u_test');
    setNativeApiUrl('https://second.test');
    assert.equal(getApiBaseUrl(true),'https://second.test/api');
    assert.equal(getApiBaseUrl(false),'/api');
    assert.equal(profileStorageId('u_test'),'https://second.test/api|u_test');
    assert.equal(invitationOrigin('https://localhost',true),'https://second.test');
  }finally{delete globalThis.localStorage;globalThis.Capacitor.isNativePlatform=original;}
});
