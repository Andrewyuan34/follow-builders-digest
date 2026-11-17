import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatLocalDateTime, localDateKey, nextScheduledRun, shouldRun, validateSchedule } from '../scripts/schedule.js';
import { runScheduledDigest } from '../scripts/scheduled-digest.js';

const noon = { time: '12:00', timeZone: 'America/Vancouver' };
const iso = value => value.toISOString();

test('historical Vancouver noon follows the 2025 winter and summer offsets', () => {
  assert.equal(iso(nextScheduledRun(noon, new Date('2025-11-16T18:00:00Z'))), '2025-11-16T20:00:00.000Z');
  assert.equal(iso(nextScheduledRun(noon, new Date('2025-07-16T18:00:00Z'))), '2025-07-16T19:00:00.000Z');
});

test('Vancouver noon in November 2026 is 19:00 UTC under permanent Pacific time', () => {
  assert.equal(iso(nextScheduledRun(noon, new Date('2026-11-17T18:00:00Z'))), '2026-11-17T19:00:00.000Z');
  assert.equal(shouldRun(noon, new Date('2026-11-17T18:59:59Z')), false);
  assert.equal(shouldRun(noon, new Date('2026-11-17T19:00:00Z')), true);
  assert.equal(formatLocalDateTime(new Date('2026-11-17T19:00:00Z'), noon.timeZone), '2026年11月17日 12:00');
  assert.equal(formatLocalDateTime(new Date('2025-11-17T19:00:00Z'), noon.timeZone), '2025年11月17日 11:00');
});

test('daily dates use Vancouver rather than the server calendar date', () => {
  assert.equal(localDateKey(new Date('2026-11-17T01:00:00Z'), noon.timeZone), '2026-11-16');
  assert.equal(shouldRun(noon, new Date('2026-11-17T01:00:00Z'), { lastAttemptDate: '2026-11-16' }), false);
});

test('historical noon changes UTC hour across both 2025 daylight-saving transitions', () => {
  assert.equal(iso(nextScheduledRun(noon, new Date('2025-03-09T07:00:00Z'), { lastAttemptDate: '2025-03-08' })), '2025-03-09T19:00:00.000Z');
  assert.equal(iso(nextScheduledRun(noon, new Date('2025-11-02T06:00:00Z'), { lastAttemptDate: '2025-11-01' })), '2025-11-02T20:00:00.000Z');
});

test('March 8 2026 is the final Vancouver spring-forward, with no November rollback', () => {
  assert.equal(iso(nextScheduledRun(noon, new Date('2026-03-07T18:00:00Z'))), '2026-03-07T20:00:00.000Z');
  assert.equal(iso(nextScheduledRun(noon, new Date('2026-03-08T18:00:00Z'))), '2026-03-08T19:00:00.000Z');
  const gap = { ...noon, time: '02:30' };
  assert.equal(iso(nextScheduledRun(gap, new Date('2026-03-08T08:00:00Z'))), '2026-03-08T10:00:00.000Z');
  assert.equal(iso(nextScheduledRun(noon, new Date('2026-11-01T06:00:00Z'), { lastAttemptDate: '2026-10-31' })), '2026-11-01T19:00:00.000Z');
  assert.equal(iso(nextScheduledRun(noon, new Date('2027-01-17T18:00:00Z'))), '2027-01-17T19:00:00.000Z');
  assert.equal(iso(nextScheduledRun(gap, new Date('2027-03-14T08:00:00Z'))), '2027-03-14T09:30:00.000Z');
});

test('a nonexistent spring clock time runs at the first later real minute', () => {
  const schedule = { ...noon, time: '02:30' };
  assert.equal(iso(nextScheduledRun(schedule, new Date('2025-03-09T08:00:00Z'))), '2025-03-09T10:00:00.000Z');
  assert.equal(shouldRun(schedule, new Date('2025-03-09T09:59:00Z')), false);
  assert.equal(shouldRun(schedule, new Date('2025-03-09T10:00:00Z')), true);
});

test('a repeated autumn clock time is attempted only once', () => {
  const schedule = { ...noon, time: '01:30' };
  assert.equal(iso(nextScheduledRun(schedule, new Date('2025-11-02T07:00:00Z'))), '2025-11-02T08:30:00.000Z');
  const state = { lastAttemptDate: '2025-11-02', status: 'sent' };
  assert.equal(shouldRun(schedule, new Date('2025-11-02T09:30:00Z'), state), false);
  assert.equal(iso(nextScheduledRun(schedule, new Date('2025-11-02T09:30:00Z'), state)), '2025-11-03T09:30:00.000Z');
});

test('saving a time already past waits until tomorrow', () => {
  const schedule = { ...noon, updatedAt: '2026-11-16T19:30:00Z' };
  assert.equal(shouldRun(schedule, new Date('2026-11-16T20:00:00Z')), false);
  assert.equal(iso(nextScheduledRun(schedule, new Date('2026-11-16T20:00:00Z'))), '2026-11-17T19:00:00.000Z');
});

test('changing the time after sending does not send twice that day', () => {
  const schedule = { ...noon, time: '17:00', updatedAt: '2026-11-16T22:00:00Z' };
  const state = { lastAttemptDate: '2026-11-16' };
  assert.equal(shouldRun(schedule, new Date('2026-11-17T00:00:00Z'), state), false);
  assert.equal(iso(nextScheduledRun(schedule, new Date('2026-11-16T22:00:00Z'), state)), '2026-11-18T00:00:00.000Z');
});

test('missed cron ticks catch up on the same day, not with multiple emails', () => {
  const now = new Date('2026-11-16T22:00:00Z');
  assert.equal(shouldRun(noon, now), true);
  assert.equal(iso(nextScheduledRun(noon, now)), iso(now));
  assert.equal(shouldRun(noon, now, { lastAttemptDate: '2026-11-16', status: 'failed' }), false);
});

test('invalid times and zones are rejected before changing or sending', () => {
  for (const time of ['24:00', '12:60', '12:0', 'noon', '12:00; command']) {
    assert.throws(() => validateSchedule({ ...noon, time }));
  }
  assert.throws(() => validateSchedule({ ...noon, timeZone: 'Mars/Olympus' }));
  assert.throws(() => validateSchedule({ ...noon, updatedAt: 'not-a-date' }));
});

function fixture(t, schedule = noon) {
  const folder = mkdtempSync(join(tmpdir(), 'follow-builders-schedule-test-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, 'schedule.json'), JSON.stringify(schedule));
  return folder;
}

test('runner durably claims the date before executing and preserves failure exit code', t => {
  const configDir = fixture(t);
  let calls = 0;
  const execute = (command, args, options) => {
    calls += 1;
    const claimed = JSON.parse(readFileSync(join(configDir, 'schedule-state.json'), 'utf8'));
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.lastAttemptDate, '2026-11-16');
    assert.ok(args[0].endsWith('run-digest.js'));
    assert.equal(options.stdio, 'inherit');
    assert.equal(options.env, process.env);
    return { status: 7 };
  };
  const now = new Date('2026-11-16T19:00:00Z');
  assert.deepEqual(runScheduledDigest({ configDir, now, execute }), { status: 'failed', exitCode: 7, lastAttemptDate: '2026-11-16' });
  assert.deepEqual(runScheduledDigest({ configDir, now, execute }), { status: 'skipped', exitCode: 0 });
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(join(configDir, 'schedule-state.json'), 'utf8')).status, 'failed');
});

test('runner records successful send and can run again the next local day', t => {
  const configDir = fixture(t);
  let calls = 0;
  const execute = () => { calls += 1; return { status: 0 }; };
  assert.equal(runScheduledDigest({ configDir, now: new Date('2026-11-16T19:00:00Z'), execute }).status, 'sent');
  assert.equal(runScheduledDigest({ configDir, now: new Date('2026-11-17T19:00:00Z'), execute }).status, 'sent');
  assert.equal(calls, 2);
  const state = JSON.parse(readFileSync(join(configDir, 'schedule-state.json'), 'utf8'));
  assert.equal(state.lastAttemptDate, '2026-11-17');
  assert.ok(state.lastSuccessAt);
});

test('corrupt persisted state fails closed without invoking the sender', t => {
  const configDir = fixture(t);
  writeFileSync(join(configDir, 'schedule-state.json'), '{bad json');
  assert.throws(() => runScheduledDigest({ configDir, now: new Date('2026-11-16T19:00:00Z'), execute() { assert.fail('Must not send'); } }));
});
