// A separate package protects the installed 2.5.2 app and its local credentials.
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadStagingSigning } from './staging-signing.mjs';
// Validate the existing key before changing config or removing a published APK.
const signing = await loadStagingSigning(fileURLToPath(new URL('..', import.meta.url)));
const configPath = new URL('../capacitor.config.json', import.meta.url),
  stringsPath = new URL('../android/app/src/main/res/values/strings.xml', import.meta.url);
const original = await readFile(configPath, 'utf8'),
  strings = await readFile(stringsPath, 'utf8');
const config = JSON.parse(original);
config.appId = signing.appId;
config.appName = signing.appName;
const api =
  process.env.VITE_API_BASE_URL ||
  'https://movement-test-api-staging.rojoscarlos93.workers.dev/api';
if (!/^https:\/\/movement-test-api-staging\.[a-z0-9-]+\.workers\.dev\/api$/.test(api))
  throw new Error('A staging APK requires the isolated staging API.');
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
