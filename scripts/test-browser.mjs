import { spawn } from 'node:child_process';
const groups = [
  { mode: 'cookie', suites: ['mvp', 'auto-start', 'weekly', 'rating-fixes', 'native-start'] },
  { mode: 'device', suites: ['backend', 'diagnostics', 'architecture', 'workouts'] },
];
const port = Number(process.env.TESTSERVERPORT || 4185),
  origin = `http://127.0.0.1:${port}`;
function run(file, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [file], { stdio: 'inherit', env });
    p.once('error', reject);
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${file}: exit ${code}`))));
  });
}
for (const { mode, suites } of groups) {
  const env = {
    ...process.env,
    TESTSERVERPORT: String(port),
    TEST_AUTH_MODE: mode,
    TEST_ORIGIN: origin,
  };
  const server = spawn(process.execPath, ['tests/browser-server.mjs'], { stdio: 'inherit', env });
  let exited = false;
  const exit = new Promise((resolve) =>
    server.once('exit', () => {
      exited = true;
      resolve();
    }),
  );
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (exited) throw new Error('Browser fixture exited before startup');
      try {
        ready = (await fetch(origin + '/__test/health')).ok;
      } catch {}
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error('Browser fixture startup timed out');
    for (const suite of suites) await run(`tests/browser-${suite}.mjs`, env);
  } finally {
    if (!exited) server.kill('SIGTERM');
    await exit;
  }
}
