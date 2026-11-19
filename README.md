# creator-pipeline

Receives creator onboarding webhooks, keeps creator status in sync in Supabase, and alerts ops on Slack when a creator goes live or gets stuck for 48h+.

- Spec: `docs/spec.md`
- Agent instructions: `CLAUDE.md`
- Review checklist: `docs/review-checklist.md`

## Design decisions
Full reasoning is in `docs/spec.md` sections 3.1, 4 and 8.

- **One SQL function, not client logic.** `process_onboarding_event` records the event and applies the transition in one transaction, since Supabase JS has no client-side transactions.
  - It uses guarded conditional updates (`where rank(status) < rank(new)`), never read-then-write, so concurrent events can't move status backwards and only one can report `became_live`.
  - Cost: the rank rule exists in both TypeScript (`transitions.ts`) and SQL. One shared case table (`tests/fixtures/transition-cases.ts`) runs against the pure functions, the in-memory fake, and the real database (opt-in integration test).
- **Per-creator advisory lock.** The function starts with `pg_advisory_xact_lock(hashtext(creator_id))`.
  - A row lock can't protect a creator that doesn't exist yet. Without this lock, a `signup` and a concurrent `payment_done` could each miss the other, leaving the creator stuck at `signed_up`.
  - A hash collision only makes unrelated creators wait for each other. `lock_timeout = 5s` turns a stuck lock into a retryable 500.
- **Earliest wins, whatever the arrival order.** `last_step_at` is the earliest `occurred_at` for the current status, and `onboarding_started_at` the earliest signup.
  - Events that arrive before `signup` are stored as `pending` and reconciled when the creator is created.
  - Correcting a time is not a status change, so it doesn't reset the stuck alert or send Slack.
- **Checks fail closed.** Each check rejects instead of skipping when its input is unusable:
  - Signature check: an invalid clock or a non-integer timestamp is a 401.
  - Body size: more than 64 KB is a 413, before the body is read.
  - Payload: text Postgres can't store, or an `occurred_at` before 2000, is a 400, not a 500 the sender would retry forever.
  - Only the email unique index maps to 409. Any other database error, including `22P02`, is a 500 so the sender retries.
- **Idempotency in the database.** The `event_id` primary key with `on conflict do nothing`. An email conflict rolls back the event insert as well, so a resend gets 409 again rather than `duplicate`.
- **Known limitation: lost stuck alerts.** The cron claims stuck creators (marks them alerted) in one atomic `UPDATE ... RETURNING`, then posts to Slack. Overlapping runs can't double-alert. But if Slack fails, or the response can't be parsed, after the claim, those alerts are lost: there's no retry queue (out of scope), and the loss is logged with creator ids.

## Setup
```bash
npm install
cp .env.example .env.local   # fill in the values
npm run dev
```

Run the SQL in `supabase/migrations/` in the Supabase SQL editor (or with the Supabase CLI).

## Try it
```bash
node --env-file=.env.local .claude/skills/send-test-webhook/send.mjs --step signup
```

## Deploy (Vercel)
- Stuck-creators cron: `vercel.json` runs it **once a day** (`0 12 * * *`, UTC) because the project is on Vercel Hobby, which only allows daily crons.
- **Production schedule is hourly** (`0 * * * *`, Vercel Pro or higher). To switch, change the `schedule` in `vercel.json`; no code changes.
- Crons only run on production deployments. Set `CRON_SECRET` in the Vercel project; Vercel sends it as `Authorization: Bearer <CRON_SECRET>`.

## Tests
```bash
npm test
npx tsc --noEmit
```

Opt-in integration test against the **dev** Supabase project (apply the migration there first; credentials from `.env.local`):
```bash
npm run test:integration
```
It tags every row (`evt_test_…` event ids, `@test.invalid` emails), marks its creators as already alerted so the cron never posts them, and prints a cleanup `delete` for the SQL editor (the service role has no DELETE).
