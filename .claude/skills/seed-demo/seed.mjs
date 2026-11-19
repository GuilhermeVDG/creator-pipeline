// Seeds realistic demo data by sending signed onboarding webhooks (never writes to the DB).
// Run: node --env-file=.env.local .claude/skills/seed-demo/seed.mjs --url <webhook or origin URL>
//
// Ids are fixed, so re-running without cleanup is safe: every event comes back
// `duplicate`. To record again from scratch, run the printed cleanup SQL first.
import { parseArgs } from 'node:util';
import { requireSecret, sendWebhook, webhookUrl } from '../send-test-webhook/webhook.mjs';

const { values } = parseArgs({ options: { url: { type: 'string' } } });
if (!values.url) {
  console.error('Usage: node --env-file=.env.local .claude/skills/seed-demo/seed.mjs --url <url>');
  console.error('  e.g. --url http://localhost:3000   (the webhook path is added if missing)');
  process.exit(1);
}
const url = webhookUrl(values.url);
const secret = requireSecret();

const PREFIX = 'evt_demo_';
const STUCK_AFTER_HOURS = 48;

// Steps are [step, hours ago], oldest first. `kind` is what the cron should do.
const CREATORS = [
  // Go live: onboarding between 18h and 3 days (signup -> payment_done).
  { kind: 'live', slug: 'lucas', id: 'dec0de00-0000-4000-8000-000000000001', name: 'Lucas Ferreira', handle: '@lucasferreira',
    steps: [['signup', 26], ['app_installed', 15], ['payment_done', 7]] },
  { kind: 'live', slug: 'mariana', id: 'dec0de00-0000-4000-8000-000000000002', name: 'Mariana Costa', handle: '@mari.costa',
    steps: [['signup', 60], ['app_installed', 40], ['payment_done', 19]] },
  { kind: 'live', slug: 'rafael', id: 'dec0de00-0000-4000-8000-000000000003', name: 'Rafael Oliveira', handle: '@rafaoliveira',
    steps: [['signup', 100], ['app_installed', 70], ['payment_done', 32]] },

  // Stuck for 48h+ (50h to 5 days on the current step): the cron alerts these.
  { kind: 'stuck', slug: 'beatriz', id: 'dec0de00-0000-4000-8000-000000000004', name: 'Beatriz Santos', handle: '@biasantos',
    steps: [['signup', 51]] },
  { kind: 'stuck', slug: 'camila', id: 'dec0de00-0000-4000-8000-000000000005', name: 'Camila Rocha', handle: '@camilarocha.art',
    steps: [['signup', 90], ['app_installed', 75]] },
  { kind: 'stuck', slug: 'thiago', id: 'dec0de00-0000-4000-8000-000000000006', name: 'Thiago Almeida', handle: '@thiagoalm',
    steps: [['signup', 98]] },
  { kind: 'stuck', slug: 'pedro', id: 'dec0de00-0000-4000-8000-000000000007', name: 'Pedro Henrique Lima', handle: '@pedrohlima',
    steps: [['signup', 130], ['app_installed', 118]] },

  // Recent (under 48h on the current step): the cron must NOT alert these.
  { kind: 'recent', slug: 'juliana', id: 'dec0de00-0000-4000-8000-000000000008', name: 'Juliana Martins', handle: '@jumartins',
    steps: [['signup', 6]] },
  { kind: 'recent', slug: 'gabriel', id: 'dec0de00-0000-4000-8000-000000000009', name: 'Gabriel Souza', handle: '@gabesouza',
    steps: [['signup', 40], ['app_installed', 30]] },
];

const CLEANUP_SQL = [
  `delete from public.creators where id in (select creator_id from public.webhook_events where starts_with(event_id, '${PREFIX}'));`,
  `delete from public.webhook_events where starts_with(event_id, '${PREFIX}');`,
].join('\n');

const now = Date.now();
const hoursAgo = (h) => new Date(now - h * 3_600_000).toISOString();
const email = (c) => `${c.name.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').trim().replace(/ +/g, '.')}@example.com`;

const results = [];
let failures = 0;

for (const c of CREATORS) {
  const statuses = [];
  for (const [step, h] of c.steps) {
    const payload = {
      event_id: `${PREFIX}${c.slug}_${step}`,
      step,
      occurred_at: hoursAgo(h),
      creator: { id: c.id, ...(step === 'signup' ? { name: c.name, email: email(c), handle: c.handle } : {}) },
    };
    let res;
    try {
      res = await sendWebhook({ url, secret, payload });
    } catch (err) {
      console.error(`request failed for ${payload.event_id}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    let status = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(res.body);
      status = parsed.status ?? parsed.error ?? status;
    } catch {}
    if (res.status !== 200) failures++;
    statuses.push(`${step}:${status}`);
  }
  results.push({ c, statuses });
}

const pad = (s, n) => String(s).padEnd(n);
const lastStep = (c) => c.steps.at(-1);
const describe = (c) => {
  const [step, h] = lastStep(c);
  if (c.kind === 'live') return `live, onboarding took ${c.steps[0][1] - h}h`;
  return `${step === 'signup' ? 'signed up' : 'app installed'} ${h}h ago`;
};
const expectation = { live: 'live message sent while seeding', stuck: 'ALERTED by the cron', recent: `not alerted (< ${STUCK_AFTER_HOURS}h)` };

console.log(`\nSeeded ${CREATORS.length} demo creators via ${url}\n`);
console.log(`${pad('creator', 22)}${pad('handle', 18)}${pad('state', 32)}${pad('expected', 34)}responses`);
for (const { c, statuses } of results) {
  console.log(`${pad(c.name, 22)}${pad(c.handle, 18)}${pad(describe(c), 32)}${pad(expectation[c.kind], 34)}${statuses.join(' ')}`);
}

const stuck = CREATORS.filter((c) => c.kind === 'stuck').sort((a, b) => lastStep(b)[1] - lastStep(a)[1]);
console.log(`\nNext cron run should alert ${stuck.length} creator(s), longest stuck first: ${stuck.map((c) => c.name).join(', ')}.`);
console.log(`(Responses are "duplicate" on a re-run without cleanup.)\n`);
console.log('Cleanup (Supabase SQL editor), deletes only evt_demo_ data:\n');
console.log(CLEANUP_SQL);

if (failures > 0) {
  console.error(`\n${failures} request(s) did not return 200. Check the server logs ([onboarding]).`);
  process.exit(1);
}
