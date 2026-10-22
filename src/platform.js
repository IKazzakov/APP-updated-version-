import {Capacitor, CapacitorHttp} from '@capacitor/core';

const defaultNativeApi = 'https://ais-pre-unwfcvynbcdvpumsvvws2k-220077059769.europe-west2.run.app/api';
const nativeApi = (import.meta.env?.VITE_API_BASE_URL || defaultNativeApi).replace(/\/+$/, '');

export const isNativeApp = () => Capacitor.isNativePlatform();
export const getApiBaseUrl = (native = isNativeApp()) => native ? nativeApi : '/api';
export const invitationOrigin = (webOrigin, native = isNativeApp()) => native ? new URL(nativeApi).origin : webOrigin;

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
        responseType: 'json', connectTimeout: 15000, readTimeout: 15000,
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
