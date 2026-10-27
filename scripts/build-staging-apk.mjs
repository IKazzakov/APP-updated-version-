// Compatibility command for the primary app's existing package and signing key.
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadStagingSigning } from './staging-signing.mjs';
import { buildMetadata } from './build.mjs';
const metadata = buildMetadata(fileURLToPath(new URL('..', import.meta.url)), { release: true });
// Validate the existing key before changing config or removing a published APK.
const primaryApi = 'https://movement-test-api-staging.rojoscarlos93.workers.dev/api';
const api = process.env.VITE_API_BASE_URL || primaryApi;
if (api !== primaryApi) throw new Error('The primary APK requires its existing primary API.');
const signing = await loadStagingSigning(fileURLToPath(new URL('..', import.meta.url)));
const configPath = new URL('../capacitor.config.json', import.meta.url),
  stringsPath = new URL('../android/app/src/main/res/values/strings.xml', import.meta.url);
const original = await readFile(configPath, 'utf8'),
  strings = await readFile(stringsPath, 'utf8');
const config = JSON.parse(original);
config.appId = signing.appId;
config.appName = signing.appName;
try {
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  await writeFile(
    stringsPath,
    strings.replace(
      /(<string name="(?:app_name|title_activity_main)">)[^<]+/g,
      (_, prefix) => prefix + signing.appName,
    ),
  );
  const result = spawnSync(process.execPath, ['scripts/build-apk.mjs'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
    env: {
      ...process.env,
      MOVEMENT_BUILD_METADATA: JSON.stringify(metadata),
      VITE_API_BASE_URL: api,
      MOVEMENT_ANDROID_CHANNEL: 'staging',
      MOVEMENT_STAGING_KEYSTORE: signing.keystore,
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status || 0;
} finally {
  await writeFile(configPath, original);
  await writeFile(stringsPath, strings);
}
