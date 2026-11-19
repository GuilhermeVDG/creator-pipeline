// Shared by send-test-webhook and seed-demo: signs and sends one onboarding webhook.
// Signature: "sha256=" + hex HMAC-SHA256 of `${timestamp}.${rawBody}` (docs/spec.md section 1).
import { createHmac } from 'node:crypto';

export const DEFAULT_URL = 'http://localhost:3000/api/webhooks/onboarding';
const ENDPOINT_PATH = '/api/webhooks/onboarding';

/** Accepts a full endpoint URL or a bare origin (then appends the webhook path). */
export function webhookUrl(url) {
  const u = new URL(url);
  if (u.pathname === '/' || u.pathname === '') u.pathname = ENDPOINT_PATH;
  return u.toString();
}

/** Reads WEBHOOK_SECRET from the environment (pass it with node --env-file=.env.local). */
export function requireSecret() {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.error('WEBHOOK_SECRET is not set. Run with --env-file=.env.local');
    process.exit(1);
  }
  return secret;
}

export function sign(secret, timestamp, body) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * Sends `payload` (an object) to `url`. Returns { status, body }.
 * `timestampOffsetSeconds` shifts x-timestamp (e.g. -600 to test replay protection).
 */
export async function sendWebhook({ url, secret, payload, badSignature = false, timestampOffsetSeconds = 0 }) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000) + timestampOffsetSeconds);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-timestamp': timestamp,
      'x-signature': sign(badSignature ? 'wrong-secret' : secret, timestamp, body),
    },
    body,
  });
  return { status: res.status, body: await res.text() };
}
