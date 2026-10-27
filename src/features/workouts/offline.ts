import { deviceSecret } from '../../device-auth.js';
import { getApiBaseUrl } from '../../platform.js';
import { isSnapshot } from '../../shared/contracts/validate.ts';
import type { AppState } from '../../shared/contracts/api.ts';

const PREFIX = 'movement.workout-profile-cache.';
let generation = 0;
async function scope() {
  const base = getApiBaseUrl(),
    secret = deviceSecret(base);
  if (!secret) return null;
  const binding = new TextEncoder().encode(`${location.origin}|${base}|${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', binding);
  return {
    key: PREFIX + encodeURIComponent(`${location.origin}|${base}`),
    tag: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join(''),
  };
}
/** Cache no credential; a different or forgotten device secret cannot read this profile. */
export async function rememberWorkoutProfile(state: AppState | null) {
  if (!state?.profile) return;
  const operation = generation;
  try {
    const binding = await scope();
    if (!binding || operation !== generation) return;
    localStorage.setItem(
      binding.key,
      JSON.stringify({ tag: binding.tag, cachedAt: Date.now(), state }),
    );
  } catch {
    /* the durable program journal remains mandatory; this cache is optional */
  }
}
export async function restoreWorkoutProfile(): Promise<AppState | null> {
  if (navigator.onLine !== false) return null;
  try {
    const binding = await scope();
    if (!binding) return null;
    const data: unknown = JSON.parse(localStorage.getItem(binding.key) || 'null');
    if (
      !data ||
      typeof data !== 'object' ||
      !('tag' in data) ||
      data.tag !== binding.tag ||
      !('cachedAt' in data) ||
      typeof data.cachedAt !== 'number' ||
      Date.now() - data.cachedAt < 0 ||
      Date.now() - data.cachedAt > 86400000 ||
      !('state' in data) ||
      !isSnapshot(data.state) ||
      data.state.partial === true ||
      !data.state.profile
    )
      return null;
    // A legacy minute never resumes from an offline cache, including its timer.
    const active = data.state.activeRound;
    return {
      ...data.state,
      activeRound: active && active.endsAt + 15000 >= Date.now() ? active : null,
    };
  } catch {
    return null;
  }
}
export function forgetWorkoutProfile() {
  generation++;
  try {
    const key = PREFIX + encodeURIComponent(`${location.origin}|${getApiBaseUrl()}`);
    localStorage.removeItem(key);
  } catch {
    /* credential isolation still prevents another identity restoring it */
  }
}
