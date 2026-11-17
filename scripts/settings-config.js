import { timingSafeEqual } from 'node:crypto';

export function settingsOptions(config = {}, env = process.env) {
  const baseUrl = env.FOLLOW_BUILDERS_SETTINGS_BASE_URL || config.settings?.baseUrl;
  const token = env.FOLLOW_BUILDERS_SETTINGS_TOKEN;
  if (!baseUrl || !token) return null;
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Settings base URL must be an HTTPS origin');
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('Settings token must contain at least 256 bits of randomness');
  return {baseUrl: url.origin, token};
}

export function getSettingsUrl(config = {}, env = process.env) {
  const options = settingsOptions(config, env);
  if (!options) return null;
  const url = new URL('/settings', options.baseUrl);
  url.searchParams.set('token', options.token);
  return url.href;
}

export function secretEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
