import { describe, expect, it } from "vitest";
import { MAX_FUTURE_SKEW_MS, parseOnboardingEvent } from "@/src/lib/webhooks/schema";

const NOW = new Date("2026-11-18T18:00:00Z");
const CREATOR_ID = "8f0c2c1e-0b8a-4a4e-9f61-2f1f6c1e2a10";

function signup(overrides: Record<string, unknown> = {}, creator: Record<string, unknown> = {}) {
  return {
    event_id: "evt_01",
    step: "signup",
    occurred_at: "2026-11-18T17:00:00Z",
    creator: { id: CREATOR_ID, name: "Ana Souza", email: "ana@example.com", handle: "@anasouza", ...creator },
    ...overrides,
  };
}

function update(step: string, overrides: Record<string, unknown> = {}) {
  return { event_id: "evt_02", step, occurred_at: "2026-11-18T17:30:00Z", creator: { id: CREATOR_ID }, ...overrides };
}

const iso = (ms: number) => new Date(ms).toISOString();

function issuesOf(json: unknown, now = NOW): string[] {
  const result = parseOnboardingEvent(json, now);
  if (result.ok) throw new Error("expected a validation failure");
  return result.issues;
}

describe("parseOnboardingEvent: signup fields", () => {
  it.each(["name", "email", "handle"])("signup without %s is invalid", (field) => {
    const body = signup();
    delete (body.creator as Record<string, unknown>)[field];
    expect(issuesOf(body)).toContainEqual(expect.stringContaining(`creator.${field}`));
  });

  it.each([
    ["blank name", { name: "   " }, "creator.name"],
    ["bad email", { email: "not-an-email" }, "creator.email"],
    ["empty handle", { handle: "" }, "creator.handle"],
    ["name not a string", { name: 42 }, "creator.name"],
    ["NUL in name", { name: "Ana\u0000" }, "creator.name"],
    ["NUL in handle", { handle: "@a\u0000" }, "creator.handle"],
    ["lone surrogate in name", { name: "Ana \uD800" }, "creator.name"],
  ])("signup with %s is invalid", (_name, creator, path) => {
    expect(issuesOf(signup({}, creator))).toContainEqual(expect.stringContaining(path));
  });

  it.each([
    ["no @", "ana.example.com"],
    ["two @", "ana@@example.com"],
    ["empty local part", "@example.com"],
    ["empty domain", "ana@"],
    ["space inside", "ana souza@example.com"],
    ["too long", `${"a".repeat(310)}@example.com`],
  ])("email with %s is invalid", (_name, email) => {
    expect(issuesOf(signup({}, { email }))).toContainEqual(expect.stringContaining("creator.email"));
  });

  it.each([
    ["non-ASCII local part", "jos\u00e9@example.com"],
    ["single-label domain", "ana@localhost"],
    ["plus tag", "ana+test@example.com"],
  ])("email with %s is valid", (_name, email) => {
    expect(parseOnboardingEvent(signup({}, { email }), NOW).ok).toBe(true);
  });

  it("email is trimmed but its case is kept", () => {
    const result = parseOnboardingEvent(signup({}, { email: "  Ana@Example.COM " }), NOW);
    expect(result.ok && result.event.step === "signup" && result.event.profile.email).toBe("Ana@Example.COM");
  });

  it("a valid surrogate pair (emoji) in name is fine", () => {
    expect(parseOnboardingEvent(signup({}, { name: "Ana \u{1F680}" }), NOW).ok).toBe(true);
  });

  it("app_installed without name, email or handle is valid", () => {
    expect(parseOnboardingEvent(update("app_installed"), NOW).ok).toBe(true);
  });
});

describe("parseOnboardingEvent: structure", () => {
  it.each([
    ["null", null, "(root)"],
    ["array", [], "(root)"],
    ["string", "hello", "(root)"],
    ["empty object", {}, "step"],
    ["unknown step", update("payment_failed"), "step"],
    ["missing step", { ...update("app_installed"), step: undefined }, "step"],
    ["empty event_id", update("app_installed", { event_id: "" }), "event_id"],
    ["event_id too long", update("app_installed", { event_id: "e".repeat(256) }), "event_id"],
    ["event_id not a string", update("app_installed", { event_id: 123 }), "event_id"],
    ["NUL in event_id", update("app_installed", { event_id: "evt\u0000" }), "event_id"],
    ["lone surrogate in event_id", update("app_installed", { event_id: "evt\uDC00" }), "event_id"],
    ["creator missing", update("app_installed", { creator: undefined }), "creator"],
    ["creator id not a uuid", update("app_installed", { creator: { id: "creator-1" } }), "creator.id"],
    ["occurred_at date only", update("app_installed", { occurred_at: "2026-11-18" }), "occurred_at"],
    ["occurred_at without timezone", update("app_installed", { occurred_at: "2026-11-18T17:30:00" }), "occurred_at"],
    ["occurred_at impossible date", update("app_installed", { occurred_at: "2026-13-45T99:00:00Z" }), "occurred_at"],
    ["occurred_at as a number", update("app_installed", { occurred_at: 1763485800 }), "occurred_at"],
  ])("%s is invalid", (_name, json, path) => {
    expect(issuesOf(json)).toContainEqual(expect.stringMatching(new RegExp(`^${path.replace(/[.()]/g, "\\$&")}: `)));
  });

  it("creator id is lowercased", () => {
    const result = parseOnboardingEvent(update("app_installed", { creator: { id: CREATOR_ID.toUpperCase() } }), NOW);
    expect(result.ok && result.event.creatorId).toBe(CREATOR_ID);
  });

  it("issues contain paths and codes, never input values", () => {
    const issues = issuesOf(signup({}, { email: "secret pii@nowhere" }));
    expect(issues.join(" ")).not.toContain("secret-pii");
  });

  it("unknown fields are stripped, not rejected", () => {
    const result = parseOnboardingEvent(update("app_installed", { extra: true, creator: { id: CREATOR_ID, name: "x" } }), NOW);
    expect(result).toEqual({
      ok: true,
      event: {
        eventId: "evt_02",
        step: "app_installed",
        occurredAt: new Date("2026-11-18T17:30:00Z"),
        creatorId: CREATOR_ID,
      },
    });
  });

  it("event_id is kept exactly as sent", () => {
    const result = parseOnboardingEvent(update("app_installed", { event_id: " evt_02 " }), NOW);
    expect(result.ok && result.event.eventId).toBe(" evt_02 ");
  });
});

describe("parseOnboardingEvent: occurred_at in the future", () => {
  it("more than 5 minutes ahead is invalid", () => {
    const json = update("payment_done", { occurred_at: iso(NOW.getTime() + MAX_FUTURE_SKEW_MS + 1000) });
    expect(issuesOf(json)).toEqual(["occurred_at: too_far_in_future"]);
  });

  it("exactly 5 minutes ahead is valid", () => {
    const json = update("payment_done", { occurred_at: iso(NOW.getTime() + MAX_FUTURE_SKEW_MS) });
    expect(parseOnboardingEvent(json, NOW).ok).toBe(true);
  });

  it("a timezone offset is applied before comparing", () => {
    // 18:10+02:00 is 16:10Z, well in the past.
    expect(parseOnboardingEvent(update("payment_done", { occurred_at: "2026-11-18T18:10:00+02:00" }), NOW).ok).toBe(true);
    // 14:10-04:00 is 18:10Z, 10 minutes ahead.
    expect(parseOnboardingEvent(update("payment_done", { occurred_at: "2026-11-18T14:10:00-04:00" }), NOW).ok).toBe(false);
  });

  it("dates far in the past are valid", () => {
    expect(parseOnboardingEvent(update("payment_done", { occurred_at: "2020-01-01T00:00:00Z" }), NOW).ok).toBe(true);
  });

  it("fails closed when now is an invalid date", () => {
    expect(issuesOf(update("payment_done"), new Date(NaN))).toEqual(["now: invalid_date"]);
  });
});

describe("parseOnboardingEvent: mapping", () => {
  it("maps a signup to the domain type", () => {
    expect(parseOnboardingEvent(signup(), NOW)).toEqual({
      ok: true,
      event: {
        eventId: "evt_01",
        step: "signup",
        occurredAt: new Date("2026-11-18T17:00:00Z"),
        creatorId: CREATOR_ID,
        profile: { name: "Ana Souza", email: "ana@example.com", handle: "@anasouza" },
      },
    });
  });

  it("trims name and handle", () => {
    const result = parseOnboardingEvent(signup({}, { name: "  Ana  ", handle: " @ana " }), NOW);
    expect(result.ok && result.event.step === "signup" && result.event.profile).toEqual({
      name: "Ana",
      email: "ana@example.com",
      handle: "@ana",
    });
  });

  it("accepts the spec example body", () => {
    const body = {
      event_id: "evt_01J9ZK3",
      step: "signup",
      occurred_at: "2026-11-18T18:00:00Z",
      creator: { id: CREATOR_ID, name: "Ana Souza", email: "ana@example.com", handle: "@anasouza" },
    };
    expect(parseOnboardingEvent(body, NOW).ok).toBe(true);
  });
});
