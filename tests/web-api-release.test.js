import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
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
// Every real prepare GET has a fixed diagnostic stage, including response-body failures.
const marker = 'marker-secret-do-not-print';
const stages = [
  ['/workers/subdomain', 'CF_SUBDOMAIN'],
  ['/d1/database', 'CF_DATABASES'],
  ['/deployments', 'CF_DEPLOYMENTS'],
  [`/versions/${versionId}`, 'CF_VERSION'],
  ['/script-settings', 'CF_SETTINGS'],
  ['/index.html', 'PUBLIC_HTML'],
  ['/app-debug.apk.json', 'PUBLIC_APK_METADATA'],
  ['/app-debug.apk.sha256', 'PUBLIC_APK_CHECKSUM'],
  ['/app-debug.apk', 'PUBLIC_APK'],
];
const apk = Buffer.from('published fixture APK');
const digest = createHash('sha256').update(apk).digest('hex');
const publicBytes = {
  '/index.html': Buffer.from('<html>published</html>'),
  '/app-debug.apk.json': Buffer.from(JSON.stringify({ sha256: digest, size: apk.length })),
  '/app-debug.apk.sha256': Buffer.from(digest),
  '/app-debug.apk': apk,
};
const fixtureBundle = async () => ({
  bytes: bundleBytes,
  size: bundleBytes.length,
  sha256: createHash('sha256').update(bundleBytes).digest('hex'),
});
const fullFake = async (url, options) => {
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  const bytes = publicBytes[new URL(url).pathname];
  return bytes ? { ok: true, status: 200, arrayBuffer: async () => bytes } : fake(url, options);
};
const diagnosisDir = await mkdtemp(join(tmpdir(), 'movement-network-test-'));
try {
  for (const [suffix, stage] of stages) {
    for (const kind of ['dns', 'tls', 'timeout', 'reset', 'http', 'body', 'unknown']) {
      let failures = 0;
      let bodyReads = 0;
      const causeCode = {
        dns: 'ENOTFOUND',
        tls: 'ERR_TLS_CERT_ALTNAME_INVALID',
        timeout: 'UND_ERR_CONNECT_TIMEOUT',
        reset: 'ECONNRESET',
      }[kind];
      const request = async (url, options) => {
        if (!new URL(url).pathname.endsWith(suffix)) return fullFake(url, options);
        failures++;
        const failure = new TypeError(`${marker} ${url} ${options.headers.Authorization}`);
        failure.cause = { code: causeCode ?? marker, message: marker, headers: { secret: marker } };
        failure.url = url;
        failure.headers = { Authorization: marker };
        if (kind === 'http' || kind === 'body')
          return {
            ok: kind === 'body',
            status: kind === 'http' ? 403 : 200,
            headers: { Authorization: marker },
            json: async () => {
              bodyReads++;
              throw failure;
            },
            arrayBuffer: async () => {
              bodyReads++;
              throw failure;
            },
          };
        if (kind === 'unknown') failure.name = marker;
        throw failure;
      };
      // Seed stale success evidence to prove a failed repeat cannot be mistaken for PASS.
      await writeFile(join(diagnosisDir, 'manifest.json'), '{"status":"PREPARED"}');
      let caught;
      await assert.rejects(
        prepare({
          request,
          accountId: 'c'.repeat(32),
          token: marker,
          outputDir: diagnosisDir,
          buildBundle: fixtureBundle,
        }),
        (error) => {
          caught = error;
          return true;
        },
      );
      const expected = {
        stage,
        errorType:
          kind === 'http' ? 'HTTPError' : kind === 'unknown' ? 'UnknownError' : 'TypeError',
        ...(causeCode ? { causeCode } : {}),
        ...(['http', 'body'].includes(kind) ? { status: kind === 'http' ? 403 : 200 } : {}),
      };
      assert.deepEqual(caught.diagnostic, expected);
      const artifact = await readFile(join(diagnosisDir, 'error.json'), 'utf8');
      assert.deepEqual(JSON.parse(artifact), { schema: 1, status: 'FAILED', diagnostic: expected });
      assert.equal((await stat(join(diagnosisDir, 'error.json'))).mode & 0o777, 0o600);
      await assert.rejects(readFile(join(diagnosisDir, 'manifest.json')), { code: 'ENOENT' });
      for (const output of [artifact, String(caught), caught.stack, JSON.stringify(caught)]) {
        for (const privateValue of [
          marker,
          'c'.repeat(32),
          databaseId,
          versionId,
          'Authorization',
          'https://',
        ])
          assert.equal(
            output.includes(privateValue),
            false,
            `${stage}/${kind}: private value leaked`,
          );
      }
      assert.equal(failures, 1, 'GET must not silently retry');
      assert.equal(bodyReads, kind === 'body' ? 1 : 0);
    }
  }
  // Invalid JSON retains the received HTTP status and the exact control-plane stage.
  await assert.rejects(
    readRemote(
      {
        accountId: marker,
        token: marker,
        request: async (url) => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError(`${marker} ${url}`);
          },
        }),
      },
      config,
    ),
    (error) => {
      assert.deepEqual(error.diagnostic, {
        stage: 'CF_SUBDOMAIN',
        errorType: 'SyntaxError',
        status: 200,
      });
      assert.equal(String(error).includes(marker), false);
      return true;
    },
  );
  // Success clears a previous error; fixture assets still undergo checksum verification.
  const success = await prepare({
    request: fullFake,
    accountId: 'c'.repeat(32),
    token: marker,
    outputDir: diagnosisDir,
    buildBundle: fixtureBundle,
  });
  assert.equal(success.remote.status, 'PASS');
  assert.equal(success.remote.publicArtifacts.apkSha256, digest);
  await assert.rejects(readFile(join(diagnosisDir, 'error.json')), { code: 'ENOENT' });
} finally {
  await rm(diagnosisDir, { recursive: true, force: true });
}
console.log('web-api-release: PASS (release guards and 63 staged network/body/HTTP fixtures)');
