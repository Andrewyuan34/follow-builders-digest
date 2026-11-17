import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const FAKE_API_KEY = 're_testing_not_a_real_key_DO_NOT_SEND';
const FAKE_SETTINGS_TOKEN = 'test_only_'.padEnd(43, 'x');
const ORIGIN = 'https://digest.example.com';
const recipient = 'test-recipient@example.invalid';
const sender = fileURLToPath(new URL('../scripts/deliver.js', import.meta.url));

function fixture(t, { settings = true, method = 'email', response = 'ok', origin = ORIGIN } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'follow-builders-delivery-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ delivery: { method, email: recipient } }));
  writeFileSync(join(home, '.env'), `RESEND_API_KEY=${FAKE_API_KEY}\n`);
  if (settings) {
    writeFileSync(join(home, '.settings.env'), `FOLLOW_BUILDERS_SETTINGS_BASE_URL=${origin}\nFOLLOW_BUILDERS_SETTINGS_TOKEN=${FAKE_SETTINGS_TOKEN}\n`);
  }
  const capture = join(home, 'captured-requests.jsonl');
  const hook = join(home, 'deny-network-and-capture.mjs');
  // There is deliberately no reference to the original fetch. Any unexpected
  // request fails locally, so a test can never send a real email or contact an API.
  writeFileSync(hook, `
    import {appendFileSync} from 'node:fs';
    globalThis.fetch = async (input, options = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url !== 'https://api.resend.com/emails' || options.method !== 'POST') {
        throw new Error('Test blocked an unexpected network request');
      }
      if (options.headers.Authorization !== 'Bearer ' + ${JSON.stringify(FAKE_API_KEY)}) {
        throw new Error('Test refused a non-test API credential');
      }
      const body = JSON.parse(options.body);
      appendFileSync(${JSON.stringify(capture)}, JSON.stringify({url, method:options.method, body}) + '\\n');
      if (${JSON.stringify(response)} === 'error-echo-token') {
        return new Response(JSON.stringify({message:'Rejected test payload ' + ${JSON.stringify(FAKE_SETTINGS_TOKEN)} + ' ' + ${JSON.stringify(FAKE_API_KEY)}}), {status:422, headers:{'Content-Type':'application/json'}});
      }
      return new Response(JSON.stringify({id:'mock-only-email-not-sent'}), {status:200, headers:{'Content-Type':'application/json'}});
    };
  `);
  const env = { ...process.env };
  // Do not let an operator's real environment change the safety of this fixture.
  for (const name of Object.keys(env)) {
    if (/^FOLLOW_BUILDERS_/i.test(name) || /^(?:RESEND_API_KEY|DEEPSEEK_API_KEY|TELEGRAM_BOT_TOKEN|NODE_OPTIONS)$/i.test(name)) delete env[name];
  }
  env.FOLLOW_BUILDERS_HOME = home;
  return {
    run(text) {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, sender], {
        cwd: resolve(home), env, input: text, encoding: 'utf8', timeout: 15000
      });
      const requests = existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      return { ...result, requests };
    }
  };
}

test('email subprocess adds a text settings link and a safe HTML footer', t => {
  const digest = '每日简报\n<script>not executable</script> & "quotes"';
  const result = fixture(t).run(digest);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.requests.length, 1);
  const { body } = result.requests[0];
  assert.deepEqual(body.to, [recipient]);
  assert.equal(body.from, 'AI Builders Digest <digest@resend.dev>');
  assert.match(body.subject, /^AI Builders Digest/);
  const settingsUrl = `${ORIGIN}/settings?token=${FAKE_SETTINGS_TOKEN}`;
  assert.ok(body.text.startsWith(digest));
  assert.ok(body.text.includes(`调整发送时间：${settingsUrl}`));
  assert.ok(body.html.includes(`href="${settingsUrl}"`));
  assert.match(body.html, />调整发送时间<\/a>/);
  assert.ok(body.html.includes('&lt;script&gt;not executable&lt;/script&gt;'));
  assert.ok(!body.html.includes('<script>'));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(FAKE_SETTINGS_TOKEN));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(FAKE_API_KEY));
});

test('email subprocess preserves the plain-text payload when settings are unconfigured', t => {
  const digest = 'Original digest\n第二行\n';
  const result = fixture(t, { settings: false }).run(digest);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.requests.length, 1);
  const { body } = result.requests[0];
  assert.equal(body.text, digest);
  assert.equal(Object.hasOwn(body, 'html'), false);
  assert.ok(!body.text.includes('调整发送时间'));
});

test('stdout delivery never includes the private settings URL', t => {
  const digest = 'Console digest\n第二行';
  const result = fixture(t, { method: 'stdout' }).run(digest);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.requests.length, 0);
  assert.equal(result.stdout.trimEnd(), digest);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(FAKE_SETTINGS_TOKEN));
});

test('empty digest does not send even when settings are enabled', t => {
  const result = fixture(t).run(' \n\t');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.requests.length, 0);
  assert.equal(JSON.parse(result.stdout).status, 'skipped');
});

test('invalid settings origin fails before contacting the email service', t => {
  const result = fixture(t, { origin: 'http://digest.example.com' }).run('Digest');
  assert.equal(result.status, 1);
  assert.equal(result.requests.length, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(FAKE_SETTINGS_TOKEN));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(FAKE_API_KEY));
});

test('email service errors cannot echo settings tokens or API keys into logs', t => {
  const result = fixture(t, { response: 'error-echo-token' }).run('Digest');
  assert.equal(result.status, 1);
  assert.equal(result.requests.length, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.ok(!output.includes(FAKE_SETTINGS_TOKEN), 'Settings token must be redacted from delivery logs');
  assert.ok(!output.includes(FAKE_API_KEY), 'API key must be redacted from delivery logs');
});
