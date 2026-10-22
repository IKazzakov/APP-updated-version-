import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readStagingConfig,
  loadStagingSigning,
  assertStagingCertificate,
} from '../scripts/staging-signing.mjs';

const config = {
  appId: 'com.movement.squat.staging.ui',
  appName: 'Движение Тест UI',
  certificateSha256: 'a'.repeat(64),
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'movement-signing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'android'));
  return root;
}

test('staging identity cannot target the production package or an invalid certificate', async (t) => {
  const root = await fixture(t);
  for (const change of [
    { appId: 'com.movement.squat' },
    { appId: 'com.movement.squat.stagingExtra' },
    { appName: '' },
    { certificateSha256: 'unverified' },
  ]) {
    await writeFile(
      join(root, 'android/staging-signing.json'),
      JSON.stringify({ ...config, ...change }),
    );
    await assert.rejects(readStagingConfig(root));
  }
  await writeFile(join(root, 'android/staging-signing.json'), JSON.stringify(config));
  assert.deepEqual(await readStagingConfig(root), config);
});

test('a missing persistent staging key fails instead of generating a replacement', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'android/staging-signing.json'), JSON.stringify(config));
  const keystore = join(root, 'missing.keystore');
  await assert.rejects(
    loadStagingSigning(root, { MOVEMENT_STAGING_KEYSTORE: keystore }),
    /key is missing/,
  );
  await assert.rejects(access(keystore), { code: 'ENOENT' });
});

test('a changed staging certificate is rejected before an APK can be published', () => {
  assertStagingCertificate(config, config.certificateSha256);
  assert.throws(
    () => assertStagingCertificate(config, 'b'.repeat(64)),
    /differs from the pinned certificate/,
  );
});
