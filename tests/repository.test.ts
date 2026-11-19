import { describe, expect, it } from "vitest";
import {
  InMemoryCreatorRepository,
  STUCK_AFTER_HOURS,
  type ProcessResult,
} from "@/src/lib/creators/repository";
import type { Step } from "@/src/lib/creators/transitions";
import type { OnboardingEvent } from "@/src/lib/webhooks/schema";
import type { JsonValue } from "@/src/lib/creators/repository";
import { TRANSITION_CASES, at, eventIdFor, type EventExpectation } from "./fixtures/transition-cases";

const CREATOR_ID = "8f0c2c1e-0b8a-4a4e-9f61-2f1f6c1e2a10";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";
const PROFILE = { name: "Ana Souza", email: "ana@example.com", handle: "@anasouza" };
/** Marks stuck_alert_sent_at before each event, to see whether the event reset it. */
const ALERT_MARK = new Date("2000-01-01T00:00:00Z");

function makeEvent(step: Step, occurredAt: Date, eventId: string, creatorId = CREATOR_ID): OnboardingEvent {
  return step === "signup"
    ? { eventId, creatorId, step, occurredAt, profile: PROFILE }
    : { eventId, creatorId, step, occurredAt };
}

function process(repo: InMemoryCreatorRepository, event: OnboardingEvent, payload: JsonValue = { raw: true }) {
  return repo.processEvent({ event, payload });
}

const becameLive = (r: ProcessResult) => r.result === "processed" && r.becameLive;

describe("shared transition cases (in-memory repository)", () => {
  it.each(TRANSITION_CASES)("$name", async ({ events, expected }) => {
    const repo = new InMemoryCreatorRepository({ now: () => at(1000) });
    const perEvent: EventExpectation[] = [];

    for (const [index, e] of events.entries()) {
      const existed = repo.getCreator(CREATOR_ID) !== undefined;
      if (existed) repo.setStuckAlertSentAt(CREATOR_ID, ALERT_MARK);

      const r = await process(repo, makeEvent(e.step, at(e.at), eventIdFor(e, index)));
      // One creator, one email: a conflict here is always a bug (e.g. SQL that
      // treats a primary-key violation on a resent signup as an email conflict).
      if (r.result === "email_conflict") throw new Error(`unexpected email_conflict at event ${index}`);

      const after = repo.getCreator(CREATOR_ID);
      // Created, or an existing creator's alert mark was reset: a status change.
      const statusChanged = after !== undefined && (existed ? after.stuckAlertSentAt === null : r.result === "processed");
      perEvent.push({
        result: r.result,
        statusChanged,
        becameLive: becameLive(r),
      });
    }

    const creator = repo.getCreator(CREATOR_ID);
    expect({
      perEvent,
      status: creator?.status ?? null,
      lastStepAt: creator?.lastStepAt ?? null,
      onboardingStartedAt: creator?.onboardingStartedAt ?? null,
    }).toEqual({
      perEvent: events.map((e) => e.expect),
      status: expected.status,
      lastStepAt: expected.lastStepAt === null ? null : at(expected.lastStepAt),
      onboardingStartedAt: expected.onboardingStartedAt === null ? null : at(expected.onboardingStartedAt),
    });
    expect(perEvent.filter((p) => p.becameLive)).toHaveLength(expected.liveMessages);
  });
});

describe("processEvent: email conflict", () => {
  it("signup with a new id but an existing email (any case) returns email_conflict and records nothing", async () => {
    const repo = new InMemoryCreatorRepository();
    await process(repo, makeEvent("signup", at(0), "evt_a"));

    const conflicting: OnboardingEvent = {
      eventId: "evt_b",
      creatorId: OTHER_ID,
      step: "signup",
      occurredAt: at(1),
      profile: { ...PROFILE, email: "ANA@Example.com" },
    };
    expect(await process(repo, conflicting)).toEqual({ result: "email_conflict" });
    expect(repo.getCreator(OTHER_ID)).toBeUndefined();
    expect(repo.getEvents().map((e) => e.eventId)).toEqual(["evt_a"]);

    // Not recorded, so a resend is a conflict again, not a duplicate.
    expect(await process(repo, conflicting)).toEqual({ result: "email_conflict" });
  });

  it("a resent signup whose email belongs to another creator is processed, not a conflict", async () => {
    const repo = new InMemoryCreatorRepository();
    await process(repo, makeEvent("signup", at(0), "evt_a"));
    const bo = { name: "Bo", email: "bo@example.com", handle: "@bo" };
    await process(repo, { eventId: "evt_b", creatorId: OTHER_ID, step: "signup", occurredAt: at(1), profile: bo });

    const resent: OnboardingEvent = {
      eventId: "evt_c",
      creatorId: OTHER_ID,
      step: "signup",
      occurredAt: at(2),
      profile: { ...bo, email: PROFILE.email },
    };
    expect(await process(repo, resent)).toEqual({ result: "processed", becameLive: false });
    expect(repo.getCreator(OTHER_ID)).toMatchObject(bo);
  });

  it("pending events for the conflicting creator stay pending", async () => {
    const repo = new InMemoryCreatorRepository();
    await process(repo, makeEvent("signup", at(0), "evt_a"));
    expect(await process(repo, makeEvent("payment_done", at(5), "evt_p", OTHER_ID))).toEqual({ result: "pending" });
    await process(repo, { eventId: "evt_b", creatorId: OTHER_ID, step: "signup", occurredAt: at(1), profile: PROFILE });
    expect(repo.getCreator(OTHER_ID)).toBeUndefined();
    expect(repo.getEvents().map((e) => e.eventId)).toEqual(["evt_a", "evt_p"]);
  });
});

describe("processEvent: creator data", () => {
  it("valid signup creates the creator with signed_up", async () => {
    const now = at(500);
    const repo = new InMemoryCreatorRepository({ now: () => now });
    expect(await process(repo, makeEvent("signup", at(0), "evt_a"))).toEqual({
      result: "processed",
      becameLive: false,
    });
    expect(repo.getCreator(CREATOR_ID)).toEqual({
      id: CREATOR_ID,
      ...PROFILE,
      status: "signed_up",
      lastStepAt: at(0),
      stuckAlertSentAt: null,
      onboardingStartedAt: at(0),
      createdAt: now,
      updatedAt: now,
    });
  });

  it("a resent signup never changes name, email or handle", async () => {
    const repo = new InMemoryCreatorRepository();
    await process(repo, makeEvent("signup", at(5), "evt_a"));
    const resent: OnboardingEvent = {
      eventId: "evt_b",
      creatorId: CREATOR_ID,
      step: "signup",
      occurredAt: at(0),
      profile: { name: "Changed", email: "changed@example.com", handle: "@changed" },
    };
    expect(await process(repo, resent)).toEqual({ result: "processed", becameLive: false });
    expect(repo.getCreator(CREATOR_ID)).toMatchObject({ ...PROFILE, onboardingStartedAt: at(0), lastStepAt: at(0) });
  });

  it("stores the payload as given, with the event fields", async () => {
    const repo = new InMemoryCreatorRepository({ now: () => at(99) });
    const payload = { event_id: "evt_p", step: "payment_done", extra: { nested: [1, 2] } };
    await process(repo, makeEvent("payment_done", at(3), "evt_p"), payload);
    expect(repo.getEvents()).toEqual([
      { eventId: "evt_p", creatorId: CREATOR_ID, step: "payment_done", occurredAt: at(3), payload, receivedAt: at(99) },
    ]);
  });

  it("stored rows can't be mutated through returned or passed objects", async () => {
    const repo = new InMemoryCreatorRepository();
    const payload = { a: 1 };
    const occurredAt = at(0);
    await process(repo, makeEvent("signup", occurredAt, "evt_a"), payload);
    payload.a = 2;
    occurredAt.setTime(0);
    const row = repo.getCreator(CREATOR_ID);
    if (row) {
      row.status = "live";
      row.lastStepAt.setTime(0);
    }
    repo.getEvents()[0]?.occurredAt.setTime(0);
    expect(repo.getCreator(CREATOR_ID)).toMatchObject({ status: "signed_up", lastStepAt: at(0), onboardingStartedAt: at(0) });
    expect(repo.getEvents()[0]).toMatchObject({ payload: { a: 1 }, occurredAt: at(0) });
  });

  it("returned live and stuck data can't mutate stored state", async () => {
    const now = { value: at(0) };
    const repo = new InMemoryCreatorRepository({ now: () => now.value });
    await process(repo, makeEvent("signup", at(0), "evt_a"));
    now.value = at(49 * 60);
    const [claimed] = await repo.claimStuckCreators();
    claimed?.lastStepAt.setTime(0);
    const r = await process(repo, makeEvent("payment_done", at(10), "evt_p"));
    if (r.result === "processed" && r.becameLive) r.creator.onboardingStartedAt.setTime(0);
    expect(repo.getCreator(CREATOR_ID)).toMatchObject({ lastStepAt: at(10), onboardingStartedAt: at(0) });
    now.value.setTime(1);
    expect(repo.getCreator(CREATOR_ID)?.stuckAlertSentAt).toBeNull();
  });

  it("updated_at changes on a time correction, not on a no-op", async () => {
    let now = at(100);
    const repo = new InMemoryCreatorRepository({ now: () => now });
    await process(repo, makeEvent("signup", at(0), "evt_a"));
    await process(repo, makeEvent("app_installed", at(15), "evt_b"));
    now = at(200);
    await process(repo, makeEvent("app_installed", at(20), "evt_c")); // later: no-op
    expect(repo.getCreator(CREATOR_ID)?.updatedAt).toEqual(at(100));
    now = at(300);
    await process(repo, makeEvent("app_installed", at(10), "evt_d")); // earlier: correction
    expect(repo.getCreator(CREATOR_ID)).toMatchObject({ lastStepAt: at(10), updatedAt: at(300) });
  });
});

describe("processEvent: live message data", () => {
  it("full flow returns the creator data once, with liveAt from payment_done", async () => {
    const repo = new InMemoryCreatorRepository();
    await process(repo, makeEvent("signup", at(0), "evt_a"));
    await process(repo, makeEvent("app_installed", at(60), "evt_b"));
    expect(await process(repo, makeEvent("payment_done", at(120), "evt_c"))).toEqual({
      result: "processed",
      becameLive: true,
      creator: { name: PROFILE.name, handle: PROFILE.handle, onboardingStartedAt: at(0), liveAt: at(120) },
    });
  });

  it("reconciled at signup: liveAt is the stored payment_done time", async () => {
    const repo = new InMemoryCreatorRepository();
    await process(repo, makeEvent("payment_done", at(30), "evt_p"));
    expect(await process(repo, makeEvent("signup", at(0), "evt_s"))).toEqual({
      result: "processed",
      becameLive: true,
      creator: { name: PROFILE.name, handle: PROFILE.handle, onboardingStartedAt: at(0), liveAt: at(30) },
    });
  });
});

describe("claimStuckCreators", () => {
  const hours = (n: number) => at(n * 60);

  async function withCreatorAt(lastStep: Date, now: { value: Date }) {
    const repo = new InMemoryCreatorRepository({ now: () => now.value });
    await process(repo, makeEvent("signup", lastStep, "evt_a"));
    return repo;
  }

  it("alerts a stuck creator once, and not again on the next run", async () => {
    const now = { value: hours(STUCK_AFTER_HOURS + 1) };
    const repo = await withCreatorAt(hours(0), now);
    expect(await repo.claimStuckCreators()).toEqual([
      { id: CREATOR_ID, name: PROFILE.name, handle: PROFILE.handle, status: "signed_up", lastStepAt: hours(0) },
    ]);
    expect(repo.getCreator(CREATOR_ID)?.stuckAlertSentAt).toEqual(now.value);
    now.value = hours(STUCK_AFTER_HOURS + 2);
    expect(await repo.claimStuckCreators()).toEqual([]);
  });

  it("exactly 48h is not stuck yet (strictly older)", async () => {
    const now = { value: hours(STUCK_AFTER_HOURS) };
    const repo = await withCreatorAt(hours(0), now);
    expect(await repo.claimStuckCreators()).toEqual([]);
  });

  it("live creators are never stuck", async () => {
    const now = { value: hours(100) };
    const repo = await withCreatorAt(hours(0), now);
    await process(repo, makeEvent("payment_done", hours(1), "evt_p"));
    expect(await repo.claimStuckCreators()).toEqual([]);
  });

  it("a status change re-arms the alert for the new step", async () => {
    const now = { value: hours(49) };
    const repo = await withCreatorAt(hours(0), now);
    expect(await repo.claimStuckCreators()).toHaveLength(1);
    await process(repo, makeEvent("app_installed", hours(50), "evt_b"));
    expect(repo.getCreator(CREATOR_ID)?.stuckAlertSentAt).toBeNull();
    now.value = hours(97);
    expect(await repo.claimStuckCreators()).toEqual([]); // 47h on the new step
    now.value = hours(98.5); // 48.5h on the new step
    expect(await repo.claimStuckCreators()).toEqual([expect.objectContaining({ status: "app_installed" })]);
  });

  it("an equal-rank time correction does not re-arm the alert", async () => {
    const now = { value: hours(49) };
    const repo = await withCreatorAt(hours(1), now);
    now.value = hours(50);
    expect(await repo.claimStuckCreators()).toHaveLength(1);
    await process(repo, makeEvent("signup", hours(0), "evt_b")); // earlier signup: moves lastStepAt back
    expect(repo.getCreator(CREATOR_ID)).toMatchObject({ lastStepAt: hours(0), stuckAlertSentAt: hours(50) });
    expect(await repo.claimStuckCreators()).toEqual([]);
  });

  it("returns the longest stuck first, like the SQL", async () => {
    const now = { value: hours(100) };
    const repo = new InMemoryCreatorRepository({ now: () => now.value });
    await process(repo, makeEvent("signup", hours(10), "evt_a"));
    await process(repo, {
      eventId: "evt_b",
      creatorId: OTHER_ID,
      step: "signup",
      occurredAt: hours(5),
      profile: { ...PROFILE, email: "bo@example.com" },
    });
    expect((await repo.claimStuckCreators()).map((c) => c.id)).toEqual([OTHER_ID, CREATOR_ID]);
  });

  it("pending events don't create stuck creators", async () => {
    const now = { value: hours(100) };
    const repo = new InMemoryCreatorRepository({ now: () => now.value });
    await process(repo, makeEvent("app_installed", hours(0), "evt_b"));
    expect(await repo.claimStuckCreators()).toEqual([]);
  });
});
