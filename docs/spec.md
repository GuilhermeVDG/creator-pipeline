# Spec: Creator onboarding pipeline

## Goal
Every new creator goes through a web onboarding flow (signup, install the creator app, set up payment). Each step fires a webhook. This service receives those webhooks, keeps the creator's status in sync, and tells the ops team on Slack when a creator goes live or gets stuck.

## 1. Webhook endpoint

`POST /api/webhooks/onboarding`

### Headers
| Header | Value |
|---|---|
| `x-timestamp` | Unix time in seconds when the event was sent |
| `x-signature` | `sha256=` + hex HMAC-SHA256 of `${timestamp}.${rawBody}` using `WEBHOOK_SECRET` |

### Body
```json
{
  "event_id": "evt_01J9ZK3...",
  "step": "signup",
  "occurred_at": "2026-11-18T18:00:00Z",
  "creator": {
    "id": "8f0c2c1e-0b8a-4a4e-9f61-2f1f6c1e2a10",
    "name": "Ana Souza",
    "email": "ana@example.com",
    "handle": "@anasouza"
  }
}
```
- `step`: `"signup" | "app_installed" | "payment_done"`
- `creator.name`, `creator.email` and `creator.handle` are required only on `signup`.

### Processing order
1. Read the **raw body** (the signature is over the exact bytes).
2. Reject with **401** if `x-signature` or `x-timestamp` is missing, the signature doesn't match, or the timestamp is more than **5 minutes** from now (replay protection).
3. Parse JSON and validate with zod. Invalid payload: **400**.
4. Record the event in `webhook_events`. If `event_id` already exists: **200** `{ "status": "duplicate" }` and no side effects.
5. Apply the status transition (section 3).
6. If the creator just became `live`: send the Slack "live" message.
7. Respond **200** `{ "status": "processed" }`.

## 2. Data model

### `creators`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | comes from the webhook |
| `name` | text not null | |
| `email` | text not null unique | |
| `handle` | text | |
| `status` | text not null | `signed_up`, `app_installed`, `live` |
| `last_step_at` | timestamptz not null | time of the last step that changed status |
| `stuck_alert_sent_at` | timestamptz null | reset to null when status changes |
| `created_at` | timestamptz default now() | |
| `updated_at` | timestamptz default now() | |

### `webhook_events`
| Column | Type | Notes |
|---|---|---|
| `event_id` | text PK | idempotency key |
| `creator_id` | uuid not null | |
| `step` | text not null | |
| `occurred_at` | timestamptz not null | |
| `payload` | jsonb not null | raw body, for debugging and replays |
| `received_at` | timestamptz default now() | |

## 3. Status transitions

| Step | New status | Rank |
|---|---|---|
| `signup` | `signed_up` | 1 |
| `app_installed` | `app_installed` | 2 |
| `payment_done` | `live` | 3 |

Rules:
- `signup` creates the creator if it doesn't exist.
- Status only moves **forward**. An event with a lower or equal rank than the current status is recorded but doesn't change the creator (webhooks can arrive out of order).
- When status changes: set `last_step_at = occurred_at`, `stuck_alert_sent_at = null`, `updated_at = now()`.
- The transition logic lives in a pure function: `nextState(current, event) => { changed, status, becameLive }`.

## 4. Stuck creators cron

`GET /api/cron/stuck-creators`, called by Vercel Cron every hour.

- Requires `Authorization: Bearer ${CRON_SECRET}`, otherwise **401**.
- Find creators where `status <> 'live'`, `last_step_at < now() - interval '48 hours'` and `stuck_alert_sent_at is null`.
- Send **one** Slack message listing them (name, handle, current step, hours stuck).
- Set `stuck_alert_sent_at = now()` for those creators, so each creator is alerted once per step.
- Respond `{ "alerted": <count> }`.

## 5. Slack messages
- Live: `:rocket: *{name}* ({handle}) is live! Onboarding took {hours}h.` (hours from `created_at`)
- Stuck: `:warning: {count} creator(s) stuck for 48h+` followed by one line per creator.
- Slack errors are logged with `[slack]` and never change the HTTP response.

## 6. Environment
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WEBHOOK_SECRET`, `SLACK_WEBHOOK_URL`, `CRON_SECRET`. Validate them once in `src/lib/env.ts` and fail fast if any is missing.

## 7. Out of scope
- Admin UI and dashboards
- Retry queue for Slack
- Multiple webhook secrets or secret rotation

## 8. Open questions (decide during planning)
- A non-`signup` event arrives for a creator that doesn't exist yet. Store the event and return 200, or return 4xx so the sender retries?
- Should `webhook_events` be written in the same transaction as the creator update? Supabase JS has no client-side transactions, so this may need a Postgres function (RPC).

## 9. Acceptance
Tests must cover:
- [ ] Valid `signup` creates the creator with `signed_up`
- [ ] Full flow `signup` → `app_installed` → `payment_done` ends in `live` and sends one Slack "live" message
- [ ] Missing or invalid signature returns 401
- [ ] Timestamp older than 5 minutes returns 401
- [ ] Invalid payload returns 400
- [ ] Same `event_id` twice: second call returns `duplicate` and has no side effects
- [ ] Out-of-order event (`app_installed` after `payment_done`) does not move status back
- [ ] Slack failure still returns 200
- [ ] Cron without the right token returns 401
- [ ] Cron alerts a stuck creator once, and not again on the next run
- [ ] `npm test` and `npx tsc --noEmit` pass
