import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Only the public certificate fingerprint belongs in git. The private key comes
// from a repository secret (CI) or an ignored local backup, never a build cache.
export async function readStagingConfig(root) {
  const config = JSON.parse(await readFile(join(root, 'android/staging-signing.json'), 'utf8'));
  assert.match(config.appId, /^com\.movement\.squat\.staging(?:\.[a-z][a-z0-9_]*)*$/);
  assert.ok(typeof config.appName === 'string' && config.appName.trim());
  assert.match(config.certificateSha256, /^[a-f0-9]{64}$/);
  return config;
}

export function assertStagingCertificate(config, actual) {
  assert.equal(
    actual,
    config.certificateSha256,
    'Staging signing certificate differs from the pinned certificate. ' +
      'Do not replace the installed app or rotate its key automatically.',
  );
}

export async function loadStagingSigning(root, env = process.env) {
  const config = await readStagingConfig(root);
  const keystore = resolve(
    env.MOVEMENT_STAGING_KEYSTORE || join(root, 'work/signing/staging-debug.keystore'),
  );
  try {
    await access(keystore);
  } catch {
    throw new Error(
      'Staging signing key is missing. Restore its backup or configure the ' +
        'STAGING_ANDROID_KEYSTORE_BASE64 Actions secret; a new key will not be generated.',
    );
  }
  assert.ok(env.JAVA_HOME, 'Set JAVA_HOME to JDK 21.');
  const result = spawnSync(
    join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool'),
    ['-exportcert', '-keystore', keystore, '-storepass', 'android', '-alias', 'androiddebugkey'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    'Cannot read the public staging certificate. Check its alias and debug-key password.',
  );
  assert.ok(result.stdout.length, 'The staging certificate is empty.');
  assertStagingCertificate(config, createHash('sha256').update(result.stdout).digest('hex'));
  return { ...config, keystore };
}
