// Daily wall-clock scheduling uses the bundled IANA database. Older host/Node
// databases still apply Vancouver's repealed November 2026 clock change.
import moment from 'moment-timezone';

const occurrences = new Map();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function zone(timeZone) {
  const record = typeof timeZone === 'string' && moment.tz.zone(timeZone);
  if (!record) throw new TypeError('Invalid IANA time zone');
  return record;
}

function validDate(value, label = 'date') {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`Invalid ${label}`);
  return date;
}

function localParts(date, timeZone) {
  const at = date.getTime();
  // utcOffset comes from Moment Timezone's bundled transition table, not the
  // OS timezone or Intl. UTC getters then expose the corresponding wall clock.
  const wallClock = new Date(at - zone(timeZone).utcOffset(at) * MINUTE).toISOString();
  return { date: wallClock.slice(0, 10), time: wallClock.slice(11, 16) };
}

export function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new TypeError('A daily schedule is required');
  }
  if (typeof schedule.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    throw new TypeError('Send time must use HH:mm between 00:00 and 23:59');
  }
  if (typeof schedule.timeZone !== 'string' || !schedule.timeZone || schedule.timeZone.length > 100) {
    throw new TypeError('An IANA time zone is required');
  }
  zone(schedule.timeZone);
  const normalized = { time: schedule.time, timeZone: schedule.timeZone };
  if (schedule.updatedAt !== undefined) {
    if (typeof schedule.updatedAt !== 'string' || !schedule.updatedAt) throw new TypeError('Invalid schedule update date');
    normalized.updatedAt = validDate(schedule.updatedAt, 'schedule update date').toISOString();
  }
  return normalized;
}

export function localDateKey(date, timeZone) {
  return localParts(validDate(date), timeZone).date;
}

export function formatLocalDateTime(date, timeZone) {
  const local = localParts(validDate(date), timeZone);
  const [year, month, day] = local.date.split('-').map(Number);
  return `${year}年${month}月${day}日 ${local.time}`;
}

function nextDateKey(dateKey) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
}

function occurrenceOnDate(schedule, dateKey) {
  const key = `${schedule.timeZone}|${schedule.time}|${dateKey}`;
  if (occurrences.has(key)) return occurrences.get(key);
  const midnightUTC = Date.parse(`${dateKey}T00:00:00Z`);
  let occurrence = null;
  // UTC offsets range from -12 to +14 hours. Scanning actual instants also
  // resolves repeated hours (first occurrence) and missing hours (first later
  // real minute) without guessing an offset or hard-coding DST transition dates.
  for (let at = midnightUTC - 15 * 60 * MINUTE; at < midnightUTC + 36 * 60 * MINUTE; at += MINUTE) {
    const local = localParts(new Date(at), schedule.timeZone);
    if (local.date === dateKey && local.time >= schedule.time) {
      occurrence = at;
      break;
    }
  }
  if (occurrences.size >= 128) occurrences.delete(occurrences.keys().next().value);
  occurrences.set(key, occurrence);
  return occurrence;
}

function eligibleOccurrence(schedule, dateKey, state) {
  if (state.lastAttemptDate === dateKey) return null;
  const at = occurrenceOnDate(schedule, dateKey);
  if (at === null) return null;
  // Saving a time that has already passed must not send a surprise email.
  // It takes effect at that time on the next eligible day instead.
  if (schedule.updatedAt && Date.parse(schedule.updatedAt) > at) return null;
  return at;
}

export function shouldRun(schedule, now = new Date(), state = {}) {
  const normalized = validateSchedule(schedule);
  const current = validDate(now);
  const at = eligibleOccurrence(normalized, localDateKey(current, normalized.timeZone), state);
  return at !== null && current.getTime() >= at;
}

export function nextScheduledRun(schedule, from = new Date(), state = {}) {
  const normalized = validateSchedule(schedule);
  const current = validDate(from);
  let dateKey = localDateKey(current, normalized.timeZone);
  // A delayed cron may catch up later the same local day. Report "now" for
  // a due run, while already-attempted days always advance to tomorrow.
  for (let days = 0; days < 8; days += 1) {
    const at = eligibleOccurrence(normalized, dateKey, state);
    if (at !== null) return new Date(Math.max(at, current.getTime()));
    dateKey = nextDateKey(dateKey);
  }
  throw new RangeError('No scheduled run found in the next seven days');
}
