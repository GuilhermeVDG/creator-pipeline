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

#### Field rules (anything else is **400**)
| Field | Rule |
|---|---|
| `event_id` | string, 1–255 chars, stored exactly as sent (not trimmed) |
| `occurred_at` | RFC 3339 date-time with a timezone (`Z` or `±hh:mm`) |
| `creator.id` | any 8-4-4-4-12 hex id; lowercased |
| `creator.name` | trimmed, 1–200 chars |
| `creator.email` | trimmed, at most 320 chars, a light `local@domain` check (one `@`, no whitespace). Non-ASCII addresses are accepted, since the upstream flow already validated them. Case is kept as sent. |
| `creator.handle` | trimmed, 1–100 chars, any characters |

- Text fields can't contain NUL (`\u0000`) or unpaired surrogates, which Postgres can't store.
- Unknown fields are ignored.

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
| `email` | text not null | stored as sent (trimmed); unique index on `lower(email)`, so the 409 rule is case-insensitive |
| `handle` | text | |
| `status` | text not null | `signed_up`, `app_installed`, `live` |
| `last_step_at` | timestamptz not null | earliest `occurred_at` among recorded events for the current status (see section 3) |
| `stuck_alert_sent_at` | timestamptz null | reset to null when status changes |
| `onboarding_started_at` | timestamptz not null | earliest `occurred_at` among recorded `signup` events; used for the live message duration |
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
- When `signup` creates the creator, it **reconciles** from the events already stored for that `creator_id` (including the signup itself), ordered by `rank desc, occurred_at asc`. The first one gives `status` and `last_step_at`. If it is `payment_done`, the creator `became_live` and the live message is sent.
- Status only moves **forward**. An event with a lower rank than the current status is recorded but doesn't change the creator (webhooks can arrive out of order).
- Skipping steps is allowed (`signup` straight to `payment_done` goes to `live`).
- When status changes (higher rank): set `status`, `last_step_at = occurred_at`, `stuck_alert_sent_at = null`, `updated_at = now()`.
- **One rule for `last_step_at`, regardless of arrival order:** it is always the earliest `occurred_at` among recorded events for the current status. So an equal-rank event with an earlier `occurred_at` moves `last_step_at` back (and sets `updated_at = now()`). That is **not** a status change: it doesn't reset `stuck_alert_sent_at` and doesn't send Slack. An equal-rank event with a later or equal `occurred_at` changes nothing.
- **Resent `signup`** (creator exists, new `event_id`):
  - `onboarding_started_at` moves back if the resent signup's `occurred_at` is earlier (earliest wins), whatever the current status, so the live duration stays right.
  - `last_step_at` moves back only while the creator is still `signed_up` (the equal-rank rule above).
  - `name`, `email` and `handle` never change.
  - Neither correction is a status change: no `stuck_alert_sent_at` reset, no Slack. The response is `processed`.
- The transition logic lives in pure functions: `nextState(current, event) => { changed, status, lastStepAt, becameLive }` (`changed` means the status changed) and `reconcile(events)` for creation.

### 3.1 `process_onboarding_event` (Postgres function, called via RPC)
Runs in a single transaction:
0. **Per-creator lock:** `perform pg_advisory_xact_lock(hashtext(creator_id::text))`, before anything else. All events for one creator run one at a time, and each statement after the lock sees everything committed before it.
   - Why: a row lock (`select ... for update`) can't protect a creator that doesn't exist yet. Without this lock, a `signup` and a concurrent `payment_done` can each miss the other's uncommitted rows: `payment_done` returns `pending`, `signup` reconciles without it, and the creator stays `signed_up` forever. Two concurrent `signup`s for the same id could also hit the `email` unique index first and wrongly return 409.
   - The lock is released automatically at commit or rollback.
   - `hashtext` is 32-bit, so two different creators can share a lock key. A collision only makes unrelated creators wait for each other; it never breaks correctness, which is fine at our volume.
1. `insert into webhook_events ... on conflict (event_id) do nothing`. No row inserted: return `duplicate`.
2. `signup` and creator doesn't exist: insert the creator with `onboarding_started_at = occurred_at`, reconciled from stored events (above). A unique violation on `lower(email)` rolls back the whole transaction (the event is **not** recorded) and returns `email_conflict`.
3. Non-`signup` and creator doesn't exist: return `pending`.
4. Otherwise, **guarded conditional updates**, in order:
   - a. Status change: `update creators set status = new_status, last_step_at = occurred_at, stuck_alert_sent_at = null, updated_at = now() where id = $id and rank(status) < rank(new_status) returning ...`. `became_live` is true only if this update returned a row and the new status is `live`.
   - b. Only if (a) updated nothing, time correction: `update creators set last_step_at = occurred_at, updated_at = now() where id = $id and rank(status) = rank(new_status) and occurred_at < last_step_at`.
   - c. `signup` only, onboarding start correction: `update creators set onboarding_started_at = occurred_at, updated_at = now() where id = $id and occurred_at < onboarding_started_at`.

   **Assumptions these updates rely on** (keep them when implementing):
   - All of them run inside this one function, after the lock from step 0.
   - No value read earlier is carried into a later statement. Each `where` decides from the current row; never compute a new `last_step_at` or status in plpgsql from an earlier `select`.
   - (b) and (c) never touch `status` or `stuck_alert_sent_at`. Don't merge (a) and (b) into one `set` list with `case` expressions, because that makes it easy to reset `stuck_alert_sent_at` on a time correction.
   - (b) uses `=` on rank, never `<=`: a lower-rank event must not move `last_step_at`.
   - No update ever changes `name`, `email` or `handle` after creation.
   - Even without the lock, each `where` is re-checked under the row lock against the latest row version (READ COMMITTED), so these updates on their own can't move status backwards or `last_step_at` later. The lock is what handles a creator that doesn't exist yet.
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
- Live: `:rocket: *{name}* ({handle}) is live! Onboarding took {hours}h.` (`hours` = `max(0, live_at − onboarding_started_at)`, where `live_at` is the `occurred_at` of the event that made the creator live. It is clamped to 0 because a pending `payment_done` can have an `occurred_at` earlier than the signup's.)
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
- **Non-`signup` event for a creator that doesn't exist yet:** store it and return **200** `{ "status": "pending" }`. When `signup` creates the creator, reconcile from the stored events for that `creator_id` (`rank desc, occurred_at asc`, section 3), and send the live message if that gives `live`. Rejecting with 4xx was dropped: the event would already be recorded (retries become `duplicate`), and many senders don't retry on 4xx.
- **Same transaction:** yes. One Postgres function, `process_onboarding_event`, called via RPC (section 3.1), with two guarded conditional updates (status change, then time correction); `became_live` comes from the status-change update result. We accept the rank rule living in TS and SQL, kept in sync by a shared table of transition cases.
- **Signup with a new id but an existing email:** **409**, logged, not retried; the transaction is rolled back.
- **Signup resent with a new `event_id`:** **200** `processed`. Name, email and handle never change. An earlier `occurred_at` moves `onboarding_started_at` back (earliest wins), and moves `last_step_at` back only while still `signed_up` (section 3).
- **`last_step_at` rule:** always the earliest `occurred_at` among recorded events for the current status, whatever the arrival order. An equal-rank correction is not a status change.
- **Concurrency:** a per-creator advisory lock (`pg_advisory_xact_lock(hashtext(creator_id::text))`) at the top of `process_onboarding_event`, because a row lock can't cover a creator that doesn't exist yet. Hash collisions only make unrelated creators wait for each other, which is fine at our volume.
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
- [ ] Equal-rank event with an earlier `occurred_at` moves `last_step_at` back without resetting `stuck_alert_sent_at` or sending Slack
- [ ] Non-`signup` event before `signup` returns `pending`; the later `signup` reconciles to the highest-ranked stored step, earliest among ties (and sends the live message if that's `payment_done`)
- [ ] `signup` resent with a new `event_id` returns `processed` and never changes name, email or handle
- [ ] `signup` resent with an earlier `occurred_at` moves `onboarding_started_at` back (any status) and `last_step_at` back only while `signed_up`
- [ ] `signup` with a new id but an existing email returns 409 and records nothing
- [ ] Live message duration uses `onboarding_started_at` and is clamped to 0
- [ ] Slack messages escape `&`, `<`, `>`
- [ ] Slack failure still returns 200
- [ ] Cron without the right token returns 401
- [ ] Cron alerts a stuck creator once, and not again on the next run
- [ ] The shared transition-case table passes against `nextState` (and later against the SQL function)
- [ ] Integration (opt-in): concurrent `signup` and `payment_done` for a new creator always end `live` with one live message, and two concurrent `signup`s for the same id never return 409
- [ ] `npm test` and `npx tsc --noEmit` pass
