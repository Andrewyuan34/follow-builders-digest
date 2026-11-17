# Daily delivery and self-service settings

This fork continues consuming Zara Zhang's public feeds. The upstream feed-generation workflow needs its own collection credentials; it is not needed for this deployment.

Requirements: Node.js 22+, Linux cron/flock, and an HTTPS reverse proxy. Run `npm ci` from `scripts` before deployment. User configuration and credentials stay outside the repository in `~/.follow-builders` (or `FOLLOW_BUILDERS_HOME`).

Keep the existing `config.json` and `.env` (DeepSeek and Resend credentials). Create `schedule.json`:

```json
{"time":"12:00","timeZone":"America/Vancouver","updatedAt":"2026-11-16T00:00:00.000Z"}
```

Use the actual setup time for `updatedAt`; a newly selected time that has already passed takes effect the next day. Copy `settings.env.example` to `~/.follow-builders/.settings.env`, use your HTTPS domain, and generate a 32-byte random token. Keep the directory mode `700` and credential files mode `600`. The email link grants permission to change delivery time; do not share it publicly.

Install `follow-builders-settings.service` (adjust the user and paths if needed), enable it, and configure Caddy using `Caddyfile.example`. Add your DNS record and allow TCP 80/443. The application binds only to `127.0.0.1:8788`; Caddy manages HTTPS. Do not enable access logging that stores settings-link query tokens.

Replace the old daily digest cron with exactly one entry:

```cron
* * * * * /usr/bin/flock -n /tmp/follow-builders.lock /home/ubuntu/follow-builders/run.sh
```

The lightweight check runs each minute and only sends at the configured Vancouver time, automatically following daylight saving time. The scheduler records the attempted local date before calling the sender. A repeated DST hour, restarts, or changing the time after today's delivery cannot produce a second scheduled email. Missing DST times run at the next valid local minute. A delayed check catches up within the same day; there is no backlog from previous days.

If migrating an already-running daily task, seed `schedule-state.json` with that day's `lastAttemptDate` and the last successful timestamp to avoid a duplicate on cutover. The scheduler logs failures and does not automatically retry ambiguous delivery failures. Inspect `digest.log` and `schedule-state.json` before any manual retry. Running `node scripts/run-digest.js` directly sends an actual email and bypasses daily deduplication.

The settings webpage allows changing the time only. It preserves recipient and API configuration. Opening a mail link is read-only; saves require a secure session, same-origin form submission, and CSRF token. Configuration writes are atomic. Keep the settings token secret; rotating it invalidates old links and sessions.

Run `npm test` in `scripts` for scheduling, DST, duplicate suppression, settings authorization, form validation, and email-footer tests. Tests use fake credentials and intercepted delivery requests; they never send email.
