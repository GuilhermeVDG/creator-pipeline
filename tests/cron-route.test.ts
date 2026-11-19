import { describe, expect, it, vi } from "vitest";
import {
  InMemoryCreatorRepository,
  RepositoryError,
  UNEXPECTED_SHAPE,
  type CreatorRepository,
} from "@/src/lib/creators/repository";
import { createStuckCreatorsHandler, isAuthorized, type CronDeps } from "@/src/lib/cron/stuck-creators";
import type { SlackClient } from "@/src/lib/slack";
import type { OnboardingEvent } from "@/src/lib/webhooks/schema";

const SECRET = "c".repeat(32);
const AUTH = `Bearer ${SECRET}`;
const ANA = "8f0c2c1e-0b8a-4a4e-9f61-2f1f6c1e2a10";
const BO = "11111111-2222-4333-8444-555555555555";
const T0 = new Date("2026-11-15T00:00:00Z");
const hoursAfter = (h: number) => new Date(T0.getTime() + h * 3_600_000);

function signup(id: string, name: string, email: string, handle: string | null, at: Date): OnboardingEvent {
  return { eventId: `evt_${id}`, creatorId: id, step: "signup", occurredAt: at, profile: { name, email, handle: handle ?? "" } };
}

async function setup(overrides: Partial<CronDeps> = {}) {
  const clock = { now: hoursAfter(50) };
  const repo = new InMemoryCreatorRepository({ now: () => clock.now });
  await repo.processEvent({ event: signup(ANA, "Ana Souza", "ana@example.com", "@anasouza", T0), payload: {} });
  const sent: string[] = [];
  const slack: SlackClient = { send: vi.fn(async (text: string) => (sent.push(text), true)) };
  const logs: string[] = [];
  const logger = { info: vi.fn((m: string) => void logs.push(m)), error: vi.fn((m: string) => void logs.push(m)) };
  const deps: CronDeps = { repository: repo, slack, cronSecret: SECRET, now: () => clock.now, logger, ...overrides };
  const handler = createStuckCreatorsHandler(() => deps);
  async function get(authorization?: string) {
    const headers = new Headers();
    if (authorization !== undefined) headers.set("authorization", authorization);
    const res = await handler(new Request("http://localhost/api/cron/stuck-creators", { headers }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  return { clock, repo, sent, slack, logs, get };
}

describe("authorization (401)", () => {
  it.each([
    ["no header", undefined],
    ["wrong secret", `Bearer ${"x".repeat(32)}`],
    ["secret without Bearer", SECRET],
    ["lowercase scheme", `bearer ${SECRET}`],
    ["Basic scheme", `Basic ${SECRET}`],
    ["extra space", `Bearer  ${SECRET}`],
    // (A trailing space can't be tested: Headers trims surrounding whitespace, per the Fetch spec.)
    ["empty Bearer", "Bearer "],
    ["secret prefix only", `Bearer ${SECRET.slice(0, 31)}`],
    ["secret plus suffix", `${AUTH}x`],
  ])("%s returns 401 and claims nothing", async (_name, authorization) => {
    const t = await setup();
    expect(await t.get(authorization)).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(t.repo.getCreator(ANA)?.stuckAlertSentAt).toBeNull();
    expect(t.sent).toEqual([]);
    expect(t.logs).toEqual(["[cron] unauthorized"]);
  });

  it("isAuthorized never throws on length differences", () => {
    expect(() => isAuthorized("x", SECRET)).not.toThrow();
    expect(isAuthorized("x".repeat(10_000), SECRET)).toBe(false);
    expect(isAuthorized(AUTH, SECRET)).toBe(true);
  });
});

describe("alerting", () => {
  it("alerts a stuck creator once, and not again on the next run", async () => {
    const t = await setup();
    expect(await t.get(AUTH)).toEqual({ status: 200, body: { alerted: 1 } });
    expect(t.sent).toEqual([":warning: 1 creator(s) stuck for 48h+\n• *Ana Souza* (@anasouza): signed up, stuck 50h"]);
    expect(t.repo.getCreator(ANA)?.stuckAlertSentAt).toEqual(hoursAfter(50));

    t.clock.now = hoursAfter(51);
    expect(await t.get(AUTH)).toEqual({ status: 200, body: { alerted: 0 } });
    expect(t.sent).toHaveLength(1);
  });

  it("sends one message listing every stuck creator", async () => {
    const t = await setup();
    await t.repo.processEvent({ event: signup(BO, "Bo", "bo@example.com", "@bo", hoursAfter(1)), payload: {} });
    await t.repo.processEvent({
      event: { eventId: "evt_bo_app", creatorId: BO, step: "app_installed", occurredAt: hoursAfter(1.5) },
      payload: {},
    });
    expect(await t.get(AUTH)).toEqual({ status: 200, body: { alerted: 2 } });
    expect(t.sent).toHaveLength(1);
    const lines = (t.sent[0] ?? "").split("\n");
    expect(lines[0]).toBe(":warning: 2 creator(s) stuck for 48h+");
    // Longest stuck first.
    expect(lines.slice(1)).toEqual([
      "• *Ana Souza* (@anasouza): signed up, stuck 50h",
      "• *Bo* (@bo): app installed, stuck 48h",
    ]);
  });

  it("nobody stuck: alerted 0 and no Slack message", async () => {
    const t = await setup();
    t.clock.now = hoursAfter(47);
    expect(await t.get(AUTH)).toEqual({ status: 200, body: { alerted: 0 } });
    expect(t.sent).toEqual([]);
    expect(t.repo.getCreator(ANA)?.stuckAlertSentAt).toBeNull();
  });

  it("a live creator is never alerted", async () => {
    const t = await setup();
    await t.repo.processEvent({
      event: { eventId: "evt_pay", creatorId: ANA, step: "payment_done", occurredAt: hoursAfter(1) },
      payload: {},
    });
    expect(await t.get(AUTH)).toEqual({ status: 200, body: { alerted: 0 } });
  });

  it("logs ids only, never names", async () => {
    const t = await setup();
    await t.get(AUTH);
    expect(t.logs).toEqual([`[cron] alerted 1 creator(s): ${ANA}`]);
  });
});

describe("Slack failures", () => {
  it.each([
    ["send returns false", async () => false],
    ["send throws", async () => {
      throw new Error("boom");
    }],
  ])("%s: still 200, creators stay marked, loss is logged", async (_name, send) => {
    const sendMock = vi.fn(send);
    const t = await setup({ slack: { send: sendMock } });
    expect(await t.get(AUTH)).toEqual({ status: 200, body: { alerted: 1 } });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(t.repo.getCreator(ANA)?.stuckAlertSentAt).toEqual(hoursAfter(50));
    expect(t.logs).toEqual([`[cron] slack failed, 1 alert(s) lost: ${ANA}`]);
  });
});

describe("lost-alert log size", () => {
  it(`lists at most ${20} ids and counts the rest`, async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: `C${i}`,
      handle: null,
      status: "signed_up" as const,
      lastStepAt: T0,
    }));
    const repository: CreatorRepository = {
      processEvent: async () => {
        throw new Error("unused");
      },
      claimStuckCreators: async () => many,
    };
    const t = await setup({ repository, slack: { send: async () => false } });
    expect(await t.get(AUTH)).toEqual({ status: 200, body: { alerted: 25 } });
    const line = t.logs[0] ?? "";
    expect(line.startsWith("[cron] slack failed, 25 alert(s) lost: ")).toBe(true);
    expect(line.endsWith(" …+5")).toBe(true);
    expect(line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)).toHaveLength(20);
  });
});

describe("errors (500)", () => {
  const failing = (code: string): CreatorRepository => ({
    processEvent: async () => {
      throw new Error("unused");
    },
    claimStuckCreators: async () => {
      throw new RepositoryError("claim_stuck_creators failed", code);
    },
  });

  it("an unparseable claim response logs that alerts were lost", async () => {
    const t = await setup({ repository: failing(UNEXPECTED_SHAPE) });
    expect(await t.get(AUTH)).toEqual({ status: 500, body: { error: "internal error" } });
    expect(t.logs).toEqual(["[cron] claimed but unparseable response: alerts lost"]);
  });

  it("a database error without a code logs unknown", async () => {
    const repository: CreatorRepository = {
      processEvent: async () => {
        throw new Error("unused");
      },
      claimStuckCreators: async () => {
        throw new RepositoryError("claim_stuck_creators failed");
      },
    };
    const t = await setup({ repository });
    await t.get(AUTH);
    expect(t.logs).toEqual(["[cron] database error: unknown"]);
  });

  it("a database error logs only its code", async () => {
    const t = await setup({ repository: failing("42501") });
    expect(await t.get(AUTH)).toEqual({ status: 500, body: { error: "internal error" } });
    expect(t.logs).toEqual(["[cron] database error: 42501"]);
  });

  it("configuration errors: 500, EnvError message only", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const envErr = new Error("invalid environment: CRON_SECRET (missing)");
    envErr.name = "EnvError";
    const h1 = createStuckCreatorsHandler(() => {
      throw envErr;
    });
    const h2 = createStuckCreatorsHandler(() => {
      throw new TypeError(`bad url https://x.supabase.co key ${SECRET}`);
    });
    const r1 = await h1(new Request("http://localhost/x", { headers: { authorization: AUTH } }));
    const r2 = await h2(new Request("http://localhost/x", { headers: { authorization: AUTH } }));
    expect([r1.status, r2.status]).toEqual([500, 500]);
    expect(await r2.json()).toEqual({ error: "internal error" });
    expect(errorSpy.mock.calls.map((c) => c[0])).toEqual([
      "[cron] configuration error: invalid environment: CRON_SECRET (missing)",
      "[cron] configuration error: TypeError",
    ]);
    errorSpy.mockRestore();
  });
});
