import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// supabase-js mocked only for the createSupabaseCreatorRepository tests below.
const supabaseMock = vi.hoisted(() => ({
  rpc: vi.fn(),
  createClient: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: supabaseMock.createClient.mockImplementation(() => ({ rpc: supabaseMock.rpc })),
}));

import {
  RepositoryError,
  STUCK_AFTER_HOURS,
  SupabaseCreatorRepository,
  UNEXPECTED_SHAPE,
  createSupabaseCreatorRepository,
  type RpcCall,
} from "@/src/lib/creators/repository";
import type { OnboardingEvent } from "@/src/lib/webhooks/schema";

const CREATOR_ID = "8f0c2c1e-0b8a-4a4e-9f61-2f1f6c1e2a10";
const SIGNUP: OnboardingEvent = {
  eventId: "evt_1",
  creatorId: CREATOR_ID,
  step: "signup",
  occurredAt: new Date("2026-11-18T17:00:00Z"),
  profile: { name: "Ana Souza", email: "Ana@Example.com", handle: "@anasouza" },
};
const PAYMENT: OnboardingEvent = {
  eventId: "evt_2",
  creatorId: CREATOR_ID,
  step: "payment_done",
  occurredAt: new Date("2026-11-19T19:00:00Z"),
};

function repoReturning(response: { data: unknown; error: { code?: string } | null }) {
  const rpc = vi.fn<RpcCall>(async () => response);
  return { repo: new SupabaseCreatorRepository(rpc), rpc };
}

describe("SupabaseCreatorRepository.processEvent: arguments", () => {
  it("signup sends the profile and the ISO timestamp", async () => {
    const { repo, rpc } = repoReturning({ data: { result: "processed", became_live: false }, error: null });
    await repo.processEvent({ event: SIGNUP, payload: { step: "signup" } });
    expect(rpc).toHaveBeenCalledWith("process_onboarding_event", {
      p_event_id: "evt_1",
      p_creator_id: CREATOR_ID,
      p_step: "signup",
      p_occurred_at: "2026-11-18T17:00:00.000Z",
      p_payload: { step: "signup" },
      p_name: "Ana Souza",
      p_email: "Ana@Example.com",
      p_handle: "@anasouza",
    });
  });

  it("other steps send null profile fields", async () => {
    const { repo, rpc } = repoReturning({ data: { result: "pending" }, error: null });
    await repo.processEvent({ event: PAYMENT, payload: {} });
    expect(rpc).toHaveBeenCalledWith(
      "process_onboarding_event",
      expect.objectContaining({ p_step: "payment_done", p_name: null, p_email: null, p_handle: null }),
    );
  });
});

describe("SupabaseCreatorRepository.processEvent: responses", () => {
  it.each(["duplicate", "pending", "email_conflict"] as const)("maps %s", async (result) => {
    const { repo } = repoReturning({ data: { result }, error: null });
    await expect(repo.processEvent({ event: PAYMENT, payload: {} })).resolves.toEqual({ result });
  });

  it("maps processed without live", async () => {
    const { repo } = repoReturning({ data: { result: "processed", became_live: false }, error: null });
    await expect(repo.processEvent({ event: PAYMENT, payload: {} })).resolves.toEqual({
      result: "processed",
      becameLive: false,
    });
  });

  it("maps became_live with Postgres timestamps (microseconds, +00:00 offset)", async () => {
    const { repo } = repoReturning({
      data: {
        result: "processed",
        became_live: true,
        name: "Ana Souza",
        handle: null,
        onboarding_started_at: "2026-11-18T17:00:00.123456+00:00",
        live_at: "2026-11-19T16:00:00-03:00",
      },
      error: null,
    });
    await expect(repo.processEvent({ event: PAYMENT, payload: {} })).resolves.toEqual({
      result: "processed",
      becameLive: true,
      creator: {
        name: "Ana Souza",
        handle: null,
        onboardingStartedAt: new Date("2026-11-18T17:00:00.123Z"),
        liveAt: new Date("2026-11-19T19:00:00Z"),
      },
    });
  });

  it.each([
    ["null", null],
    ["unknown result", { result: "ok" }],
    ["processed without became_live", { result: "processed" }],
    ["live without creator data", { result: "processed", became_live: true }],
    ["bad timestamp", {
      result: "processed", became_live: true, name: "A", handle: null,
      onboarding_started_at: "yesterday", live_at: "2026-11-19T19:00:00Z",
    }],
  ])("rejects an unexpected response (%s)", async (_name, data) => {
    const { repo } = repoReturning({ data, error: null });
    await expect(repo.processEvent({ event: PAYMENT, payload: {} })).rejects.toMatchObject({
      name: "RepositoryError",
      code: UNEXPECTED_SHAPE,
    });
  });

  it("an RPC error becomes a RepositoryError with only the code", async () => {
    const { repo } = repoReturning({ data: null, error: { code: "22P05" } });
    const err = await repo.processEvent({ event: PAYMENT, payload: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepositoryError);
    expect(err).toMatchObject({ code: "22P05", message: "process_onboarding_event failed" });
  });
});

describe("SupabaseCreatorRepository.claimStuckCreators", () => {
  it(`asks for creators stuck ${STUCK_AFTER_HOURS}h+ and maps rows`, async () => {
    const { repo, rpc } = repoReturning({
      data: [
        { id: CREATOR_ID, name: "Ana", handle: "@ana", status: "signed_up", last_step_at: "2026-11-16T10:00:00+00:00" },
        { id: CREATOR_ID.toUpperCase(), name: "Bo", handle: null, status: "app_installed", last_step_at: "2026-11-16T11:00:00+00:00" },
      ],
      error: null,
    });
    await expect(repo.claimStuckCreators()).resolves.toEqual([
      { id: CREATOR_ID, name: "Ana", handle: "@ana", status: "signed_up", lastStepAt: new Date("2026-11-16T10:00:00Z") },
      { id: CREATOR_ID.toUpperCase(), name: "Bo", handle: null, status: "app_installed", lastStepAt: new Date("2026-11-16T11:00:00Z") },
    ]);
    expect(rpc).toHaveBeenCalledWith("claim_stuck_creators", { p_min_hours: STUCK_AFTER_HOURS });
  });

  it("an empty result is an empty list", async () => {
    const { repo } = repoReturning({ data: [], error: null });
    await expect(repo.claimStuckCreators()).resolves.toEqual([]);
  });

  it.each([
    ["a live creator", [{ id: CREATOR_ID, name: "A", handle: null, status: "live", last_step_at: "2026-11-16T10:00:00Z" }]],
    ["not an array", { id: CREATOR_ID }],
    ["null", null],
  ])("rejects an unexpected response (%s)", async (_name, data) => {
    const { repo } = repoReturning({ data, error: null });
    await expect(repo.claimStuckCreators()).rejects.toMatchObject({ name: "RepositoryError", code: UNEXPECTED_SHAPE });
  });

  it("an RPC error becomes a RepositoryError", async () => {
    const { repo } = repoReturning({ data: null, error: { code: "42501" } });
    await expect(repo.claimStuckCreators()).rejects.toMatchObject({ name: "RepositoryError", code: "42501" });
  });
});

describe("createSupabaseCreatorRepository", () => {
  const ENV = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
    WEBHOOK_SECRET: "w".repeat(32),
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/TEST/TEST/test",
    CRON_SECRET: "c".repeat(32),
  };

  beforeAll(() => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("creates a session-less service-role client", () => {
    createSupabaseCreatorRepository();
    expect(supabaseMock.createClient).toHaveBeenCalledWith(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  });

  it("keeps only the error code: message, details and hint never leave", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "x" Key (lower(email))=(ana@example.com)',
        details: "Error: stack trace at ...",
        hint: "ana@example.com",
      },
    });
    const err = await createSupabaseCreatorRepository().claimStuckCreators().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepositoryError);
    expect(err).toMatchObject({ code: "23505" });
    expect(JSON.stringify(err) + String(err)).not.toContain("ana@example.com");
    expect(String(err)).not.toContain("stack trace");
  });

  it("passes data through on success", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(createSupabaseCreatorRepository().claimStuckCreators()).resolves.toEqual([]);
    expect(supabaseMock.rpc).toHaveBeenLastCalledWith("claim_stuck_creators", { p_min_hours: STUCK_AFTER_HOURS });
  });
});
