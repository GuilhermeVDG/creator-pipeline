import { describe, expect, it, vi } from "vitest";
import {
  InMemoryCreatorRepository,
  RepositoryError,
  type CreatorRepository,
} from "@/src/lib/creators/repository";
import type { SlackClient } from "@/src/lib/slack";
import { MAX_BODY_BYTES, createOnboardingHandler, type OnboardingDeps } from "@/src/lib/webhooks/handler";
import { signPayload } from "@/src/lib/webhooks/signature";

const SECRET = "s".repeat(32);
const NOW = new Date("2026-11-18T18:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const CREATOR_ID = "8f0c2c1e-0b8a-4a4e-9f61-2f1f6c1e2a10";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";
const EMAIL = "ana.secret@example.com";

type Body = Record<string, unknown>;

function signupBody(overrides: Body = {}): Body {
  return {
    event_id: "evt_signup",
    step: "signup",
    occurred_at: "2026-11-17T10:00:00Z",
    creator: { id: CREATOR_ID, name: "Ana Souza", email: EMAIL, handle: "@anasouza" },
    ...overrides,
  };
}
function stepBody(step: string, eventId: string, occurredAt: string, creatorId = CREATOR_ID): Body {
  return { event_id: eventId, step, occurred_at: occurredAt, creator: { id: creatorId } };
}

function setup(overrides: Partial<OnboardingDeps> = {}) {
  const repo = new InMemoryCreatorRepository({ now: () => NOW });
  const sent: string[] = [];
  const slack: SlackClient = { send: vi.fn(async (text: string) => (sent.push(text), true)) };
  const logs: string[] = [];
  const logger = {
    info: vi.fn((m: string) => void logs.push(m)),
    error: vi.fn((m: string) => void logs.push(m)),
  };
  const deps: OnboardingDeps = { repository: repo, slack, webhookSecret: SECRET, now: () => NOW, logger, ...overrides };
  const handler = createOnboardingHandler(() => deps);

  function request(raw: string | Uint8Array, headers: Record<string, string | undefined> = {}): Request {
    const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
    const timestamp = String(NOW_S);
    const h = new Headers({ "content-type": "application/json" });
    const all = { "x-timestamp": timestamp, "x-signature": signPayload(SECRET, timestamp, bytes), ...headers };
    for (const [k, v] of Object.entries(all)) if (v !== undefined) h.set(k, v);
    return new Request("http://localhost/api/webhooks/onboarding", { method: "POST", headers: h, body: new Uint8Array(bytes) });
  }
  async function post(body: Body | string | Uint8Array, headers?: Record<string, string | undefined>) {
    const raw = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
    const res = await handler(request(raw, headers));
    return { status: res.status, body: (await res.json()) as Body };
  }
  return { repo, sent, slack, logs, logger, handler, request, post };
}

describe("size cap (413)", () => {
  function streamRequest(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
    const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body: stream, duplex: "half" };
    return new Request("http://localhost/api/webhooks/onboarding", init);
  }

  it("a declared Content-Length over 64 KB is rejected before the body is read", async () => {
    const t = setup();
    const pull = vi.fn();
    // highWaterMark 0: the stream doesn't pull on its own, only when read.
    const stream = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const res = await t.handler(streamRequest(stream, { "content-length": String(MAX_BODY_BYTES + 1) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload too large" });
    expect(pull).not.toHaveBeenCalled();
    expect(t.logs).toEqual(["[onboarding] payload too large: content-length"]);
  });

  it("without Content-Length, reading stops once the body passes 64 KB", async () => {
    const t = setup();
    let pulls = 0;
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk); // endless: only the cap ends this
      },
    });
    const res = await t.handler(streamRequest(stream));
    expect(res.status).toBe(413);
    expect(pulls).toBeLessThanOrEqual(MAX_BODY_BYTES / chunk.byteLength + 2);
    expect(t.repo.getEvents()).toEqual([]);
  });

  it("a wrong (too small) Content-Length doesn't bypass the cap", async () => {
    const t = setup();
    const big = new Uint8Array(MAX_BODY_BYTES + 1).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const res = await t.handler(streamRequest(stream, { "content-length": "10" }));
    expect(res.status).toBe(413);
  });

  it("exactly 64 KB is not too large (it then fails the signature check)", async () => {
    const t = setup();
    const res = await t.post(new Uint8Array(MAX_BODY_BYTES).fill(0x20), { "x-signature": `sha256=${"0".repeat(64)}` });
    expect(res.status).toBe(401);
  });

  it("is checked before the signature: an oversized signed body is 413", async () => {
    const t = setup();
    const raw = JSON.stringify({ ...signupBody(), padding: "x".repeat(MAX_BODY_BYTES) });
    expect((await t.post(raw)).status).toBe(413);
  });
});

describe("signature (401)", () => {
  const cases: Array<[string, Record<string, string | undefined>]> = [
    ["missing x-signature", { "x-signature": undefined }],
    ["missing x-timestamp", { "x-timestamp": undefined }],
    ["wrong signature", { "x-signature": signPayload("x".repeat(32), String(NOW_S), new Uint8Array()) }],
    ["uppercase hex", {}], // filled in below
    ["timestamp 6 minutes old", { "x-timestamp": String(NOW_S - 360) }],
    ["timestamp 6 minutes ahead", { "x-timestamp": String(NOW_S + 360) }],
    ["non-integer timestamp", { "x-timestamp": "NaN" }],
  ];

  it.each(cases)("%s returns the same 401 and has no side effects", async (name, headers) => {
    const t = setup();
    const raw = JSON.stringify(signupBody());
    let h = headers;
    if (name === "uppercase hex") {
      const sig = signPayload(SECRET, String(NOW_S), new TextEncoder().encode(raw));
      h = { "x-signature": `sha256=${sig.slice(7).toUpperCase()}` };
    }
    if (name.startsWith("timestamp") || name === "non-integer timestamp") {
      // Correctly signed for that timestamp, so only the window/format rejects it.
      const ts = h["x-timestamp"] ?? "";
      h = { ...h, "x-signature": signPayload(SECRET, ts, new TextEncoder().encode(raw)) };
    }
    const res = await t.post(raw, h);
    expect(res).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(t.repo.getEvents()).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it("logs only the reason, never header values", async () => {
    const t = setup();
    const sig = `sha256=${"ab".repeat(32)}`;
    await t.post(signupBody(), { "x-signature": sig, "x-timestamp": String(NOW_S - 360) });
    expect(t.logs).toEqual(["[onboarding] signature rejected: timestamp_out_of_window"]);
    expect(t.logs.join()).not.toContain("abab");
  });

  it("is checked before JSON parsing: unsigned garbage is 401, not 400", async () => {
    const t = setup();
    const res = await t.post("{not json", { "x-signature": `sha256=${"0".repeat(64)}` });
    expect(res.status).toBe(401);
  });

  it("signs the raw bytes: a body re-serialized differently fails", async () => {
    const t = setup();
    const raw = JSON.stringify(signupBody());
    const sig = signPayload(SECRET, String(NOW_S), new TextEncoder().encode(raw));
    const res = await t.post(JSON.stringify(signupBody(), null, 2), { "x-signature": sig });
    expect(res.status).toBe(401);
  });
});

describe("payload (400)", () => {
  it.each([
    ["invalid JSON", "{not json"],
    ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
    ["JSON array", "[]"],
    ["signup without email", JSON.stringify(signupBody({ creator: { id: CREATOR_ID, name: "A", handle: "@a" } }))],
    ["unknown step", JSON.stringify(stepBody("refund", "evt_x", "2026-11-17T10:00:00Z"))],
    ["occurred_at 6 minutes in the future", JSON.stringify(signupBody({ occurred_at: "2026-11-18T18:06:00Z" }))],
    ["occurred_at before 2000", JSON.stringify(signupBody({ occurred_at: "1999-01-01T00:00:00Z" }))],
  ] as const)("%s returns 400 with no side effects", async (_name, raw) => {
    const t = setup();
    expect(await t.post(raw)).toEqual({ status: 400, body: { error: "invalid payload" } });
    expect(t.repo.getEvents()).toEqual([]);
  });

  it("logs field paths and codes, never values", async () => {
    const t = setup();
    await t.post(signupBody({ creator: { id: CREATOR_ID, name: "Ana", email: "not an email secret", handle: "@a" } }));
    expect(t.logs.join("\n")).toContain("creator.email");
    expect(t.logs.join("\n")).not.toContain("secret");
  });

  it.each([
    ["22P05", 400],
    ["22021", 400],
    // Can come from a bug in our own SQL: must stay a 500 so the sender retries.
    ["22P02", 500],
  ] as const)("database error %s maps to %i", async (code, status) => {
    const repository: CreatorRepository = {
      processEvent: async () => {
        throw new RepositoryError("process_onboarding_event failed", code);
      },
      claimStuckCreators: async () => [],
    };
    const t = setup({ repository });
    expect((await t.post(signupBody())).status).toBe(status);
  });
});

describe("processing", () => {
  it("valid signup creates the creator with signed_up", async () => {
    const t = setup();
    expect(await t.post(signupBody())).toEqual({ status: 200, body: { status: "processed" } });
    expect(t.repo.getCreator(CREATOR_ID)).toMatchObject({ status: "signed_up", email: EMAIL });
    expect(t.sent).toEqual([]);
  });

  it("full flow ends live and sends exactly one Slack live message", async () => {
    const t = setup();
    await t.post(signupBody());
    await t.post(stepBody("app_installed", "evt_app", "2026-11-17T12:00:00Z"));
    expect(await t.post(stepBody("payment_done", "evt_pay", "2026-11-18T12:30:00Z"))).toEqual({
      status: 200,
      body: { status: "processed" },
    });
    expect(t.repo.getCreator(CREATOR_ID)).toMatchObject({
      status: "live",
      lastStepAt: new Date("2026-11-18T12:30:00Z"),
      stuckAlertSentAt: null,
    });
    expect(t.sent).toEqual([":rocket: *Ana Souza* (@anasouza) is live! Onboarding took 26.5h."]);
  });

  it("skipping app_installed: signup then payment_done ends live with one message", async () => {
    const t = setup();
    await t.post(signupBody());
    expect(await t.post(stepBody("payment_done", "evt_pay", "2026-11-17T20:00:00Z"))).toEqual({
      status: 200,
      body: { status: "processed" },
    });
    expect(t.repo.getCreator(CREATOR_ID)?.status).toBe("live");
    expect(t.sent).toEqual([":rocket: *Ana Souza* (@anasouza) is live! Onboarding took 10h."]);
  });

  it("equal-rank event with an earlier time moves last_step_at back, keeps the stuck alert, sends nothing", async () => {
    const t = setup();
    await t.post(signupBody());
    await t.post(stepBody("app_installed", "evt_app_late", "2026-11-17T15:00:00Z"));
    const alertedAt = new Date("2026-11-18T17:00:00Z");
    t.repo.setStuckAlertSentAt(CREATOR_ID, alertedAt);
    expect(await t.post(stepBody("app_installed", "evt_app_early", "2026-11-17T12:00:00Z"))).toEqual({
      status: 200,
      body: { status: "processed" },
    });
    expect(t.repo.getCreator(CREATOR_ID)).toMatchObject({
      status: "app_installed",
      lastStepAt: new Date("2026-11-17T12:00:00Z"),
      stuckAlertSentAt: alertedAt,
    });
    expect(t.sent).toEqual([]);
  });

  it("signup resent with an earlier time moves onboarding_started_at (and last_step_at while signed_up)", async () => {
    const t = setup();
    await t.post(signupBody());
    await t.post(signupBody({ event_id: "evt_signup_early", occurred_at: "2026-11-17T08:00:00Z" }));
    expect(t.repo.getCreator(CREATOR_ID)).toMatchObject({
      status: "signed_up",
      onboardingStartedAt: new Date("2026-11-17T08:00:00Z"),
      lastStepAt: new Date("2026-11-17T08:00:00Z"),
    });
  });

  it("same event_id twice: second is duplicate with no side effects", async () => {
    const t = setup();
    await t.post(signupBody());
    const pay = stepBody("payment_done", "evt_pay", "2026-11-18T12:00:00Z");
    await t.post(pay);
    const before = { creator: t.repo.getCreator(CREATOR_ID), events: t.repo.getEvents() };
    expect(await t.post(pay)).toEqual({ status: 200, body: { status: "duplicate" } });
    expect({ creator: t.repo.getCreator(CREATOR_ID), events: t.repo.getEvents() }).toEqual(before);
    expect(t.sent).toHaveLength(1);
  });

  it("out-of-order app_installed after payment_done does not move status back", async () => {
    const t = setup();
    await t.post(signupBody());
    await t.post(stepBody("payment_done", "evt_pay", "2026-11-18T12:00:00Z"));
    expect((await t.post(stepBody("app_installed", "evt_app", "2026-11-17T12:00:00Z"))).body).toEqual({
      status: "processed",
    });
    expect(t.repo.getCreator(CREATOR_ID)?.status).toBe("live");
    expect(t.sent).toHaveLength(1);
  });

  it("non-signup before signup is pending; signup then reconciles and sends the live message", async () => {
    const t = setup();
    expect(await t.post(stepBody("payment_done", "evt_pay", "2026-11-18T12:00:00Z"))).toEqual({
      status: 200,
      body: { status: "pending" },
    });
    expect(t.sent).toEqual([]);
    expect(await t.post(signupBody())).toEqual({ status: 200, body: { status: "processed" } });
    expect(t.repo.getCreator(CREATOR_ID)?.status).toBe("live");
    expect(t.sent).toEqual([":rocket: *Ana Souza* (@anasouza) is live! Onboarding took 26h."]);
  });

  it("signup resent with a new event_id returns processed and keeps the profile", async () => {
    const t = setup();
    await t.post(signupBody());
    const resent = signupBody({
      event_id: "evt_signup_2",
      creator: { id: CREATOR_ID, name: "Changed", email: "changed@example.com", handle: "@changed" },
    });
    expect(await t.post(resent)).toEqual({ status: 200, body: { status: "processed" } });
    expect(t.repo.getCreator(CREATOR_ID)).toMatchObject({ name: "Ana Souza", email: EMAIL, handle: "@anasouza" });
  });

  it("signup with a new id but an existing email returns 409 and records nothing", async () => {
    const t = setup();
    await t.post(signupBody());
    const other = signupBody({
      event_id: "evt_other",
      creator: { id: OTHER_ID, name: "Bo", email: EMAIL.toUpperCase(), handle: "@bo" },
    });
    expect(await t.post(other)).toEqual({ status: 409, body: { error: "email already in use" } });
    expect(t.repo.getCreator(OTHER_ID)).toBeUndefined();
    expect(t.repo.getEvents().map((e) => e.eventId)).toEqual(["evt_signup"]);
    expect(t.logs.at(-1)).toBe(`[onboarding] email conflict event_id="evt_other" creator_id=${OTHER_ID} step=signup`);
  });

  it("live message duration uses onboarding_started_at and is clamped to 0", async () => {
    const t = setup();
    await t.post(stepBody("payment_done", "evt_pay", "2026-11-17T09:00:00Z")); // before signup
    await t.post(signupBody());
    expect(t.sent).toEqual([":rocket: *Ana Souza* (@anasouza) is live! Onboarding took 0h."]);
  });

  it("stores the parsed body as the payload", async () => {
    const t = setup();
    const body = { ...stepBody("app_installed", "evt_app", "2026-11-17T12:00:00Z"), extra: { kept: true } };
    await t.post(body);
    expect(t.repo.getEvents()[0]?.payload).toEqual(body);
  });
});

describe("Slack failures never change the response", () => {
  it.each([
    ["send returns false", async () => false],
    ["send throws (broken client)", async () => {
      throw new Error("boom");
    }],
  ])("%s: still 200 processed", async (name, send) => {
    const sendMock = vi.fn(send);
    const t = setup({ slack: { send: sendMock } });
    await t.post(signupBody());
    expect(await t.post(stepBody("payment_done", "evt_pay", "2026-11-18T12:00:00Z"))).toEqual({
      status: 200,
      body: { status: "processed" },
    });
    expect(t.repo.getCreator(CREATOR_ID)?.status).toBe("live");
    expect(sendMock).toHaveBeenCalledTimes(1);
    if (name.includes("throws")) {
      expect(t.logs).toContain(`[slack] send threw event_id="evt_pay" creator_id=${CREATOR_ID} step=payment_done`);
    }
  });
});

describe("errors (500)", () => {
  it("a database error returns a generic 500 and logs only the code and ids", async () => {
    const repository: CreatorRepository = {
      processEvent: async () => {
        throw new RepositoryError("process_onboarding_event failed", "40001");
      },
      claimStuckCreators: async () => [],
    };
    const t = setup({ repository });
    const res = await t.post(signupBody());
    expect(res).toEqual({ status: 500, body: { error: "internal error" } });
    expect(t.logs.at(-1)).toBe(`[onboarding] database error: 40001 event_id="evt_signup" creator_id=${CREATOR_ID} step=signup`);
  });

  it("an unexpected exception returns a generic 500 without the message or stack", async () => {
    const repository: CreatorRepository = {
      processEvent: async () => {
        throw new Error(`secret detail ${EMAIL}`);
      },
      claimStuckCreators: async () => [],
    };
    const t = setup({ repository });
    const res = await t.handler(t.request(JSON.stringify(signupBody())));
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).toBe('{"error":"internal error"}');
    expect(t.logs.join("\n")).not.toContain(EMAIL);
  });

  it("a non-env configuration error logs only its name", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createOnboardingHandler(() => {
      throw new TypeError(`client failed for https://example.supabase.co with key secret-key-value`);
    });
    const res = await handler(new Request("http://localhost/x", { method: "POST", body: "{}" }));
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith("[onboarding] configuration error: TypeError");
    errorSpy.mockRestore();
  });

  it("missing configuration returns a generic 500", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createOnboardingHandler(() => {
      const err = new Error("invalid environment: WEBHOOK_SECRET (missing)");
      err.name = "EnvError";
      throw err;
    });
    const res = await handler(new Request("http://localhost/x", { method: "POST", body: "{}" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
    expect(errorSpy).toHaveBeenCalledWith("[onboarding] configuration error: invalid environment: WEBHOOK_SECRET (missing)");
    errorSpy.mockRestore();
  });
});

describe("logging", () => {
  it("a newline in event_id can't forge a log line", async () => {
    const t = setup();
    await t.post(signupBody({ event_id: "evt\n[onboarding] fake line" }));
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).not.toContain("\n");
    expect(t.logs[0]).toContain('event_id="evt\\n[onboarding] fake line"');
  });

  it("never logs names, emails or payloads on the happy path", async () => {
    const t = setup();
    await t.post(signupBody());
    await t.post(stepBody("payment_done", "evt_pay", "2026-11-18T12:00:00Z"));
    const all = t.logs.join("\n");
    expect(all).not.toContain(EMAIL);
    expect(all).not.toContain("Ana");
    expect(t.logs).toEqual([
      `[onboarding] processed event_id="evt_signup" creator_id=${CREATOR_ID} step=signup`,
      `[onboarding] processed event_id="evt_pay" creator_id=${CREATOR_ID} step=payment_done became_live`,
    ]);
  });
});
