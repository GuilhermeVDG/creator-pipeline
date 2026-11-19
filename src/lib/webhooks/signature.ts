// HMAC verification for onboarding webhooks (spec section 1).
// Signature: "sha256=" + hex HMAC-SHA256 of `${timestamp}.${rawBody}`.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Replay window, in seconds, in both directions. */
export const TIMESTAMP_TOLERANCE_SECONDS = 300;

export type SignatureFailure =
  | "missing_headers"
  | "invalid_timestamp"
  | "timestamp_out_of_window"
  | "invalid_signature";

export type SignatureCheck = { ok: true } | { ok: false; reason: SignatureFailure };

export type SignatureInput = {
  /** Exact request bytes. Never re-serialized JSON. */
  rawBody: Uint8Array;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  now: Date;
};

// Unix seconds: digits only (no sign, decimal point, exponent or whitespace).
// 11 digits max rules out millisecond timestamps (13 digits) up front.
const TIMESTAMP_PATTERN = /^\d{1,11}$/;
// Lowercase hex only, matching what the sender produces.
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/;

function hmac(secret: string, timestamp: string, rawBody: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
}

/** Builds the `x-signature` header value. Used by tests and local tooling. */
export function signPayload(secret: string, timestamp: string, rawBody: Uint8Array): string {
  return `sha256=${hmac(secret, timestamp, rawBody).toString("hex")}`;
}

export function verifySignature(input: SignatureInput): SignatureCheck {
  const { rawBody, timestamp, signature, secret, now } = input;

  if (!timestamp || !signature) {
    return { ok: false, reason: "missing_headers" };
  }

  if (!TIMESTAMP_PATTERN.test(timestamp)) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  const sentAt = Number(timestamp);
  if (!Number.isSafeInteger(sentAt)) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  // Written to fail closed: a NaN `now` must reject, not skip the window.
  if (!(Math.abs(nowSeconds - sentAt) <= TIMESTAMP_TOLERANCE_SECONDS)) {
    return { ok: false, reason: "timestamp_out_of_window" };
  }

  const match = SIGNATURE_PATTERN.exec(signature);
  const hex = match?.[1];
  if (hex === undefined) {
    return { ok: false, reason: "invalid_signature" };
  }
  const received = Buffer.from(hex, "hex");
  const expected = hmac(secret, timestamp, rawBody);
  // timingSafeEqual throws on different lengths, so check first.
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true };
}
