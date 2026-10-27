import { rm } from 'node:fs/promises';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionCodeFor } from '../src/shared/build.ts';

const temporaryPaths = new Set([
  'capacitor.config.json',
  'android/app/src/main/res/values/strings.xml',
  'public/app-debug.apk',
  'public/app-debug.apk.sha256',
]);
/** Capture before the APK scripts' temporary changes; never use GITHUB_SHA as HEAD. */
export function buildMetadata(
  root,
  { release = false, inherited = process.env.MOVEMENT_BUILD_METADATA } = {},
) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const config = readFileSync(resolve(root, 'src/config.js'), 'utf8').match(
    /export const VERSION\s*=\s*['"]([^'"]+)['"]/,
  );
  if (config?.[1] !== pkg.version) throw new Error('Build version differs from src/config.js');
  const versionCode = versionCodeFor(pkg.version);
  let sourceSha = null,
    dirty = null,
    paths = [];
  try {
    sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Invalid source SHA');
    const status = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
      { cwd: root, encoding: 'utf8' },
    );
    paths = status
      .split('\0')
      .filter(Boolean)
      .map((line) => line.slice(3));
    dirty = paths.length > 0;
  } catch (error) {
    sourceSha = null;
    dirty = null;
    if (release || inherited)
      throw new Error('Cannot establish build checkout metadata', { cause: error });
  }
  let build = { version: pkg.version, versionCode, sourceSha, dirty };
  if (inherited) {
    let saved;
    try {
      saved = JSON.parse(inherited);
    } catch {
      throw new Error('Invalid inherited build metadata');
    }
    if (
      saved.version !== pkg.version ||
      saved.versionCode !== versionCode ||
      saved.sourceSha !== sourceSha ||
      typeof saved.dirty !== 'boolean'
    )
      throw new Error('Stale or invalid build metadata');
    if (saved.dirty === false && paths.some((path) => !temporaryPaths.has(path)))
      throw new Error('Source changed after metadata capture');
    build = { version: pkg.version, versionCode, sourceSha, dirty: saved.dirty };
  }
  if (release && (!/^[a-f0-9]{40}$/.test(build.sourceSha ?? '') || build.dirty !== false))
    throw new Error('A signed APK requires a full source SHA and clean source checkout');
  return Object.freeze(build);
}

export async function buildClient(root = resolve(import.meta.dirname, '..')) {
  const metadata = buildMetadata(root);
  const env = { ...process.env, MOVEMENT_BUILD_METADATA: JSON.stringify(metadata) };
  // A static-to-Worker upgrade must not package obsolete output from an older
  // build (including removed exercise assets). Only generated dist is cleared.
  await rm('dist', { recursive: true, force: true });
  for (const args of [
    ['scripts/prepare-assets.mjs'],
    ['node_modules/vite/bin/vite.js', 'build'],
    ['scripts/build-validate.mjs'],
  ]) {
    const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildClient();
