import { readPublicHtml } from '../scripts/release-web-api.mjs';

// Fixed, read-only GETs. Never log a URL, header, body or raw exception.
const root = 'https://movement-test-api-staging.rojoscarlos93.workers.dev/';
const knownTypes = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'AbortError',
  'TimeoutError',
  'AggregateError',
  'HTTPError',
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
const phases = new Set(['REQUEST_CONSTRUCTION', 'REQUEST', 'HTTP_RESPONSE', 'BODY']);

function field(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

function networkCode(error) {
  const seen = new Set();
  const pending = [[error, 0]];
  let visits = 0;
  while (pending.length && visits < 32) {
    const [value, depth] = pending.shift();
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value))
      continue;
    seen.add(value);
    visits++;
    const code = field(value, 'code');
    if (knownCodes.has(code)) return code;
    if (depth >= 4) continue;
    pending.push([field(value, 'cause'), depth + 1]);
    const errors = field(value, 'errors');
    try {
      if (Array.isArray(errors))
        for (let i = 0; i < Math.min(errors.length, 8); i++)
          pending.push([field(errors, i), depth + 1]);
    } catch {}
  }
  return 'UNKNOWN';
}

function statusFields(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? { responseReceived: true, status, http2xx: status >= 200 && status < 300 }
    : { responseReceived: false };
}

async function productionProbe() {
  let status;
  let calls = 0;
  try {
    await readPublicHtml(async (url, options) => {
      const headers = new Headers(options.headers);
      if (
        url !== root ||
        options.method !== 'GET' ||
        options.redirect !== 'error' ||
        !(options.signal instanceof AbortSignal) ||
        headers.has('authorization') ||
        headers.has('proxy-authorization')
      )
        throw new Error('Unexpected public GET configuration.');
      calls++;
      const response = await fetch(url, options);
      status = response.status;
      return response;
    });
    if (calls !== 1) throw new Error('Unexpected public GET count.');
    const result = {
      probe: 'release_html',
      result: 'PASS',
      ...statusFields(status),
      bodyRead: true,
    };
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    const d = field(error, 'diagnostic');
    const type = field(d, 'errorType');
    const code = field(d, 'causeCode');
    const phase = field(d, 'phase');
    const result = {
      probe: 'release_html',
      result: 'FAILED',
      phase: phases.has(phase) ? phase : 'UNKNOWN',
      errorType: knownTypes.has(type) ? type : 'UnknownError',
      ...(type === 'HTTPError' ? {} : { causeCode: knownCodes.has(code) ? code : 'UNKNOWN' }),
      ...(field(d, 'category') === 'REDIRECT_REJECTED' ? { category: 'REDIRECT_REJECTED' } : {}),
      ...statusFields(status),
      bodyRead: false,
    };
    console.log(JSON.stringify(result));
    return result;
  }
}

async function minimalProbe() {
  let phase = 'REQUEST_CONSTRUCTION';
  let status;
  try {
    const options = { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(60000) };
    new Request(root, options);
    phase = 'REQUEST';
    const response = await fetch(root, options);
    status = response.status;
    phase = 'BODY';
    await response.arrayBuffer();
    const result = {
      probe: 'root_minimal',
      result: response.ok ? 'PASS' : 'FAILED',
      ...statusFields(status),
      bodyRead: true,
    };
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    const type = field(error, 'name');
    const result = {
      probe: 'root_minimal',
      result: 'FAILED',
      phase,
      errorType: knownTypes.has(type) ? type : 'UnknownError',
      causeCode: networkCode(error),
      ...statusFields(status),
      bodyRead: false,
    };
    console.log(JSON.stringify(result));
    return result;
  }
}

const production = await productionProbe();
const minimal = await minimalProbe();
if (production.result !== 'PASS' || minimal.result !== 'PASS') process.exitCode = 1;
