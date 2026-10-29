import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'work/web-api-release');
const worker = 'movement-test-api-staging';
const database = 'movement-test-app-staging';
const origin = 'https://movement-test-api-staging.rojoscarlos93.workers.dev';
const browserOrigin = 'https://preview-67f2889c80972c44.movement-preview.pages.dev';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const shaPattern = /^[a-f0-9]{40}$/;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail = (message) => {
  throw new Error(message);
};
const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

export function sourceMetadata() {
  const pkg = JSON.parse(execFileSync('cat', ['package.json'], { cwd: root, encoding: 'utf8' }));
  const config = execFileSync('cat', ['src/config.js'], { cwd: root, encoding: 'utf8' });
  const version = config.match(/export const VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (version !== pkg.version) fail('Version mismatch.');
  const sourceSha = git('rev-parse', 'HEAD');
  const treeSha = git('rev-parse', 'HEAD^{tree}');
  let branch = null;
  try {
    branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
  } catch {}
  const dirty = git('status', '--porcelain=v1', '--untracked-files=normal') !== '';
  if (!shaPattern.test(sourceSha) || !shaPattern.test(treeSha)) fail('Invalid source metadata.');
  return { sourceSha, treeSha, branch, dirty, version };
}

export function validateLocal({
  source,
  config,
  mode = 'prepare',
  expectedSourceSha,
  confirmation,
  event,
  ref,
  checkoutSha,
}) {
  if (
    config?.name !== worker ||
    config?.workers_dev !== true ||
    config?.assets?.binding !== 'ASSETS' ||
    config?.assets?.run_worker_first !== true ||
    config?.d1_databases?.length !== 1 ||
    config.d1_databases[0]?.binding !== 'DB' ||
    config.d1_databases[0]?.database_name !== database ||
    config?.ratelimits?.length !== 1 ||
    config.ratelimits[0]?.name !== 'AUTH_LIMITER' ||
    config.ratelimits[0]?.namespace_id !== '250301'
  )
    fail('Canonical Worker, DB, assets or limiter configuration changed.');
  if (mode === 'deploy') {
    if (
      event !== 'workflow_dispatch' ||
      ref !== 'refs/heads/main' ||
      (source.branch !== null && source.branch !== 'main') ||
      !shaPattern.test(expectedSourceSha ?? '') ||
      expectedSourceSha !== source.sourceSha ||
      checkoutSha !== source.sourceSha ||
      confirmation !== 'deploy-web-api' ||
      source.dirty
    )
      fail('Deployment authorization or clean source check failed.');
  }
  return true;
}

export function inspectRemote({ subdomain, databases, deployments, version, settings, config }) {
  if (subdomain?.subdomain !== 'rojoscarlos93') fail('Cloudflare account subdomain mismatch.');
  if (!Array.isArray(databases) || databases.filter((db) => db.name === database).length !== 1)
    fail('Canonical D1 database is missing or ambiguous.');
  const db = databases.find((item) => item.name === database);
  if (!idPattern.test(db.uuid ?? '')) fail('Canonical D1 ID is invalid.');
  const active = deployments?.deployments?.[0];
  if (
    !active ||
    active.versions?.length !== 1 ||
    active.versions[0]?.percentage !== 100 ||
    !idPattern.test(active.versions[0]?.version_id ?? '')
  )
    fail('Active Worker version is missing or split.');
  if (version?.id !== active.versions[0].version_id || !Array.isArray(version?.resources?.bindings))
    fail('Active Worker metadata is invalid.');
  const bindings = version.resources.bindings;
  if (
    bindings.some(
      (item) =>
        !item || typeof item.name !== 'string' || !item.name || typeof item.type !== 'string',
    ) ||
    new Set(bindings.map((item) => item.name)).size !== bindings.length
  )
    fail('Worker bindings are ambiguous.');
  const binding = (name) => bindings.find((item) => item.name === name);
  if (
    binding('DB')?.type !== 'd1' ||
    binding('DB')?.id !== db.uuid ||
    binding('AUTH_LIMITER')?.type !== 'ratelimit' ||
    String(binding('AUTH_LIMITER')?.namespace_id) !== '250301' ||
    binding('ASSETS')?.type !== 'assets'
  )
    fail('Active Worker bindings do not match the canonical DB, limiter and assets.');
  const runtime = version.resources.script_runtime;
  if (
    runtime?.compatibility_date !== config.compatibility_date ||
    !Array.isArray(runtime.compatibility_flags ?? [])
  )
    fail('Active Worker runtime configuration is unclear.');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    fail('Worker script settings are unavailable.');
  // Inherit every existing binding by name. Secret values never enter a manifest.
  const metadata = {
    main_module: 'cloudflare.js',
    compatibility_date: runtime.compatibility_date,
    compatibility_flags: runtime.compatibility_flags ?? [],
    bindings: bindings.map((item) => ({ name: item.name, type: 'inherit' })),
    keep_bindings: ['plain_text', 'json', 'secret_text', 'secret_key'],
    keep_assets: true,
  };
  for (const field of ['placement', 'limits'])
    if (version.resources.script_runtime?.[field] !== undefined)
      metadata[field] = version.resources.script_runtime[field];
  if (version.cache_options !== undefined) metadata.cache_options = version.cache_options;
  return {
    databaseId: db.uuid,
    previousVersionId: version.id,
    activeDeploymentId: active.id,
    bindingDigest: sha256(
      JSON.stringify(
        bindings
          .map((item) => ({ name: item.name, type: item.type }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
    ),
    bindingTypes: Object.fromEntries(
      [...new Set(bindings.map((item) => item.type))]
        .sort()
        .map((type) => [type, bindings.filter((item) => item.type === type).length]),
    ),
    settingsSummary: { fields: Object.keys(settings).sort() },
    metadata,
  };
}

// Only closed labels and known runtime codes may cross the diagnostic boundary.
const readStages = new Set([
  'CF_SUBDOMAIN',
  'CF_DATABASES',
  'CF_DEPLOYMENTS',
  'CF_VERSION',
  'CF_SETTINGS',
  'PUBLIC_HTML',
  'PUBLIC_APK_METADATA',
  'PUBLIC_APK_CHECKSUM',
  'PUBLIC_APK',
]);
const errorTypes = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'AbortError',
  'TimeoutError',
  'AggregateError',
]);
const networkCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_ABORTED',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
function networkCode(error, depth = 0) {
  if (!error || depth > 4) return undefined;
  if (networkCodes.has(error.code)) return error.code;
  return networkCode(error.cause, depth + 1);
}
class SafeReadError extends Error {
  constructor(diagnostic) {
    super(`Remote GET failed: ${JSON.stringify(diagnostic)}`);
    this.diagnostic = Object.freeze(diagnostic);
  }
}
async function readStage(stage, request, url, options, consume) {
  if (!readStages.has(stage)) fail('Unknown GET stage.');
  let status;
  try {
    const response = await request(url, options);
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599)
      status = response.status;
    if (!response.ok)
      throw new SafeReadError({ stage, errorType: 'HTTPError', ...(status ? { status } : {}) });
    return await consume(response);
  } catch (error) {
    if (error instanceof SafeReadError) throw error;
    const causeCode = networkCode(error);
    throw new SafeReadError({
      stage,
      errorType: errorTypes.has(error?.name) ? error.name : 'UnknownError',
      ...(causeCode ? { causeCode } : {}),
      ...(status ? { status } : {}),
    });
  }
}

async function cloud({ request, accountId, token }, path, { method = 'GET', body, stage } = {}) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body instanceof FormData
        ? {}
        : { Accept: 'application/json', 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  };
  if (method === 'GET')
    return readStage(stage, request, url, options, async (response) => {
      const payload = await response.json();
      if (payload?.success !== true || payload.result === undefined)
        fail('Cloudflare GET response is invalid.');
      return payload.result;
    });
  const response = await request(url, options);
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail('Cloudflare returned invalid JSON.');
  }
  if (!response.ok || payload?.success !== true || payload.result === undefined)
    fail(`Cloudflare ${method} failed: HTTP ${response.status}.`);
  return payload.result;
}

export async function readRemote(context, config) {
  const base = `/workers/scripts/${worker}`;
  const subdomain = await cloud(context, '/workers/subdomain', { stage: 'CF_SUBDOMAIN' });
  const databases = [];
  for (let page = 1; page <= 100; page++) {
    const result = await cloud(context, `/d1/database?per_page=100&page=${page}`, {
      stage: 'CF_DATABASES',
    });
    if (!Array.isArray(result)) fail('Invalid D1 listing.');
    databases.push(...result);
    if (result.length < 100) break;
    if (page === 100) fail('D1 listing is incomplete.');
  }
  const deployments = await cloud(context, `${base}/deployments`, { stage: 'CF_DEPLOYMENTS' });
  const activeId = deployments?.deployments?.[0]?.versions?.[0]?.version_id;
  if (!idPattern.test(activeId ?? '')) fail('Active Worker version is unavailable.');
  const version = await cloud(context, `${base}/versions/${activeId}`, { stage: 'CF_VERSION' });
  const settings = await cloud(context, `${base}/script-settings`, { stage: 'CF_SETTINGS' });
  return inspectRemote({ subdomain, databases, deployments, version, settings, config });
}

async function bundleWorker() {
  await mkdir(output, { recursive: true });
  const outdir = resolve(output, 'bundle');
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
      'deploy',
      '--dry-run',
      '--config',
      resolve(root, 'wrangler.backend.json'),
      '--outdir',
      outdir,
    ],
    {
      cwd: root,
      stdio: 'pipe',
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_LOG_PATH: resolve(output, 'wrangler.log'),
      },
    },
  );
  if (result.error || result.status !== 0) fail('Worker dry-run failed.');
  const bytes = await readFile(resolve(outdir, 'cloudflare.js'));
  if (!bytes.length) fail('Worker bundle is empty.');
  return { bytes, sha256: sha256(bytes), size: bytes.length };
}

async function publicArtifacts(request) {
  const read = (path, stage) =>
    readStage(
      stage,
      request,
      origin + path,
      {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
        headers: { 'Cache-Control': 'no-cache' },
      },
      async (response) => Buffer.from(await response.arrayBuffer()),
    );
  const [html, metadata, checksum, apk] = await Promise.all([
    read('/index.html', 'PUBLIC_HTML'),
    read('/app-debug.apk.json', 'PUBLIC_APK_METADATA'),
    read('/app-debug.apk.sha256', 'PUBLIC_APK_CHECKSUM'),
    read('/app-debug.apk', 'PUBLIC_APK'),
  ]);
  let parsed;
  try {
    parsed = JSON.parse(metadata.toString('utf8'));
  } catch {
    fail('Published APK metadata is invalid.');
  }
  if (
    !/^[a-f0-9]{64}$/i.test(parsed.sha256 ?? '') ||
    parsed.sha256 !== sha256(apk) ||
    parsed.size !== apk.length ||
    !checksum.toString('utf8').includes(parsed.sha256)
  )
    fail('Published APK checksum mismatch.');
  return {
    htmlSha256: sha256(html),
    apkMetadataSha256: sha256(metadata),
    apkChecksumSha256: sha256(checksum),
    apkSha256: sha256(apk),
    apkSize: apk.length,
  };
}

export function uploadForm(bytes, metadata) {
  if (
    metadata.keep_assets !== true ||
    'assets' in metadata ||
    metadata.main_module !== 'cloudflare.js' ||
    metadata.bindings?.some((item) => item.type !== 'inherit')
  )
    fail('Unsafe Worker upload metadata.');
  const form = new FormData();
  form.set('metadata', JSON.stringify(metadata));
  form.set(
    'cloudflare.js',
    new Blob([bytes], { type: 'application/javascript+module' }),
    'cloudflare.js',
  );
  return form;
}

export async function publishVersion(context, bytes, metadata, sourceSha) {
  const base = `/workers/scripts/${worker}`;
  let uploaded;
  try {
    uploaded = await cloud(context, `${base}/versions?bindings_inherit=strict`, {
      method: 'POST',
      body: uploadForm(bytes, metadata),
    });
  } catch {
    fail(
      'VERIFY_REQUIRED: Worker version upload result is uncertain; inspect active deployment before retry.',
    );
  }
  if (!idPattern.test(uploaded?.id ?? ''))
    fail('VERIFY_REQUIRED: Cloudflare returned an invalid uploaded version.');
  let activated;
  try {
    activated = await cloud(context, `${base}/deployments`, {
      method: 'POST',
      body: {
        strategy: 'percentage',
        versions: [{ version_id: uploaded.id, percentage: 100 }],
        annotations: { 'workers/message': `MOV-WEB-RELEASE-01 ${sourceSha}` },
      },
    });
  } catch {
    fail('VERIFY_REQUIRED: deployment response is uncertain; inspect active version before retry.');
  }
  if (!activated?.id) fail('VERIFY_REQUIRED: deployment response is invalid.');
  return { versionId: uploaded.id, deploymentId: activated.id };
}

export async function prepare({
  request = fetch,
  accountId,
  token,
  buildBundle = bundleWorker,
  outputDir = output,
} = {}) {
  await mkdir(outputDir, { recursive: true });
  // A failed repeat must never leave a previous successful manifest behind.
  await rm(resolve(outputDir, 'manifest.json'), { force: true });
  await rm(resolve(outputDir, 'error.json'), { force: true });
  try {
    const source = sourceMetadata();
    const config = JSON.parse(await readFile(resolve(root, 'wrangler.backend.json'), 'utf8'));
    validateLocal({ source, config });
    const bundle = await buildBundle();
    let remote = { status: 'NOT_RUN', reason: 'CLOUDFLARE_CREDENTIALS_UNAVAILABLE' };
    if (Boolean(accountId) !== Boolean(token)) fail('Cloudflare credentials are incomplete.');
    if (accountId && token) {
      if (!/^[a-f0-9]{32}$/i.test(accountId)) fail('Invalid Cloudflare account ID.');
      const snapshot = await readRemote({ request, accountId, token }, config);
      remote = { status: 'PASS', ...snapshot, publicArtifacts: await publicArtifacts(request) };
    }
    const manifest = {
      schema: 1,
      status: 'PREPARED',
      source,
      worker,
      database,
      apiBaseUrl: origin + '/api',
      bundle: { file: 'bundle/cloudflare.js', sha256: bundle.sha256, size: bundle.size },
      remote:
        remote.status === 'PASS'
          ? {
              status: 'PASS',
              databaseId: remote.databaseId,
              previousVersionId: remote.previousVersionId,
              activeDeploymentId: remote.activeDeploymentId,
              bindingDigest: remote.bindingDigest,
              bindingTypes: remote.bindingTypes,
              settingsSummary: remote.settingsSummary,
              preservation: {
                keep_assets: true,
                bindings: 'inherit-all',
                routesAndCron: 'unchanged',
                apk: 'unchanged',
              },
              publicArtifacts: remote.publicArtifacts,
            }
          : remote,
    };
    await mkdir(outputDir, { recursive: true });
    await writeFile(resolve(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      mode: 0o600,
    });
    return manifest;
  } catch (error) {
    const diagnostic =
      error instanceof SafeReadError ? error.diagnostic : { stage: 'PREPARE', errorType: 'Error' };
    await writeFile(
      resolve(outputDir, 'error.json'),
      JSON.stringify(
        {
          schema: 1,
          status: 'FAILED',
          diagnostic,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    throw error;
  }
}

export async function deploy({
  request = fetch,
  accountId,
  token,
  expectedSourceSha,
  confirmation,
  event,
  ref,
  checkoutSha,
} = {}) {
  const source = sourceMetadata();
  const config = JSON.parse(await readFile(resolve(root, 'wrangler.backend.json'), 'utf8'));
  validateLocal({
    source,
    config,
    mode: 'deploy',
    expectedSourceSha,
    confirmation,
    event,
    ref,
    checkoutSha,
  });
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? '') || !token)
    fail('Cloudflare credentials are required.');
  const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));
  const bytes = await readFile(resolve(output, 'bundle/cloudflare.js'));
  if (
    manifest.status !== 'PREPARED' ||
    manifest.source.sourceSha !== source.sourceSha ||
    manifest.source.treeSha !== source.treeSha ||
    manifest.source.dirty ||
    manifest.bundle.sha256 !== sha256(bytes) ||
    manifest.remote.status !== 'PASS'
  )
    fail('Prepared artifact does not match the clean checkout.');
  const context = { request, accountId, token };
  const remote = await readRemote(context, config);
  if (
    remote.previousVersionId !== manifest.remote.previousVersionId ||
    remote.databaseId !== manifest.remote.databaseId ||
    remote.bindingDigest !== manifest.remote.bindingDigest
  )
    fail('Active Worker or bindings changed after preparation.');
  if (
    JSON.stringify(await publicArtifacts(request)) !==
    JSON.stringify(manifest.remote.publicArtifacts)
  )
    fail('Published assets or APK changed after preparation.');
  const published = await publishVersion(context, bytes, remote.metadata, source.sourceSha);
  const record = {
    schema: 1,
    status: 'VERIFY_REQUIRED',
    sourceSha: source.sourceSha,
    bundleSha256: sha256(bytes),
    previousVersionId: remote.previousVersionId,
    versionId: published.versionId,
    deploymentId: published.deploymentId,
    rollback: {
      strategy: 'percentage',
      versions: [{ version_id: remote.previousVersionId, percentage: 100 }],
      sql: false,
      assets: false,
    },
  };
  await writeFile(resolve(output, 'deployment.json'), JSON.stringify(record, null, 2) + '\n', {
    mode: 0o600,
  });
  return record;
}

export async function verify({ request = fetch, accountId, token } = {}) {
  const record = JSON.parse(await readFile(resolve(output, 'deployment.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));
  if (record.status !== 'VERIFY_REQUIRED' || record.sourceSha !== manifest.source.sourceSha)
    fail('Deployment record is unavailable.');
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? '') || !token)
    fail('Cloudflare credentials are required for verification.');
  const config = JSON.parse(await readFile(resolve(root, 'wrangler.backend.json'), 'utf8'));
  const remote = await readRemote({ request, accountId, token }, config);
  if (
    remote.previousVersionId !== record.versionId ||
    remote.databaseId !== manifest.remote.databaseId ||
    remote.bindingDigest !== manifest.remote.bindingDigest
  )
    fail('Active Worker or bindings changed unexpectedly.');
  if (
    JSON.stringify(await publicArtifacts(request)) !==
    JSON.stringify(manifest.remote.publicArtifacts)
  )
    fail('Published assets or APK changed after deploy.');
  const get = async (path, options = {}) =>
    request(origin + path, { redirect: 'error', signal: AbortSignal.timeout(20000), ...options });
  const health = await get('/api/health');
  const healthBody = await health.json().catch(() => null);
  if (health.status !== 200 || healthBody?.version !== manifest.source.version)
    fail('API_DEPLOY_PENDING: health check failed.');
  const preflight = await get('/api/state', {
    method: 'OPTIONS',
    headers: {
      Origin: browserOrigin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  if (
    preflight.status !== 204 ||
    preflight.headers.get('access-control-allow-origin') !== browserOrigin
  )
    fail('API_DEPLOY_PENDING: browser preflight failed.');
  const anonymous = await get('/api/state', {
    headers: { Origin: browserOrigin, Accept: 'application/json' },
  });
  const body = await anonymous.json().catch(() => null);
  if (
    anonymous.status !== 401 ||
    body?.error?.code !== 'DEVICE_AUTH_REQUIRED' ||
    anonymous.headers.get('access-control-allow-origin') !== browserOrigin ||
    !/^application\/json/i.test(anonymous.headers.get('content-type') ?? '')
  )
    fail('API_DEPLOY_PENDING: anonymous browser response failed.');
  const report = {
    ...record,
    status: 'VERIFIED',
    checks: {
      activeVersion: true,
      bindings: true,
      assetsAndApk: true,
      health: true,
      preflight: true,
      anonymous401: true,
    },
  };
  await writeFile(resolve(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'prepare';
  try {
    const credentials = {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    };
    const result =
      mode === 'prepare'
        ? await prepare(credentials)
        : mode === 'deploy'
          ? await deploy({
              ...credentials,
              expectedSourceSha: process.env.EXPECTED_SOURCE_SHA,
              confirmation: process.env.CONFIRMATION,
              event: process.env.GITHUB_EVENT_NAME,
              ref: process.env.GITHUB_REF,
              checkoutSha: process.env.GITHUB_SHA,
            })
          : mode === 'verify'
            ? await verify(credentials)
            : fail('Unknown release mode.');
    console.log(
      `${mode}: ${result.status}; source ${result.source?.sourceSha ?? result.sourceSha}; bundle ${result.bundle?.sha256 ?? result.bundleSha256}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
