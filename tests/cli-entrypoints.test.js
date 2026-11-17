import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

const repository = fileURLToPath(new URL('..', import.meta.url));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'digest-symlink-entrypoint-'));
  const linkedRepo = join(directory, 'linked-repository');
  const home = join(directory, 'empty-user-config');
  mkdirSync(home);
  symlinkSync(repository, linkedRepo, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => {
    // Remove only the link before recursively removing our temporary directory;
    // the real repository must never become a cleanup traversal target.
    unlinkSync(linkedRepo);
    rmSync(directory, { recursive: true, force: true });
  });
  const env = { ...process.env, FOLLOW_BUILDERS_HOME: home };
  for (const key of Object.keys(env)) {
    if (/^(?:NODE_OPTIONS|RESEND_API_KEY|DEEPSEEK_API_KEY|TELEGRAM_BOT_TOKEN)$/i.test(key) || /^FOLLOW_BUILDERS_SETTINGS_/i.test(key)) delete env[key];
  }
  return { linkedRepo, home, env };
}

test('scheduler invoked through a directory symlink executes its CLI entry point', t => {
  const { linkedRepo, env } = fixture(t);
  // No schedule exists. Reaching main must fail before reading any credentials
  // or spawning a sender; an incorrectly skipped main would exit successfully.
  const result = spawnSync(process.execPath, [join(linkedRepo, 'scripts', 'scheduled-digest.js')], {
    env, encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.status, 1, `Expected missing-config failure, got ${result.status}: ${result.stderr}`);
  const error = JSON.parse(result.stderr.trim());
  assert.equal(error.event, 'scheduled-digest');
  assert.equal(error.status, 'error');
  assert.match(error.message, /ENOENT/);
  assert.match(error.message, /schedule\.json/);
});

test('settings server invoked through a directory symlink listens instead of exiting', async t => {
  const { linkedRepo, env } = fixture(t);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  Object.assign(env, {
    FOLLOW_BUILDERS_SETTINGS_BASE_URL: 'https://digest.example.com',
    FOLLOW_BUILDERS_SETTINGS_TOKEN: 'fake_test_only_'.padEnd(43, 'x'),
    FOLLOW_BUILDERS_SETTINGS_PORT: String(port)
  });
  const child = spawn(process.execPath, [join(linkedRepo, 'scripts', 'settings-server.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Settings server did not start: ${stderr}`)), 10000);
    const inspect = () => { if (stdout.includes(`listening on 127.0.0.1:${port}`)) finish(); };
    const onExit = code => finish(new Error(`Settings server exited before listening (${code}): ${stderr}`));
    const onError = error => finish(error);
    function finish(error) {
      clearTimeout(timer);
      child.stdout.off('data', inspect);
      child.off('exit', onExit);
      child.off('error', onError);
      error ? reject(error) : resolve();
    }
    child.stdout.on('data', inspect);
    child.once('exit', onExit);
    child.once('error', onError);
    inspect();
  });
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
