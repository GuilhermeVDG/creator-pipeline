# Review checklist

## Security
- [ ] Signature verified over the **raw body**, before JSON parsing
- [ ] `crypto.timingSafeEqual` used, with a length check first (it throws on different lengths)
- [ ] Timestamp window enforced (5 minutes, both directions)
- [ ] No secrets hardcoded or logged
- [ ] Cron route checks `Authorization: Bearer ${CRON_SECRET}`
- [ ] Error responses don't leak stack traces or internals

## Correctness
- [ ] Idempotency enforced by the database (PK / unique + `on conflict do nothing`), not check-then-insert
- [ ] Status never moves backwards (out-of-order events)
- [ ] `stuck_alert_sent_at` reset when status changes
- [ ] Cron alerts each stuck creator only once per step
- [ ] Slack failure doesn't change the HTTP response

## Design
- [ ] Transition logic is a pure function with no I/O
- [ ] Route handlers depend on interfaces (repository, Slack), so tests use fakes
- [ ] Input validated with zod at the boundary, no `any`
- [ ] Env vars validated once in `src/lib/env.ts`

## Tests
- [ ] Every item in `docs/spec.md` section 9 has a test
- [ ] Tests assert behavior (status, side effects), not only the HTTP code
- [ ] At least one test would fail if the bug it targets came back
- [ ] `npm test` and `npx tsc --noEmit` pass
