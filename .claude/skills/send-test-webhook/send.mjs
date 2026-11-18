// Sends a signed onboarding webhook to the local server.
// Run: node --env-file=.env.local .claude/skills/send-test-webhook/send.mjs --step signup
import { createHmac, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    step: { type: 'string', default: 'signup' },
    creator: { type: 'string' },
    event: { type: 'string' },
    url: { type: 'string', default: 'http://localhost:3000/api/webhooks/onboarding' },
    'bad-signature': { type: 'boolean', default: false },
    old: { type: 'boolean', default: false },
  },
});

const secret = process.env.WEBHOOK_SECRET;
if (!secret) {
  console.error('WEBHOOK_SECRET is not set. Run with --env-file=.env.local');
  process.exit(1);
}

const creatorId = values.creator ?? randomUUID();
const body = JSON.stringify({
  event_id: values.event ?? `evt_${randomUUID()}`,
  step: values.step,
  occurred_at: new Date().toISOString(),
  creator: {
    id: creatorId,
    ...(values.step === 'signup'
      ? { name: 'Test Creator', email: `test+${creatorId.slice(0, 8)}@example.com`, handle: '@testcreator' }
      : {}),
  },
});

const timestamp = String(Math.floor(Date.now() / 1000) - (values.old ? 600 : 0));
const digest = createHmac('sha256', values['bad-signature'] ? 'wrong-secret' : secret)
  .update(`${timestamp}.${body}`)
  .digest('hex');

const res = await fetch(values.url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-timestamp': timestamp, 'x-signature': `sha256=${digest}` },
  body,
});

console.log(`creator: ${creatorId}`);
console.log(`status:  ${res.status}`);
console.log(`body:    ${await res.text()}`);
