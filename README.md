# creator-pipeline

Receives creator onboarding webhooks, keeps creator status in sync in Supabase, and alerts ops on Slack when a creator goes live or gets stuck for 48h+.

- Spec: `docs/spec.md`
- Agent instructions: `CLAUDE.md`
- Review checklist: `docs/review-checklist.md`

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
