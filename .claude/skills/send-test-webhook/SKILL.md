---
name: send-test-webhook
description: Send a correctly signed onboarding webhook to the local dev server to test the endpoint end to end. Use when you need to manually verify the webhook handler, replay an event, or test bad signatures and old timestamps.
---

# Send a test webhook

The dev server must be running (`npm run dev`). The script reads `WEBHOOK_SECRET` from `.env.local` through Node's `--env-file`, so you never need to read the env file yourself.

## Usage
```bash
node --env-file=.env.local .claude/skills/send-test-webhook/send.mjs --step signup
node --env-file=.env.local .claude/skills/send-test-webhook/send.mjs --step app_installed --creator <uuid>
node --env-file=.env.local .claude/skills/send-test-webhook/send.mjs --step payment_done --creator <uuid>
```

## Options
| Flag | Default | Purpose |
|---|---|---|
| `--step` | `signup` | `signup`, `app_installed`, `payment_done` |
| `--creator` | random uuid | reuse the id printed by the first call to walk the full flow |
| `--event` | random | fixed `event_id` to test duplicates (send twice) |
| `--bad-signature` | off | send a wrong signature, expect 401 |
| `--old` | off | timestamp 10 minutes ago, expect 401 |
| `--url` | `http://localhost:3000/api/webhooks/onboarding` | target |

## Full flow check
1. `--step signup`, copy the printed creator id
2. `--step app_installed --creator <id>`
3. `--step payment_done --creator <id>`, expect a Slack "live" message
4. Repeat step 3 with the same `--event`, expect `duplicate`

Report the status code and body of each call.
