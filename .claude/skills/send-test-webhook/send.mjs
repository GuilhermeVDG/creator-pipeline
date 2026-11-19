// Sends a signed onboarding webhook to the local server.
// Run: node --env-file=.env.local .claude/skills/send-test-webhook/send.mjs --step signup
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DEFAULT_URL, requireSecret, sendWebhook, webhookUrl } from './webhook.mjs';

const { values } = parseArgs({
  options: {
    step: { type: 'string', default: 'signup' },
    creator: { type: 'string' },
    event: { type: 'string' },
    url: { type: 'string', default: DEFAULT_URL },
    'bad-signature': { type: 'boolean', default: false },
    old: { type: 'boolean', default: false },
  },
});

const secret = requireSecret();
const creatorId = values.creator ?? randomUUID();
const payload = {
  event_id: values.event ?? `evt_${randomUUID()}`,
  step: values.step,
  occurred_at: new Date().toISOString(),
  creator: {
    id: creatorId,
    ...(values.step === 'signup'
      ? { name: 'Test Creator', email: `test+${creatorId.slice(0, 8)}@example.com`, handle: '@testcreator' }
      : {}),
  },
};

const res = await sendWebhook({
  url: webhookUrl(values.url),
  secret,
  payload,
  badSignature: values['bad-signature'],
  timestampOffsetSeconds: values.old ? -600 : 0,
});

console.log(`creator: ${creatorId}`);
console.log(`status:  ${res.status}`);
console.log(`body:    ${res.body}`);
