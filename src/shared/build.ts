import { VERSION } from '../config.js';

export interface BuildMetadata {
  version: string;
  versionCode: number;
  sourceSha: string | null;
  dirty: boolean | null;
}
declare const __MOVEMENT_BUILD__: BuildMetadata;

/** The same version formula as android/app/build.gradle. */
export function versionCodeFor(version: string): number {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid build version');
  const [major, minor, patch] = version.split('.').map(Number);
  const code = major! * 10000 + minor! * 100 + patch!;
  if (!Number.isSafeInteger(code) || code < 1 || code > 2100000000)
    throw new Error('Invalid Android versionCode');
  return code;
}

export const CLIENT_BUILD: Readonly<BuildMetadata> = Object.freeze(
  typeof __MOVEMENT_BUILD__ === 'undefined'
    ? { version: VERSION, versionCode: versionCodeFor(VERSION), sourceSha: null, dirty: null }
    : __MOVEMENT_BUILD__,
);

/** Only this dedicated report field may contain a sanitized API origin/path. */
export function safeApiBaseUrl(value: unknown, origin?: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}
