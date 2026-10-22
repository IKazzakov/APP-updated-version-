import assert from 'node:assert/strict';
import {access, readFile, rm, cp} from 'node:fs/promises';
import {resolve, join, relative} from 'node:path';
import {spawnSync} from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(join(root, 'capacitor.config.json'), 'utf8'));
const client = join(root, 'dist', 'client');
const stage = resolve(root, config.webDir);
assert.equal(stage, join(root, 'dist', 'android-client'), 'Android staging must be separate from web downloads.');
await access(join(client, 'index.html'));
await rm(stage, {recursive: true, force: true});
await cp(client, stage, {recursive: true, filter: file => {
  const path = relative(client, file).replace(/\\/g, '/');
  return !/\.(apk|aab)(\.sha256)?$/.test(path) && !/^assets\/aistudio(?:\/|$)/.test(path);
}});
await rm(join(root, 'android', 'app', 'src', 'main', 'assets', 'public'), {recursive: true, force: true});
const result = spawnSync(process.execPath, [join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor'), 'sync', 'android'], {cwd: root, stdio: 'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
