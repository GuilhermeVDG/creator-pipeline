// Opt-in integration test against the real dev Supabase project.
//   npm run test:integration      (RUN_INTEGRATION=1, credentials from .env.local)
// Skipped in `npm test`. Apply supabase/migrations/ to the dev project first.
//
// Every row is tagged: event ids start with `evt_test_`, emails end with
// `@test.invalid`. The service role has no DELETE (least privilege), so the
// test prints a cleanup statement for the SQL editor instead of deleting.
// So that a deployed cron never alerts ops about test creators, afterAll marks
// every creator this run created as already alerted.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  InMemoryCreatorRepository,
  createSupabaseCreatorRepository,
  type CreatorRepository,
  type ProcessResult,
} from "@/src/lib/creators/repository";
import { getEnv } from "@/src/lib/env";
import type { Step } from "@/src/lib/creators/transitions";
import type { OnboardingEvent } from "@/src/lib/webhooks/schema";
import { TRANSITION_CASES, at, eventIdFor, type EventExpectation } from "../fixtures/transition-cases";

const ENABLED = process.env.RUN_INTEGRATION === "1";
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const ALERT_MARK = "2000-01-01T00:00:00Z";
const REQUEST_TIMEOUT_MS = 15_000;

/** Independent of standard_conforming_strings: no backslash escapes. */
export const CLEANUP_SQL = [
  "delete from public.webhook_events where starts_with(event_id, 'evt_test_');",
  "delete from public.creators where email like '%@test.invalid';",
].join("\n");

const eventId = (suffix: string) => `evt_test_${RUN}_${suffix}`;
const email = (suffix: string) => `${RUN}.${suffix}@test.invalid`;

/** Every creator id this run may have written, so afterAll can silence them. */
const createdIds: string[] = [];
function newCreatorId(): string {
  const id = randomUUID();
  createdIds.push(id);
  return id;
}

function makeEvent(step: Step, occurredAt: Date, id: string, creatorId: string, mail: string): OnboardingEvent {
  return step === "signup"
    ? { eventId: id, creatorId, step, occurredAt, profile: { name: "Test Creator", email: mail, handle: "@test" } }
    : { eventId: id, creatorId, step, occurredAt };
}

type Row = {
  status: string;
  last_step_at: string;
  onboarding_started_at: string;
  stuck_alert_sent_at: string | null;
  name: string;
  email: string;
  handle: string | null;
};

const claimRows = z.array(z.object({ id: z.string(), status: z.string(), last_step_at: z.string() }));

const PROCESSED = { result: "processed", becameLive: false } as const;

describe.skipIf(!ENABLED)("process_onboarding_event against the dev database", { timeout: 60_000 }, () => {
  let repo: CreatorRepository;
  let db: SupabaseClient;

  beforeAll(() => {
    process.loadEnvFile(".env.local");
    const env = getEnv();
    repo = createSupabaseCreatorRepository();
    db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      // A stalled request fails after 15 s instead of holding the test for 60 s.
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }) },
    });
  });

  // Runs even when tests fail. Only this run's ids, never a pattern across runs.
  afterAll(async () => {
    if (db !== undefined) {
      for (let i = 0; i < createdIds.length; i += 100) {
        const { error } = await db
          .from("creators")
          .update({ stuck_alert_sent_at: ALERT_MARK })
          .in("id", createdIds.slice(i, i + 100))
          .is("stuck_alert_sent_at", null);
        if (error) console.error(`[integration] could not silence test creators: ${error.code}`);
      }
    }
    console.info(
      `\n[integration] run ${RUN} done; its ${createdIds.length} test creator(s) are marked as alerted. ` +
        `The service role can't delete, so clean up test rows (this and earlier runs) in the Supabase SQL editor:\n\n` +
        `${CLEANUP_SQL}\n`,
    );
  });

  async function row(id: string): Promise<Row | null> {
    const { data, error } = await db
      .from("creators")
      .select("status, last_step_at, onboarding_started_at, stuck_alert_sent_at, name, email, handle")
      .eq("id", id)
      .maybeSingle<Row>();
    if (error) throw new Error(`select failed: ${error.code}`);
    return data;
  }

  async function markAlerted(id: string): Promise<void> {
    const { error } = await db.from("creators").update({ stuck_alert_sent_at: ALERT_MARK }).eq("id", id);
    if (error) throw new Error(`update failed: ${error.code}`);
  }

  async function eventCount(id: string): Promise<number> {
    const { count, error } = await db
      .from("webhook_events")
      .select("event_id", { count: "exact", head: true })
      .eq("event_id", id);
    if (error) throw new Error(`count failed: ${error.code}`);
    return count ?? 0;
  }

  const becameLive = (r: ProcessResult) => r.result === "processed" && r.becameLive;
  const signup = (id: string, mail: string, suffix: string, occurredAt = at(0)) =>
    repo.processEvent({ event: makeEvent("signup", occurredAt, eventId(suffix), id, mail), payload: {} });

  describe("shared transition table", () => {
    it.each(TRANSITION_CASES.map((c, i) => [c.name, c, i] as const))("%s", async (_name, c, caseIndex) => {
      const creatorId = newCreatorId();
      const mail = email(`case${caseIndex}`);
      const perEvent: EventExpectation[] = [];

      for (const [i, e] of c.events.entries()) {
        const existed = (await row(creatorId)) !== null;
        if (existed) await markAlerted(creatorId);

        const r = await repo.processEvent({
          event: makeEvent(e.step, at(e.at), eventId(`c${caseIndex}_${eventIdFor(e, i)}`), creatorId, mail),
          payload: { test: true, run: RUN },
        });
        // One creator, one email: a conflict here is always a bug.
        if (r.result === "email_conflict") throw new Error(`unexpected email_conflict at event ${i}`);

        const after = await row(creatorId);
        const statusChanged =
          after !== null && (existed ? after.stuck_alert_sent_at === null : r.result === "processed");
        perEvent.push({ result: r.result, statusChanged, becameLive: becameLive(r) });
      }

      const final = await row(creatorId);
      expect({
        perEvent,
        status: final?.status ?? null,
        lastStepAt: final ? new Date(final.last_step_at) : null,
        onboardingStartedAt: final ? new Date(final.onboarding_started_at) : null,
      }).toEqual({
        perEvent: c.events.map((e) => e.expect),
        status: c.expected.status,
        lastStepAt: c.expected.lastStepAt === null ? null : at(c.expected.lastStepAt),
        onboardingStartedAt: c.expected.onboardingStartedAt === null ? null : at(c.expected.onboardingStartedAt),
      });
      expect(perEvent.filter((p) => p.becameLive)).toHaveLength(c.expected.liveMessages);
    });
  });

  describe("email conflicts", () => {
    it("case-insensitive conflict records nothing, and a resend is a conflict again", async () => {
      const a = newCreatorId();
      const b = newCreatorId();
      const mail = email("conflict");
      expect(await signup(a, mail, "conf_a")).toEqual(PROCESSED);

      const conflicting = makeEvent("signup", at(1), eventId("conf_b"), b, mail.toUpperCase());
      expect(await repo.processEvent({ event: conflicting, payload: {} })).toEqual({ result: "email_conflict" });
      expect(await row(b)).toBeNull();
      expect(await eventCount(eventId("conf_b"))).toBe(0);
      expect(await repo.processEvent({ event: conflicting, payload: {} })).toEqual({ result: "email_conflict" });
    });

    it("a resent signup using another creator's email is processed and changes nothing", async () => {
      const a = newCreatorId();
      const c = newCreatorId();
      expect(await signup(a, email("other_a"), "other_a")).toEqual(PROCESSED);
      expect(await signup(c, email("other_c"), "other_c1")).toEqual(PROCESSED);
      const resent: OnboardingEvent = {
        eventId: eventId("other_c2"),
        creatorId: c,
        step: "signup",
        occurredAt: at(1),
        profile: { name: "Changed", email: email("other_a"), handle: "@changed" },
      };
      expect(await repo.processEvent({ event: resent, payload: {} })).toEqual(PROCESSED);
      expect(await row(c)).toMatchObject({ name: "Test Creator", email: email("other_c"), handle: "@test" });
    });

    it("non-ASCII case variants: reports what Postgres decides and any mismatch with the fake", async () => {
      // Decision (a): Postgres lower() under the database collation is the
      // source of truth. The fake only matches it for ASCII, so a difference
      // here is reported loudly, not failed.
      const pairs: Array<[string, string]> = [
        [`josé.${RUN}@test.invalid`, `JOSÉ.${RUN}@test.invalid`],
        [`i̇stanbul.${RUN}@test.invalid`, `İSTANBUL.${RUN}@test.invalid`],
      ];
      for (const [k, [first, second]] of pairs.entries()) {
        // The first signup must succeed, or the comparison means nothing.
        expect(await signup(newCreatorId(), first, `na${k}_1`)).toEqual(PROCESSED);
        const sql = (await signup(newCreatorId(), second, `na${k}_2`)).result;

        const fake = new InMemoryCreatorRepository();
        await fake.processEvent({ event: makeEvent("signup", at(0), "e1", randomUUID(), first), payload: {} });
        const fakeResult = (
          await fake.processEvent({ event: makeEvent("signup", at(0), "e2", randomUUID(), second), payload: {} })
        ).result;

        const line = `[integration] non-ASCII "${first}" vs "${second}": postgres=${sql} fake=${fakeResult}`;
        if (sql !== fakeResult) console.warn(`${line}  <-- MISMATCH (expected for non-ASCII; Postgres decides)`);
        else console.info(line);
        expect(["email_conflict", "processed"]).toContain(sql);
      }
    });
  });

  describe("claim_stuck_creators", () => {
    // A huge threshold so only very old rows qualify (last_step_at before ~2004),
    // never real dev data. Results are filtered to this test's ids.
    const MIN_HOURS = 200_000; // ~22.8 years

    it("claims a stuck creator once and never a live one", async () => {
      const stuck = newCreatorId();
      const live = newCreatorId();
      const old = new Date("2001-01-01T00:00:00Z");
      expect(await signup(stuck, email("stuck"), "stuck", old)).toEqual(PROCESSED);
      expect(await signup(live, email("live"), "live", old)).toEqual(PROCESSED);
      expect(
        await repo.processEvent({ event: makeEvent("payment_done", old, eventId("live_pay"), live, ""), payload: {} }),
      ).toMatchObject({ result: "processed", becameLive: true });

      const claim = async () => {
        const { data, error } = await db.rpc("claim_stuck_creators", { p_min_hours: MIN_HOURS });
        if (error) throw new Error(`claim failed: ${error.code}`);
        return claimRows.parse(data).filter((c) => c.id === stuck || c.id === live);
      };
      const first = await claim();
      expect(first.map((c) => ({ id: c.id, status: c.status }))).toEqual([{ id: stuck, status: "signed_up" }]);
      expect(first[0]?.last_step_at.endsWith("+00:00")).toBe(true);
      expect(await claim()).toEqual([]);
    });
  });

  describe("concurrency (per-creator advisory lock)", () => {
    const RUNS = 10;

    it(`signup and payment_done at the same time always end live with one live message (${RUNS} runs)`, async () => {
      for (let i = 0; i < RUNS; i++) {
        const id = newCreatorId();
        const results = await Promise.all([
          signup(id, email(`cc${i}`), `cc${i}_s`),
          repo.processEvent({ event: makeEvent("payment_done", at(10), eventId(`cc${i}_p`), id, ""), payload: {} }),
        ]);
        expect((await row(id))?.status).toBe("live");
        expect(results.filter(becameLive)).toHaveLength(1);
      }
    });

    it(`two signups for the same id at the same time never return 409 (${RUNS} runs)`, async () => {
      for (let i = 0; i < RUNS; i++) {
        const id = newCreatorId();
        const mail = email(`dbl${i}`);
        const results = await Promise.all([signup(id, mail, `dbl${i}_a`), signup(id, mail, `dbl${i}_b`, at(1))]);
        expect(results.map((r) => r.result)).toEqual(["processed", "processed"]);
        expect(await row(id)).not.toBeNull();
      }
    });
  });
});

describe("integration suite wiring", () => {
  it("is disabled unless RUN_INTEGRATION=1", () => {
    expect(ENABLED).toBe(process.env.RUN_INTEGRATION === "1");
  });

  it("cleanup SQL only targets tagged rows, without backslash escapes", () => {
    expect(CLEANUP_SQL).toContain("starts_with(event_id, 'evt_test_')");
    expect(CLEANUP_SQL).toContain("like '%@test.invalid'");
    expect(CLEANUP_SQL).not.toContain("\\");
  });
});
