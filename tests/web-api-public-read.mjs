// Fixed, read-only public GETs. Never log a URL, header, body or raw exception.
const root = 'https://movement-test-api-staging.rojoscarlos93.workers.dev/';
const index = `${root}index.html`;
const knownTypes = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'AbortError',
  'TimeoutError',
  'AggregateError',
]);
const knownCodes = new Set([
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

function field(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

function diagnosis(error) {
  const seen = new Set();
  const pending = [[error, 0]];
  let visits = 0;
  let causeCode = 'UNKNOWN';
  while (pending.length && visits < 32) {
    const [value, depth] = pending.shift();
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    visits++;
    const code = field(value, 'code');
    if (knownCodes.has(code)) {
      causeCode = code;
      break;
    }
    if (depth >= 4) continue;
    pending.push([field(value, 'cause'), depth + 1]);
    const errors = field(value, 'errors');
    if (Array.isArray(errors))
      for (let i = 0; i < Math.min(errors.length, 8); i++)
        pending.push([field(errors, i), depth + 1]);
  }
  const type = field(error, 'name');
  return { errorType: knownTypes.has(type) ? type : 'UnknownError', causeCode };
}

const releaseOptions = (redirect = 'error') => ({
  method: 'GET',
  redirect,
  signal: AbortSignal.timeout(60000),
  headers: { 'Cache-Control': 'no-cache' },
});

async function probe(label, url, options, observeRedirect = false) {
  let phase = 'REQUEST_CONSTRUCTION';
  let status;
  try {
    // Check construction separately; fetch below still uses the original options.
    new Request(url, options);
    phase = 'REQUEST';
    const response = await fetch(url, options);
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599)
      status = response.status;
    const location = observeRedirect ? response.headers.get('location') : null;
    let locationIsRoot = false;
    if (location) {
      try {
        locationIsRoot = new URL(location, url).href === root;
      } catch {}
    }
    phase = 'BODY';
    await response.arrayBuffer();
    const result = {
      probe: label,
      transport: 'PASS',
      ...(status ? { status } : {}),
      http2xx: response.ok,
      ...(observeRedirect ? { locationIsRoot } : {}),
    };
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    const result = {
      probe: label,
      transport: 'FAILED',
      phase,
      ...diagnosis(error),
      ...(status ? { status } : {}),
    };
    console.log(JSON.stringify(result));
    return result;
  }
}

const release = await probe('release_index', index, releaseOptions());
await probe('index_redirect_observation', index, releaseOptions('manual'), true);
const releaseRoot = await probe('root_release_options', root, releaseOptions());
const minimalRoot = await probe('root_minimal', root, {
  method: 'GET',
  redirect: 'manual',
  signal: AbortSignal.timeout(60000),
});
if (
  release.transport !== 'PASS' ||
  !release.http2xx ||
  releaseRoot.transport !== 'PASS' ||
  !releaseRoot.http2xx ||
  minimalRoot.transport !== 'PASS' ||
  !minimalRoot.http2xx
)
  process.exitCode = 1;
