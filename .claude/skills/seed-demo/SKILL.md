---
name: seed-demo
description: Seed realistic demo data (creators that went live, stuck creators, recent ones) by sending signed onboarding webhooks to a given --url, then print a summary and a cleanup SQL for evt_demo_ data. Use to prepare a demo or recording of the live and stuck-creator Slack alerts.
---

# Seed demo data

Sends signed webhooks through the real endpoint (never writes to the database directly). Signing and sending are shared with `send-test-webhook` (`../send-test-webhook/webhook.mjs`). `WEBHOOK_SECRET` comes from `.env.local` via Node's `--env-file`, so you never need to read the env file yourself.

## Usage
```bash
node --env-file=.env.local .claude/skills/seed-demo/seed.mjs --url http://localhost:3000
```
`--url` is required. It accepts the full webhook URL or a bare origin, in which case `/api/webhooks/onboarding` is added.

## What it creates (times relative to now)
| Group | Creators | State | Expected |
|---|---|---|---|
| Live | Lucas Ferreira, Mariana Costa, Rafael Oliveira | full flow; onboarding 19h, 41h, 68h | one Slack "live" message each, while seeding |
| Stuck | Beatriz Santos (signed up 51h), Camila Rocha (app installed 75h), Thiago Almeida (signed up 98h), Pedro Henrique Lima (app installed 118h) | 50h to 5 days on the current step | alerted by the next cron run, longest stuck first |
| Recent | Juliana Martins (signed up 6h), Gabriel Souza (app installed 30h) | under 48h | **not** alerted |

- Emails are on `@example.com`, and event ids are `evt_demo_<creator>_<step>`.
- Creator ids are fixed, so re-running without cleanup is safe: every event comes back `duplicate`.

## Trigger the cron locally
Run this without printing the secret:
```bash
node --env-file=.env.local -e "fetch('http://localhost:3000/api/cron/stuck-creators',{headers:{authorization:'Bearer '+process.env.CRON_SECRET}}).then(r=>r.text()).then(console.log)"
```
Expect `{"alerted":4}` and one Slack message listing the 4 stuck creators. A second run gives `{"alerted":0}`.

## Reset and record again
The script prints this cleanup SQL. Run it in the Supabase SQL editor, then seed again:
```sql
delete from public.creators where id in (select creator_id from public.webhook_events where starts_with(event_id, 'evt_demo_'));
delete from public.webhook_events where starts_with(event_id, 'evt_demo_');
```

## Cautions
- The server posts **real Slack messages** (3 live messages while seeding, and the stuck alert when the cron runs) to whatever `SLACK_WEBHOOK_URL` it is configured with.
- Use it against local or dev, not production.

Report the summary table and any non-200 responses.
