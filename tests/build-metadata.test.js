import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildMetadata } from '../scripts/build.mjs';
function fixture(t, git = true) {
  const root = mkdtempSync(join(tmpdir(), 'movement-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'public'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '2.6.0' }));
  writeFileSync(join(root, 'src/config.js'), "export const VERSION = '2.6.0';\n");
  writeFileSync(join(root, 'capacitor.config.json'), '{}\n');
  writeFileSync(join(root, 'public/app-debug.apk'), 'old-apk');
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Build Test',
        '-c',
        'user.email=build@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'source',
      ],
      { cwd: root },
    );
  }
  return root;
}
test('build records actual checkout, Android versionCode and dirty changes; release rejects dirty sources', (t) => {
  const root = fixture(t),
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const clean = buildMetadata(root, { release: true, inherited: null });
  assert.deepEqual(clean, { version: '2.6.0', versionCode: 20600, sourceSha: head, dirty: false });
  writeFileSync(join(root, 'src/new.ts'), 'export const changed=true;\n');
  assert.equal(buildMetadata(root, { inherited: null }).dirty, true);
  assert.throws(() => buildMetadata(root, { release: true, inherited: null }), /clean source/);
  assert.throws(
    () => buildMetadata(root, { release: true, inherited: JSON.stringify(clean) }),
    /Source changed/,
  );
});
test('one source snapshot survives only the documented temporary APK operations, never a stale SHA', (t) => {
  const root = fixture(t),
    clean = buildMetadata(root, { release: true, inherited: null });
  writeFileSync(join(root, 'capacitor.config.json'), '{"appId":"temporary"}');
  rmSync(join(root, 'public/app-debug.apk'));
  writeFileSync(join(root, 'public/app-debug.apk.json'), '{"release":"download metadata"}');
  assert.deepEqual(buildMetadata(root, { release: true, inherited: JSON.stringify(clean) }), clean);
  assert.throws(
    () =>
      buildMetadata(root, {
        release: true,
        inherited: JSON.stringify({ ...clean, sourceSha: 'b'.repeat(40) }),
      }),
    /Stale/,
  );
  assert.throws(
    () => buildMetadata(root, { release: true, inherited: 'invalid' }),
    /Invalid inherited/,
  );
  writeFileSync(join(root, 'src/config.js'), "export const VERSION = '2.7.0';\n");
  assert.throws(() => buildMetadata(root, { inherited: null }), /version differs/);
});
test('dev without Git reports null provenance; final APK refuses unknown provenance', (t) => {
  const root = fixture(t, false);
  assert.deepEqual(buildMetadata(root, { inherited: null }), {
    version: '2.6.0',
    versionCode: 20600,
    sourceSha: null,
    dirty: null,
  });
  assert.throws(() => buildMetadata(root, { release: true, inherited: null }), /checkout metadata/);
});
