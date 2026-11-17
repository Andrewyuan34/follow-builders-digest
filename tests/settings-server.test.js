import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createSettingsServer, writeSchedule} from '../scripts/settings-server.js';
import {getSettingsUrl} from '../scripts/settings-config.js';

const token = 'c'.repeat(43);
const baseUrl = 'https://digest.example.com';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'digest-settings-'));
  await writeSchedule(home, {time:'12:00', timeZone:'America/Vancouver'});
  const server = createSettingsServer({home, baseUrl, token, now:() => new Date('2026-11-16T18:00:00Z')});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, {recursive:true, force:true});});
  const url = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${url}/settings?token=${token}`, {redirect:'manual'});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const page = await fetch(`${url}/settings`, {headers:{cookie}});
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  return {home,url,cookie,csrf,login,html,page};
}

test('email URL is HTTPS and requires both configuration values', () => {
  assert.equal(getSettingsUrl({}, {}), null);
  assert.equal(getSettingsUrl({}, {FOLLOW_BUILDERS_SETTINGS_BASE_URL:baseUrl, FOLLOW_BUILDERS_SETTINGS_TOKEN:token}), `${baseUrl}/settings?token=${token}`);
  assert.throws(() => getSettingsUrl({}, {FOLLOW_BUILDERS_SETTINGS_BASE_URL:'http://example.com', FOLLOW_BUILDERS_SETTINGS_TOKEN:token}));
});

test('GET link exchanges token for secure session and never changes schedule', async t => {
  const f = await fixture(t);
  assert.equal(f.login.status,303);
  assert.equal(f.login.headers.get('location'), '/settings');
  assert.equal(f.login.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(f.page.headers.get('referrer-policy'), 'same-origin');
  assert.match(f.login.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.match(f.html, /12:00/);
  assert.ok(!f.html.includes(token));
  assert.equal(JSON.parse(await readFile(join(f.home,'schedule.json'))).time, '12:00');
});

test('valid form saves desired time, fixed Vancouver zone, and update timestamp', async t => {
  const f = await fixture(t);
  const result = await fetch(`${f.url}/settings`, {method:'POST',redirect:'manual',headers:{cookie:f.cookie,origin:baseUrl,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:f.csrf,time:'08:30'})});
  assert.equal(result.status,303);
  assert.deepEqual(JSON.parse(await readFile(join(f.home,'schedule.json'))), {time:'08:30',timeZone:'America/Vancouver',updatedAt:'2026-11-16T18:00:00.000Z'});
});

test('bad session, bad CSRF, foreign origin, and invalid time cannot alter schedule', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/settings`)).status,401);
  assert.equal((await fetch(`${f.url}/settings?token=wrong`,{redirect:'manual'})).status,401);
  for (const [origin,csrf,time,status] of [[baseUrl,'bad','08:00',403],['https://evil.example',f.csrf,'08:00',403],[baseUrl,f.csrf,'25:99',400]]) {
    const result = await fetch(`${f.url}/settings`, {method:'POST',redirect:'manual',headers:{cookie:f.cookie,origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,time})});
    assert.equal(result.status,status);
  }
  assert.equal(JSON.parse(await readFile(join(f.home,'schedule.json'))).time,'12:00');
});

test('unrelated user configuration is never modified', async t => {
  const f = await fixture(t);
  await writeFile(join(f.home,'config.json'),'{"delivery":{"method":"email"}}');
  await fetch(`${f.url}/settings`, {method:'POST',redirect:'manual',headers:{cookie:f.cookie,origin:baseUrl,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:f.csrf,time:'17:45'})});
  assert.equal(await readFile(join(f.home,'config.json'),'utf8'),'{"delivery":{"method":"email"}}');
});
