import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  prepare,
  validateLocal,
  inspectRemote,
  uploadForm,
  readRemote,
  publishVersion,
} from '../scripts/release-web-api.mjs';

const config = JSON.parse(await readFile('wrangler.backend.json', 'utf8'));
const source = {
  sourceSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  branch: 'main',
  dirty: false,
  version: '2.6.1',
};
const authorization = {
  source,
  config,
  mode: 'deploy',
  expectedSourceSha: source.sourceSha,
  confirmation: 'deploy-web-api',
  event: 'workflow_dispatch',
  ref: 'refs/heads/main',
  checkoutSha: source.sourceSha,
};
assert.equal(validateLocal(authorization), true);
for (const change of [
  { source: { ...source, dirty: true } },
  { source: { ...source, branch: 'release' } },
  { expectedSourceSha: 'c'.repeat(40) },
  { confirmation: 'deploy' },
  { event: 'push' },
  { ref: 'refs/heads/release' },
  { checkoutSha: 'c'.repeat(40) },
  { config: { ...config, name: 'other' } },
  { config: { ...config, d1_databases: [{ binding: 'DB', database_name: 'other' }] } },
])
  assert.throws(() => validateLocal({ ...authorization, ...change }));

const versionId = '11111111-1111-4111-8111-111111111111';
const databaseId = '22222222-2222-4222-8222-222222222222';
const bindings = [
  { name: 'DB', type: 'd1', id: databaseId },
  { name: 'AUTH_LIMITER', type: 'ratelimit', namespace_id: '250301' },
  { name: 'ASSETS', type: 'assets' },
  { name: 'PRIVATE_VALUE', type: 'secret_text', text: 'must-not-leak' },
];
const fixture = {
  subdomain: { subdomain: 'rojoscarlos93' },
  databases: [{ name: 'movement-test-app-staging', uuid: databaseId }],
  deployments: {
    deployments: [{ id: 'deployment-1', versions: [{ version_id: versionId, percentage: 100 }] }],
  },
  version: {
    id: versionId,
    resources: {
      bindings,
      script_runtime: { compatibility_date: config.compatibility_date, compatibility_flags: [] },
    },
  },
  settings: { observability: { enabled: true } },
  config,
};
const remote = inspectRemote(fixture);
assert.equal(remote.databaseId, databaseId);
assert.equal(remote.metadata.keep_assets, true);
assert.match(remote.bindingDigest, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(remote.bindingTypes).includes('PRIVATE_VALUE'), false);
assert.deepEqual(
  remote.metadata.bindings,
  bindings.map((item) => ({ name: item.name, type: 'inherit' })),
);
assert.equal(JSON.stringify(remote).includes('must-not-leak'), false);
assert.equal('assets' in remote.metadata, false);
const form = uploadForm(new TextEncoder().encode('export default {}'), remote.metadata);
assert.equal(form.get('metadata').includes('keep_assets":true'), true);
assert.equal(form.has('assets'), false);
assert.equal(form.has('cloudflare.js'), true);
for (const metadata of [
  { ...remote.metadata, keep_assets: false },
  { ...remote.metadata, assets: { jwt: 'new' } },
  { ...remote.metadata, bindings: [{ name: 'DB', type: 'd1' }] },
])
  assert.throws(() => uploadForm(new Uint8Array([1]), metadata));
for (const change of [
  { subdomain: { subdomain: 'other' } },
  { databases: [] },
  { databases: [...fixture.databases, ...fixture.databases] },
  { deployments: { deployments: [{ versions: [{ version_id: versionId, percentage: 50 }] }] } },
  {
    version: {
      ...fixture.version,
      resources: {
        ...fixture.version.resources,
        bindings: bindings.filter((item) => item.name !== 'ASSETS'),
      },
    },
  },
  {
    version: {
      ...fixture.version,
      resources: {
        ...fixture.version.resources,
        bindings: bindings.map((item) => (item.name === 'DB' ? { ...item, id: 'wrong' } : item)),
      },
    },
  },
  { settings: null },
])
  assert.throws(() => inspectRemote({ ...fixture, ...change }));

let calls = [];
const response = (result) => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true, result }),
});
const fake = async (url, options) => {
  calls.push({ url, method: options.method });
  const path = new URL(url).pathname;
  if (path.endsWith('/workers/subdomain')) return response(fixture.subdomain);
  if (path.endsWith('/d1/database')) return response(fixture.databases);
  if (path.endsWith('/deployments')) return response(fixture.deployments);
  if (path.endsWith(`/versions/${versionId}`)) return response(fixture.version);
  if (path.endsWith('/script-settings')) return response(fixture.settings);
  throw new Error(`Unexpected request ${path}`);
};
assert.equal(
  (await readRemote({ request: fake, accountId: 'c'.repeat(32), token: 'fake' }, config))
    .previousVersionId,
  versionId,
);
assert.ok(calls.every((call) => call.method === 'GET'));
assert.ok(calls.every((call) => !/(?:\/query|\/auth\/|assets-upload-session)/.test(call.url)));
calls = [];
const temp = await mkdtemp(join(tmpdir(), 'movement-release-test-'));
const bundleBytes = Buffer.from('fixture worker');
let buildCalls = 0;
let prepared;
try {
  prepared = await prepare({
    outputDir: temp,
    request: async (...args) => {
      calls.push(args);
      throw new Error('Unexpected remote request');
    },
    buildBundle: async () => {
      buildCalls++;
      return {
        bytes: bundleBytes,
        size: bundleBytes.length,
        sha256: createHash('sha256').update(bundleBytes).digest('hex'),
      };
    },
  });
  assert.deepEqual(JSON.parse(await readFile(join(temp, 'manifest.json'), 'utf8')), prepared);
} finally {
  await rm(temp, { recursive: true, force: true });
}
assert.equal(buildCalls, 1);
assert.equal(prepared.status, 'PREPARED');
assert.equal(prepared.remote.status, 'NOT_RUN');
assert.match(prepared.bundle.sha256, /^[a-f0-9]{64}$/);
assert.equal(calls.length, 0);
await assert.rejects(
  readRemote(
    {
      request: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: false, result: {} }),
      }),
      accountId: 'c'.repeat(32),
      token: 'fake',
    },
    config,
  ),
);
const uploadCalls = [];
const publishRequest = async (url, options) => {
  uploadCalls.push({ url, options });
  if (url.includes('/versions?')) return response({ id: '33333333-3333-4333-8333-333333333333' });
  if (url.endsWith('/deployments')) return response({ id: 'deployment-2' });
  throw new Error('unexpected request');
};
const published = await publishVersion(
  { request: publishRequest, accountId: 'c'.repeat(32), token: 'fake' },
  new Uint8Array([1]),
  remote.metadata,
  source.sourceSha,
);
assert.equal(published.deploymentId, 'deployment-2');
assert.deepEqual(
  uploadCalls.map((call) => call.options.method),
  ['POST', 'POST'],
);
assert.equal(uploadCalls[0].options.body.get('metadata').includes('keep_assets":true'), true);
assert.ok(
  uploadCalls.every((call) => !/(?:\/query|\/auth\/|assets-upload-session)/.test(call.url)),
);
await assert.rejects(
  publishVersion(
    {
      request: async () => {
        throw new Error('lost response');
      },
      accountId: 'c'.repeat(32),
      token: 'fake',
    },
    new Uint8Array([1]),
    remote.metadata,
    source.sourceSha,
  ),
  /VERIFY_REQUIRED/,
);
let writes = 0;
await assert.rejects(
  publishVersion(
    {
      request: async () => {
        writes++;
        return response({ id: 'invalid' });
      },
      accountId: 'c'.repeat(32),
      token: 'fake',
    },
    new Uint8Array([1]),
    remote.metadata,
    source.sourceSha,
  ),
  /VERIFY_REQUIRED/,
);
assert.equal(writes, 1);
console.log('web-api-release: PASS');
