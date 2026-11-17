import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { settingsOptions, secretEquals } from './settings-config.js';
import { validateSchedule, nextScheduledRun, formatLocalDateTime } from './schedule.js';

const COOKIE = '__Host-digest_session';
const SESSION_SECONDS = 86400;
const ZONE = 'America/Vancouver';
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function writeSchedule(home, schedule) {
  await mkdir(home, {recursive: true, mode: 0o700});
  const destination = join(home, 'schedule.json');
  const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(schedule, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  await rename(temporary, destination);
}

function renderPage({time, next, csrf, saved = false, error = ''}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>发送时间 · AI Builders Digest</title><style>
  :root{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#192724;background:#f1f5f1}*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:54px 20px;display:grid;place-items:center}.wrap{width:100%;max-width:470px}.brand{font-size:12px;font-weight:750;letter-spacing:2px;color:#50635b;margin-bottom:22px}.card{background:#fff;border:1px solid #dfe8df;border-radius:24px;padding:34px;box-shadow:0 16px 55px #243c2810}.badge{display:inline-block;font-size:12px;font-weight:650;border-radius:30px;background:#edf3ed;color:#42624d;padding:7px 12px}h1{font-size:30px;line-height:1.25;letter-spacing:-1px;margin:24px 0 12px}p{font-size:14px;color:#68756d;line-height:1.8;margin:0 0 24px}label{display:block;font-size:13px;font-weight:650;margin:26px 0 10px}input[type=time]{width:100%;padding:17px 18px;font:600 30px system-ui;color:#1c3428;border:1px solid #cddace;border-radius:13px;background:#fbfdfb;min-height:76px;outline:none}input:focus{border-color:#24754a;box-shadow:0 0 0 3px #287d4918}button{width:100%;border:0;border-radius:12px;background:#225c3d;color:white;padding:16px;margin-top:22px;font-size:15px;font-weight:650;cursor:pointer}button:hover{background:#194b30}button:focus-visible{outline:3px solid #91bf9b;outline-offset:3px}.next{border-top:1px solid #edf0eb;margin:25px 0 0;padding-top:20px;font-size:12px;color:#6a786f;line-height:1.8}.next strong{display:block;font-size:14px;font-weight:600;color:#334e3e;margin-top:4px}.notice{padding:12px 14px;margin:22px 0 0;border-radius:10px;background:#edf7ee;color:#27633d;font-size:14px}.error{background:#fff0e9;color:#95472b}.foot{font-size:12px;line-height:1.9;color:#7d8980;text-align:center;padding:18px 20px}@media(max-width:420px){body{padding:30px 16px}.card{padding:25px}h1{font-size:27px}}
  </style></head><body><main class="wrap"><div class="brand">AI BUILDERS DIGEST</div><section class="card"><span class="badge">温哥华 · Vancouver</span><h1>几点收邮件？</h1><p>每天一封，按你的时间来。<br>始终按温哥华当地时间发送。</p>${saved ? '<div class="notice" role="status">已保存，之后会按新的时间发送。</div>' : ''}${error ? `<div class="notice error" role="alert">${escapeHtml(error)}</div>` : ''}<form action="/settings" method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label for="time">每天的发送时间（温哥华时间）</label><input id="time" name="time" type="time" step="60" required value="${escapeHtml(time)}"><button type="submit">保存发送时间</button></form><div class="next">下次发送<strong>${escapeHtml(next)}</strong></div></section><div class="foot">以后想改时间，随时点开邮件底部的设置链接。<br>如果今天已经发过，就从明天开始。</div></main></body></html>`;
}

export function createSettingsServer({home, baseUrl, token, now = () => new Date()}) {
  settingsOptions({}, {FOLLOW_BUILDERS_SETTINGS_BASE_URL: baseUrl, FOLLOW_BUILDERS_SETTINGS_TOKEN: token});
  const sign = value => createHmac('sha256', token).update(value).digest('base64url');
  const csrfFor = session => sign(`csrf:${session}`);
  function sessionFrom(request) {
    const cookies = (request.headers.cookie || '').split(';').map(x => x.trim());
    const value = cookies.find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!value || value.length > 200) return null;
    const parts = value.split('.');
    if (parts.length !== 3) return null;
    const [timestamp, nonce, signature] = parts;
    if (!/^\d{13}$/.test(timestamp) || !/^[A-Za-z0-9_-]{22}$/.test(nonce) || !secretEquals(sign(`${timestamp}.${nonce}`), signature)) return null;
    const age = now().getTime() - Number(timestamp);
    return age >= 0 && age <= SESSION_SECONDS * 1000 ? value : null;
  }
  async function showPage(response, session, {saved = false, error = '', status = 200} = {}) {
    const stored = await readJson(join(home, 'schedule.json'), {time: '12:00', timeZone: ZONE});
    const schedule = {...stored, ...validateSchedule(stored)};
    const state = await readJson(join(home, 'schedule-state.json'), {});
    const next = nextScheduledRun(schedule, now(), state);
    const formatted = formatLocalDateTime(next, ZONE);
    response.setHeader('Referrer-Policy', 'same-origin');
    response.writeHead(status, {'Content-Type':'text/html; charset=utf-8'});
    response.end(renderPage({time: schedule.time, next: `${formatted} · 温哥华`, csrf: csrfFor(session), saved, error}));
  }
  const server = http.createServer({maxHeaderSize: 8192}, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const url = new URL(request.url, baseUrl);
      if (request.method === 'GET' && url.pathname === '/healthz') {
        response.writeHead(200, {'Content-Type': 'application/json'}); response.end('{"ok":true}'); return;
      }
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(302, {Location: '/settings'}); response.end(); return;
      }
      if (url.pathname !== '/settings') { response.writeHead(404); response.end('Not found'); return; }
      if (request.method === 'GET' && url.searchParams.has('token')) {
        if (!secretEquals(url.searchParams.get('token'), token)) { response.writeHead(401); response.end('Invalid settings link'); return; }
        const issued = `${now().getTime()}.${randomBytes(16).toString('base64url')}`;
        const session = `${issued}.${sign(issued)}`;
        response.writeHead(303, {Location:'/settings', 'Set-Cookie':`${COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`});
        response.end(); return;
      }
      const session = sessionFrom(request);
      if (!session) {
        response.writeHead(401, {'Content-Type':'text/html; charset=utf-8'});
        response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>打开设置</title><body style="font-family:system-ui;padding:40px;line-height:1.8"><h2>从简报邮件打开设置</h2><p>请点击你的 AI Builders Digest 邮件底部的“调整发送时间”链接。</p></body></html>'); return;
      }
      if (request.method === 'GET') { await showPage(response, session, {saved:url.searchParams.get('saved') === '1'}); return; }
      if (request.method !== 'POST') { response.writeHead(405, {Allow:'GET, POST'}); response.end(); return; }
      if (request.headers.origin !== baseUrl || request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
        response.writeHead(403); response.end('Invalid form origin'); return;
      }
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 2048) { response.writeHead(413); response.end('Form too large'); return; }
      }
      const form = new URLSearchParams(body);
      if (!secretEquals(form.get('csrf'), csrfFor(session))) { response.writeHead(403); response.end('Invalid form token'); return; }
      let schedule;
      try {
        if (form.getAll('time').length !== 1) throw new Error('Invalid time');
        schedule = validateSchedule({time:form.get('time'), timeZone:ZONE});
      } catch {
        await showPage(response, session, {status:400, error:'请选择有效时间，例如 12:00。'}); return;
      }
      await writeSchedule(home, {...schedule, updatedAt:now().toISOString()});
      response.writeHead(303, {Location:'/settings?saved=1'}); response.end();
    } catch (error) {
      console.error(JSON.stringify({event:'settings_request_failed', type:error.name}));
      if (!response.headersSent) response.writeHead(500);
      response.end('Settings temporarily unavailable');
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const home = process.env.FOLLOW_BUILDERS_HOME || join(homedir(), '.follow-builders');
  loadEnv({path:join(home, '.settings.env')});
  const options = settingsOptions();
  if (!options) throw new Error('Configure settings base URL and token before starting');
  const port = Number(process.env.FOLLOW_BUILDERS_SETTINGS_PORT || 8788);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid settings port');
  const server = createSettingsServer({home, ...options});
  server.listen(port, '127.0.0.1', () => console.log(`Digest settings listening on 127.0.0.1:${port}`));
}
