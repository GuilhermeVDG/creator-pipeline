# Spec: Creator onboarding pipeline

## Goal
Every new creator goes through a web onboarding flow (signup, install the creator app, set up payment). Each step fires a webhook. This service receives those webhooks, keeps the creator's status in sync, and tells the ops team on Slack when a creator goes live or gets stuck.

## 1. Webhook endpoint

`POST /api/webhooks/onboarding`

### Headers
| Header | Value |
|---|---|
| `x-timestamp` | Unix time in **seconds** when the event was sent (integer) |
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
- `occurred_at` more than **5 minutes in the future** is invalid (**400**). Past dates are accepted.

### Processing order
1. Read the **raw body** (the signature is over the exact bytes).
2. Reject with **401** if `x-signature` or `x-timestamp` is missing, the signature doesn't match, or the timestamp is more than **5 minutes** from now in either direction (replay protection). `x-timestamp` must parse as an integer number of seconds; anything else (including `NaN`) is **401**.
3. Parse JSON and validate with zod. Invalid payload (including a future `occurred_at`, see above): **400**.
4. Call the Postgres function `process_onboarding_event` (section 3.1). It records the event and applies the transition in **one transaction**.
5. If the function reports `became_live`: send the Slack "live" message.
6. Respond based on the function result:

| Result | HTTP | Body |
|---|---|---|
| `duplicate` (event_id already recorded) | 200 | `{ "status": "duplicate" }`, no side effects |
| `processed` (applied, or recorded with no status change) | 200 | `{ "status": "processed" }` |
| `pending` (non-`signup` event for a creator that doesn't exist yet) | 200 | `{ "status": "pending" }` |
| `email_conflict` (`signup` with a new id but an email that already exists) | 409 | `{ "error": "email already in use" }` |

### Logging
- Never log payloads or secrets. Log only `event_id`, `creator_id` and `step`, with the `[onboarding]` prefix.
- An `email_conflict` is logged (`event_id`, `creator_id`) and not retried by us.

## 2. Data model

### `creators`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | comes from the webhook |
| `name` | text not null | |
| `email` | text not null unique | |
| `handle` | text | |
| `status` | text not null | `signed_up`, `app_installed`, `live` |
| `last_step_at` | timestamptz not null | `occurred_at` of the last step that changed status |
| `stuck_alert_sent_at` | timestamptz null | reset to null when status changes |
| `onboarding_started_at` | timestamptz not null | `occurred_at` of the `signup` event; used for the live message duration |
| `created_at` | timestamptz default now() | |
| `updated_at` | timestamptz default now() | |

### `webhook_events`
| Column | Type | Notes |
|---|---|---|
| `event_id` | text PK | idempotency key |
| `creator_id` | uuid not null | indexed, used to reconcile pending events on `signup` |
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
- `signup` for a creator that already exists (new `event_id`) is a no-op on the creator: the event is recorded, the response is `processed`.
- A non-`signup` event for a creator that doesn't exist yet is recorded and the response is `pending`. Nothing else happens until `signup` arrives.
- When `signup` creates the creator, it **reconciles** from the highest-ranked event already stored for that `creator_id` (including the signup itself): `status` = that event's status, `last_step_at` = that event's `occurred_at`. If that event is `payment_done`, the creator `became_live` and the live message is sent.
- Status only moves **forward**. An event with a lower or equal rank than the current status is recorded but doesn't change the creator (webhooks can arrive out of order).
- Skipping steps is allowed (`signup` straight to `payment_done` goes to `live`).
- When status changes: set `last_step_at = occurred_at`, `stuck_alert_sent_at = null`, `updated_at = now()`.
- The transition logic lives in a pure function: `nextState(current, event) => { changed, status, becameLive }`.

### 3.1 `process_onboarding_event` (Postgres function, called via RPC)
Runs in a single transaction:
1. `insert into webhook_events ... on conflict (event_id) do nothing`. No row inserted: return `duplicate`.
2. `signup` and creator doesn't exist: insert the creator with `onboarding_started_at = occurred_at`, reconciled from stored events (above). A unique violation on `email` rolls back the whole transaction (the event is **not** recorded) and returns `email_conflict`.
3. Non-`signup` and creator doesn't exist: return `pending`.
4. Otherwise: **rank-guarded conditional update** (`update creators ... where rank(status) < rank(new_status) returning ...`). `became_live` is true only if this update returned a row and the new status is `live`. Concurrent events can't move status backwards and only one of them can report `became_live`.
5. Returns `{ result, became_live, name, handle, onboarding_started_at, live_at }`.

The rank rule exists in both TypeScript (`nextState`) and SQL. They are kept in sync by one shared table of transition cases: the unit tests run it against `nextState` and the in-memory repository, and an integration test runs the same table against the SQL function.

## 4. Stuck creators cron

`GET /api/cron/stuck-creators`, called by Vercel Cron every hour.

- Requires `Authorization: Bearer ${CRON_SECRET}` (timing-safe compare), otherwise **401**.
- One atomic statement selects and marks the creators:
  `update creators set stuck_alert_sent_at = now() where status <> 'live' and last_step_at < now() - interval '48 hours' and stuck_alert_sent_at is null returning ...`
  This way overlapping runs can't double-alert, and a creator who moves forward at the same moment isn't marked for the new step.
- Send **one** Slack message listing the returned creators (name, handle, current step, hours stuck since `last_step_at`). No message if none.
- Respond `{ "alerted": <count> }`.
- **Known limitation:** creators are marked before Slack is called. If Slack fails right after the update, those alerts are lost (no retry queue, see section 7). The failure is logged with `[cron]`/`[slack]`.

## 5. Slack messages
- Live: `:rocket: *{name}* ({handle}) is live! Onboarding took {hours}h.` (`hours` = `live_at` − `onboarding_started_at`, where `live_at` is the `occurred_at` of the event that made the creator live)
- Stuck: `:warning: {count} creator(s) stuck for 48h+` followed by one line per creator.
- `&`, `<` and `>` in creator-provided values are escaped (`&amp;`, `&lt;`, `&gt;`) so names can't trigger mentions like `<!channel>`.
- Slack errors are logged with `[slack]` and never change the HTTP response.

## 6. Environment
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WEBHOOK_SECRET`, `SLACK_WEBHOOK_URL`, `CRON_SECRET`. Validated once in `src/lib/env.ts`, **lazily on first use** (so `next build` doesn't need secrets), and fail fast at runtime if any is missing.

## 7. Out of scope
- Admin UI and dashboards
- Retry queue for Slack
- Multiple webhook secrets or secret rotation

## 8. Decisions (formerly open questions)
- **Non-`signup` event for a creator that doesn't exist yet:** store it and return **200** `{ "status": "pending" }`. When `signup` creates the creator, reconcile from the highest-ranked stored event for that `creator_id`, and send the live message if that's `payment_done`. Rejecting with 4xx was dropped: the event would already be recorded (retries become `duplicate`), and many senders don't retry on 4xx.
- **Same transaction:** yes. One Postgres function, `process_onboarding_event`, called via RPC (section 3.1), with a rank-guarded conditional update; `became_live` comes from the update result. We accept the rank rule living in TS and SQL, kept in sync by a shared table of transition cases.
- **Signup with a new id but an existing email:** **409**, logged, not retried; the transaction is rolled back.
- **Signup resent with a new `event_id`:** no-op on the creator, **200** `processed`.
- **`occurred_at` more than 5 minutes in the future:** **400**. Past dates are fine.
- **Skipping steps:** allowed.
- **Onboarding duration:** new column `onboarding_started_at` from the signup `occurred_at`, used for the live message.
- **Cron:** one atomic `UPDATE ... RETURNING`; alerts are lost if Slack fails right after (documented limitation).

## 9. Acceptance
Tests must cover:
- [ ] Valid `signup` creates the creator with `signed_up`
- [ ] Full flow `signup` → `app_installed` → `payment_done` ends in `live` and sends one Slack "live" message
- [ ] Skipping steps: `signup` → `payment_done` ends in `live`
- [ ] Missing or invalid signature returns 401
- [ ] Timestamp older than 5 minutes (or more than 5 minutes ahead, or non-integer) returns 401
- [ ] Invalid payload returns 400
- [ ] `occurred_at` more than 5 minutes in the future returns 400
- [ ] Same `event_id` twice: second call returns `duplicate` and has no side effects
- [ ] Out-of-order event (`app_installed` after `payment_done`) does not move status back
- [ ] Non-`signup` event before `signup` returns `pending`; the later `signup` reconciles to the highest-ranked stored step (and sends the live message if that's `payment_done`)
- [ ] `signup` resent with a new `event_id` returns `processed` and doesn't change the creator
- [ ] `signup` with a new id but an existing email returns 409 and records nothing
- [ ] Live message duration uses `onboarding_started_at`
- [ ] Slack messages escape `&`, `<`, `>`
- [ ] Slack failure still returns 200
- [ ] Cron without the right token returns 401
- [ ] Cron alerts a stuck creator once, and not again on the next run
- [ ] The shared transition-case table passes against `nextState` (and later against the SQL function)
- [ ] `npm test` and `npx tsc --noEmit` pass
