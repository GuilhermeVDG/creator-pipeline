import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Spy on timingSafeEqual while keeping the real implementation.
const timingSafeEqualSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      timingSafeEqualSpy.calls++;
      return actual.timingSafeEqual(a, b);
    },
  };
});

import {
  TIMESTAMP_TOLERANCE_SECONDS,
  signPayload,
  verifySignature,
  type SignatureInput,
} from "@/src/lib/webhooks/signature";

const SECRET = "test-secret";
const NOW = new Date("2026-11-18T18:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const BODY = new TextEncoder().encode('{"event_id":"evt_1","step":"signup"}');

function input(overrides: Partial<SignatureInput> = {}): SignatureInput {
  const timestamp = overrides.timestamp ?? String(NOW_S);
  const rawBody = overrides.rawBody ?? BODY;
  return {
    rawBody,
    timestamp,
    signature: signPayload(SECRET, timestamp, rawBody),
    secret: SECRET,
    now: NOW,
    ...overrides,
  };
}

const fail = (reason: string) => ({ ok: false, reason });

beforeEach(() => {
  timingSafeEqualSpy.calls = 0;
});

describe("verifySignature: missing headers", () => {
  it.each([
    ["no timestamp", { timestamp: null }],
    ["no signature", { signature: null }],
    ["neither", { timestamp: null, signature: null }],
    ["empty timestamp", { timestamp: "" }],
    ["empty signature", { signature: "" }],
  ] as const)("%s", (_name, overrides) => {
    expect(verifySignature(input(overrides))).toEqual(fail("missing_headers"));
  });
});

describe("verifySignature: timestamp format", () => {
  it.each([
    ["NaN", "NaN"],
    ["letters", "abc"],
    ["decimal", `${NOW_S}.5`],
    ["negative", `-${NOW_S}`],
    ["plus sign", `+${NOW_S}`],
    ["exponent", "1.7e9"],
    ["leading space", ` ${NOW_S}`],
    ["trailing newline", `${NOW_S}\n`],
    ["hex", "0x6917c0c0"],
    ["milliseconds", String(NOW.getTime())],
  ])("rejects %s", (_name, timestamp) => {
    // Signed with that same timestamp, so only the format check can reject it.
    const result = verifySignature(input({ timestamp, signature: signPayload(SECRET, timestamp, BODY) }));
    expect(result).toEqual(fail("invalid_timestamp"));
  });
});

describe("verifySignature: replay window (both directions)", () => {
  const signedAt = (offset: number) => {
    const timestamp = String(NOW_S + offset);
    return input({ timestamp, signature: signPayload(SECRET, timestamp, BODY) });
  };

  it("rejects 1 s too old", () => {
    expect(verifySignature(signedAt(-TIMESTAMP_TOLERANCE_SECONDS - 1))).toEqual(fail("timestamp_out_of_window"));
  });
  it("rejects 1 s too far ahead", () => {
    expect(verifySignature(signedAt(TIMESTAMP_TOLERANCE_SECONDS + 1))).toEqual(fail("timestamp_out_of_window"));
  });
  it("rejects 10 minutes old (send-test-webhook --old)", () => {
    expect(verifySignature(signedAt(-600))).toEqual(fail("timestamp_out_of_window"));
  });
  it("accepts exactly 5 minutes old", () => {
    expect(verifySignature(signedAt(-TIMESTAMP_TOLERANCE_SECONDS))).toEqual({ ok: true });
  });
  it("accepts exactly 5 minutes ahead", () => {
    expect(verifySignature(signedAt(TIMESTAMP_TOLERANCE_SECONDS))).toEqual({ ok: true });
  });
  it("fails closed when now is an invalid date", () => {
    expect(verifySignature({ ...signedAt(0), now: new Date(NaN) })).toEqual(fail("timestamp_out_of_window"));
  });
  it("uses whole seconds of now", () => {
    const now = new Date(NOW.getTime() + 999); // same second
    expect(verifySignature({ ...signedAt(-TIMESTAMP_TOLERANCE_SECONDS), now })).toEqual({ ok: true });
  });
});

describe("verifySignature: signature", () => {
  const validHex = signPayload(SECRET, String(NOW_S), BODY).slice("sha256=".length);

  it.each([
    ["no prefix", validHex],
    ["wrong algorithm prefix", `sha1=${validHex}`],
    ["prefix only", "sha256="],
    ["too short", `sha256=${validHex.slice(0, 62)}`],
    ["too long", `sha256=${validHex}00`],
    ["odd length", `sha256=${validHex.slice(0, 63)}`],
    ["non-hex characters", `sha256=${"z".repeat(64)}`],
    ["whitespace", `sha256= ${validHex}`],
    ["two signatures", `sha256=${validHex},sha256=${validHex}`],
  ])("rejects %s without throwing", (_name, signature) => {
    expect(() => verifySignature(input({ signature }))).not.toThrow();
    expect(verifySignature(input({ signature }))).toEqual(fail("invalid_signature"));
  });

  it("rejects a signature made with another secret", () => {
    const signature = signPayload("wrong-secret", String(NOW_S), BODY);
    expect(verifySignature(input({ signature }))).toEqual(fail("invalid_signature"));
  });

  it("rejects a body changed by one byte", () => {
    const tampered = BODY.slice();
    tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 1;
    const valid = input();
    expect(verifySignature({ ...valid, rawBody: tampered })).toEqual(fail("invalid_signature"));
  });

  it("rejects a valid signature moved to another timestamp", () => {
    const valid = input();
    expect(verifySignature({ ...valid, timestamp: String(NOW_S - 1) })).toEqual(fail("invalid_signature"));
  });

  it("compares with timingSafeEqual", () => {
    expect(verifySignature(input())).toEqual({ ok: true });
    expect(timingSafeEqualSpy.calls).toBe(1);
  });

  it("rejects uppercase hex (lowercase only)", () => {
    const valid = input();
    const signature = `sha256=${(valid.signature ?? "").slice("sha256=".length).toUpperCase()}`;
    expect(verifySignature({ ...valid, signature })).toEqual(fail("invalid_signature"));
  });

  it("signs the exact bytes, including invalid UTF-8", () => {
    const rawBody = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]); // not valid UTF-8
    const valid = input({ rawBody });
    expect(verifySignature(valid)).toEqual({ ok: true });
    // Decoding and re-encoding would replace the bad bytes and break the signature.
    const roundTripped = new TextEncoder().encode(new TextDecoder().decode(rawBody));
    expect(verifySignature({ ...valid, rawBody: roundTripped })).toEqual(fail("invalid_signature"));
  });
});

describe("signPayload", () => {
  it("matches the send-test-webhook script's format", () => {
    const body = '{"a":1}';
    const timestamp = String(NOW_S);
    const scriptDigest = createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
    expect(signPayload(SECRET, timestamp, new TextEncoder().encode(body))).toBe(`sha256=${scriptDigest}`);
  });
});
