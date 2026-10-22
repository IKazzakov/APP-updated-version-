import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, access, mkdir, chmod, copyFile, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const android = join(root, 'android');
const windows = process.platform === 'win32';
const binary = name => windows ? `${name}.exe` : name;
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const config = JSON.parse(await readFile(join(root, 'capacitor.config.json'), 'utf8'));
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const javaHome = process.env.JAVA_HOME;
assert.ok(javaHome, 'Укажите JAVA_HOME с JDK 21 (не только JRE).');
assert.ok(sdk, 'Укажите ANDROID_HOME с Android SDK 36 и Build Tools 36.0.0.');
await access(join(javaHome, 'bin', binary('javac')));
await access(join(sdk, 'platforms', 'android-36', 'android.jar'));
const tools = join(sdk, 'build-tools', '36.0.0');
await access(join(tools, binary('aapt')));
const toolEnv = {...process.env};
toolEnv.ANDROID_USER_HOME ||= join(root, 'work', 'android-user');
toolEnv.GRADLE_USER_HOME ||= join(root, 'work', 'gradle');
await mkdir(toolEnv.ANDROID_USER_HOME, {recursive: true});
await mkdir(toolEnv.GRADLE_USER_HOME, {recursive: true});
function run(command, args, {cwd = root, capture = false} = {}) {
  const result = spawnSync(command, args, {cwd, env: toolEnv, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', shell: windows && /\.(bat|cmd)$/.test(command)});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed. ${capture ? result.stderr : ''}`);
  return result.stdout;
}
const javaVersion = run(join(javaHome, 'bin', binary('javac')), ['-version'], {capture: true});
assert.match(javaVersion, /javac 21\./, 'Для Capacitor 8 требуется JDK 21.');
await writeFile(join(android, 'local.properties'), `sdk.dir=${resolve(sdk).replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`);

// Do not package a previous downloadable APK inside the new APK.
await rm(join(root, 'public', 'app-debug.apk'), {force: true});
await rm(join(root, 'public', 'app-debug.apk.sha256'), {force: true});
run(process.execPath, ['scripts/build.mjs']);
run(process.execPath, ['scripts/sync-android.mjs']);
if (!windows) await chmod(join(android, 'gradlew'), 0o755);
run(join(android, windows ? 'gradlew.bat' : 'gradlew'), [':app:clean', 'assembleDebug', '--no-daemon', '--max-workers=2', '--console=plain'], {cwd: android});

const apk = join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const bytes = await readFile(apk);
assert.ok(bytes.length > 1_000_000, 'APK is missing or incomplete.');
assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'APK is not a ZIP archive.');
const apksigner = join(tools, windows ? 'apksigner.bat' : 'apksigner');
run(apksigner, ['verify', '--verbose', apk]);
const badging = run(join(tools, binary('aapt')), ['dump', 'badging', apk], {capture: true});
assert.ok(badging.includes(`name='${config.appId}'`), 'Unexpected Android package.');
assert.ok(badging.includes(`versionName='${pkg.version}'`), 'Android version differs from package.json.');
assert.ok(badging.includes("targetSdkVersion:'36'"), 'Unexpected target SDK.');
for (const permission of ['INTERNET', 'CAMERA', 'WAKE_LOCK']) assert.ok(badging.includes(`android.permission.${permission}`), `Missing ${permission}.`);
const entries = run(join(tools, binary('aapt')), ['list', apk], {capture: true});
for (const file of ['index.html', 'assets/models/pose_landmarker_full.task', 'assets/vision.worker.js', 'assets/wasm/vision_wasm_internal.wasm']) {
  assert.ok(entries.split(/\r?\n/).includes(`assets/public/${file}`), `Missing packaged resource: ${file}`);
}
assert.ok(!entries.includes('assets/public/app-debug.apk'), 'The previous APK was embedded recursively.');
assert.ok(!entries.includes('assets/public/assets/aistudio/'), 'An AI Studio source export was included in the APK.');
const hash = createHash('sha256').update(bytes).digest('hex');
const artifacts = join(root, 'work', 'artifacts');
await mkdir(artifacts, {recursive: true});
for (const dir of [artifacts, join(root, 'public'), join(root, 'dist', 'client')]) {
  await copyFile(apk, join(dir, 'app-debug.apk'));
  await writeFile(join(dir, 'app-debug.apk.sha256'), `${hash}  app-debug.apk\n`);
  await writeFile(join(dir, 'app-debug.apk.json'), JSON.stringify({version:pkg.version,sha256:hash,size:bytes.length})+'\n');
}
await writeFile(join(artifacts, 'android-manifest.txt'), badging);
console.log(`APK ${pkg.version}: ${join(artifacts, 'app-debug.apk')} (${bytes.length} bytes)`);
console.log(`SHA-256: ${hash}`);
