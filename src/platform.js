import {Capacitor, CapacitorHttp} from '@capacitor/core';

const legacyNativeApi = 'https://ais-pre-unwfcvynbcdvpumsvvws2k-220077059769.europe-west2.run.app/api';
const defaultNativeApi = 'https://movement-test-api.rojoscarlos93.workers.dev/api';
const nativeApi = (import.meta.env?.VITE_API_BASE_URL || defaultNativeApi).replace(/\/+$/, '');
const SERVER_KEY = 'movement.nativeApi';

export function normalizeApiUrl(value) {
  const url = new URL(String(value).trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Укажите HTTPS-адрес сервера без пароля, параметров и #.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/api') ? path : `${path}/api`;
  return url.href;
}

export function setNativeApiUrl(value) {
  const url = normalizeApiUrl(value);
  localStorage.setItem(SERVER_KEY, url);
  return url;
}

function currentNativeApi() {
  try {return normalizeApiUrl(localStorage.getItem(SERVER_KEY) || nativeApi);} catch {return nativeApi;}
}

export const isNativeApp = () => Capacitor.isNativePlatform();
export function migrateLegacyApi(){
  if(!isNativeApp())return;
  try{
    if(localStorage.getItem('movement.backend-migration.2.5.2'))return;
    const saved=localStorage.getItem(SERVER_KEY);
    const old=[legacyNativeApi,'https://ais-dev-unwfcvynbcdvpumsvvws2k-220077059769.europe-west2.run.app/api'];
    if(saved&&old.includes(normalizeApiUrl(saved)))localStorage.removeItem(SERVER_KEY);
    localStorage.setItem('movement.backend-migration.2.5.2','done');
  }catch{/* A custom address is preserved if storage is unavailable. */}
}
export const getApiBaseUrl = (native = isNativeApp()) => native ? currentNativeApi() : '/api';
export const invitationOrigin = (webOrigin, native = isNativeApp()) => native ? new URL(currentNativeApi()).origin : webOrigin;
// Existing queues remain on their original server. Switching a test server
// must never deliver another server's pending events or round IDs there.
export const profileStorageId = id => isNativeApp() && currentNativeApi() !== legacyNativeApi ? `${currentNativeApi()}|${id}` : id;

// Native HTTP uses Android's cookie jar and avoids WebView CORS/preflight.
// POST still carries the API origin required by the existing server.
export async function nativeApiRequest(url, {method = 'GET', headers = {}, body, signal} = {}, http = CapacitorHttp) {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('Для Android API требуется HTTPS.');
  if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
  let onAbort;
  const abort = new Promise((_, reject) => {
    onAbort = () => reject(new DOMException('Request aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, {once: true});
  });
  try {
    const response = await Promise.race([
      http.request({
        url: target.href, method,
        headers: {...headers, ...(!['GET', 'HEAD'].includes(method) ? {Origin: target.origin} : {})},
        ...(body === undefined ? {} : {data: body}),
        responseType: 'text', connectTimeout: 15000, readTimeout: 15000,
      }),
      abort,
    ]);
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      json: async () => typeof response.data === 'string' ? JSON.parse(response.data) : response.data,
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
