#!/usr/bin/env node

import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { localDateKey, shouldRun, validateSchedule } from './schedule.js';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));

function readState(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('Invalid scheduler state');
    if (state.lastAttemptDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(state.lastAttemptDate)) {
      throw new TypeError('Invalid scheduler attempt date');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function writeState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

// The production entry point is invoked under flock. Claiming the local date
// before starting the sender also prevents duplicate mail after a restart or
// an ambiguous delivery failure. Failed attempts remain visible and are not
// automatically retried; the operator can investigate before retrying.
export function runScheduledDigest({
  configDir = process.env.FOLLOW_BUILDERS_HOME || join(homedir(), '.follow-builders'),
  now = new Date(),
  execute = spawnSync
} = {}) {
  const schedule = validateSchedule(JSON.parse(readFileSync(join(configDir, 'schedule.json'), 'utf8')));
  const statePath = join(configDir, 'schedule-state.json');
  const previous = readState(statePath);
  if (!shouldRun(schedule, now, previous)) return { status: 'skipped', exitCode: 0 };

  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const state = {
    ...previous,
    lastAttemptDate: localDateKey(now, schedule.timeZone),
    lastAttemptAt: now.toISOString(),
    scheduleTime: schedule.time,
    timeZone: schedule.timeZone,
    status: 'running'
  };
  writeState(statePath, state);

  let result;
  try {
    result = execute(process.execPath, [join(scriptsDirectory, 'run-digest.js')], {
      cwd: scriptsDirectory,
      env: process.env,
      stdio: 'inherit',
      timeout: 15 * 60 * 1000
    });
  } catch (error) {
    result = { status: 1, error: { code: error.code || 'RUNNER_ERROR' } };
  }
  const exitCode = Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? result.status : 1;
  const completed = new Date().toISOString();
  state.status = exitCode === 0 ? 'sent' : 'failed';
  state.lastFinishedAt = completed;
  state.exitCode = exitCode;
  if (exitCode === 0) state.lastSuccessAt = completed;
  if (result.error?.code) state.errorCode = String(result.error.code);
  else delete state.errorCode;
  if (result.signal) state.signal = String(result.signal);
  else delete state.signal;
  writeState(statePath, state);
  return { status: state.status, exitCode, lastAttemptDate: state.lastAttemptDate };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runScheduledDigest();
    if (result.status !== 'skipped') console.log(JSON.stringify({ event: 'scheduled-digest', ...result }));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(JSON.stringify({ event: 'scheduled-digest', status: 'error', message: error.message }));
    process.exitCode = 1;
  }
}
