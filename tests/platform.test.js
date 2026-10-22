import test from 'node:test';
import assert from 'node:assert/strict';
import {getApiBaseUrl, invitationOrigin, nativeApiRequest} from '../src/platform.js';

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
  assert.equal(sent.responseType, 'json');
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
