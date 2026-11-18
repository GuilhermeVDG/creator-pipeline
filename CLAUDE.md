# creator-pipeline

Internal service that receives creator onboarding webhooks, keeps each creator's status in sync in Supabase, and alerts the ops team on Slack. The full feature spec is in `docs/spec.md`. Read it before planning any change.

## Stack
- Next.js (App Router) route handlers, TypeScript strict
- Supabase Postgres via `@supabase/supabase-js` (service role, server only)
- zod for input validation
- Vitest for tests
- Slack Incoming Webhooks
- Deployed on Vercel (cron in `vercel.json`)

## Commands
- `npm run dev`: local server on http://localhost:3000
- `npm test`: run all tests once
- `npm run test:watch`: watch mode
- `npx tsc --noEmit`: type check
- `npm run lint`: lint

## Project layout
```
app/api/webhooks/onboarding/route.ts   # POST handler: verify, validate, process
app/api/cron/stuck-creators/route.ts   # GET handler called by Vercel Cron
src/lib/webhooks/signature.ts          # HMAC verification + timestamp window
src/lib/webhooks/schema.ts             # zod schema for the event payload
src/lib/creators/transitions.ts        # pure status logic (no I/O)
src/lib/creators/repository.ts         # interface + Supabase impl + in-memory fake
src/lib/slack.ts                       # Slack client (never throws)
src/lib/env.ts                         # validated env vars
supabase/migrations/                   # SQL migrations
tests/                                 # Vitest tests
```

## How we work
1. **Plan first.** For any non-trivial change, propose a plan (files, schema, edge cases) and wait for approval before writing code.
2. **Small steps.** Implement one piece at a time and stop for review after each one.
3. **Tests in the same change.** Every behavior in `docs/spec.md` "Acceptance" needs a test. Write the edge cases first.
4. **Done means green.** Before saying a step is done, run `npm test` and `npx tsc --noEmit` and show the result.
5. **Ask before adding dependencies.** Prefer the platform (`crypto`, `fetch`) over new packages.
6. **Flag ambiguity.** If the spec doesn't cover a case, say so and propose an option instead of guessing.

## Code rules
- No `any`. Model domain types explicitly. Validate external input with zod at the boundary.
- Keep business logic pure (`transitions.ts`) and I/O at the edges (route handlers, repository, Slack).
- Route handlers depend on interfaces, so tests use the in-memory repository and a fake Slack client.
- Idempotency is enforced by the database (unique key + `on conflict do nothing`), never by "check then insert".
- Signature comparison must be timing-safe (`crypto.timingSafeEqual`).
- Slack failures are logged and never fail the webhook response.
- Errors return JSON `{ error: string }` with the right status code. Never leak stack traces.
- Log with a short prefix: `[onboarding]`, `[cron]`, `[slack]`.

## Security
- Secrets only from env vars, validated in `src/lib/env.ts`. Never hardcode or log them.
- Never read or print `.env` or `.env.local`. Use `.env.example` for reference.
- The Supabase service role key is server only. Never import `src/lib/creators/repository.ts` from client code.
- The cron route must check `Authorization: Bearer ${CRON_SECRET}`.

## Git
- All work goes on the `dev` branch. Before the first commit, create it if needed: `git switch -c dev` (or `git switch dev`). Never commit to `main`.
- Commit after each approved step, one logical change per commit.
- Conventional commits, **one line only**, short and simple, lowercase, no period, no body:
  - `feat: add webhook signature verification`
  - `test: cover duplicate events`
  - `fix: keep status from moving backwards`
  - `chore: add vitest config`
  - `docs: record open question decisions`
- Allowed types: `feat`, `fix`, `test`, `refactor`, `chore`, `docs`.
- Never force push, never rewrite history, never push without asking.