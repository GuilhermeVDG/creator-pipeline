import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError, loadEnv } from "@/src/lib/env";

const VALID = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  WEBHOOK_SECRET: "w".repeat(32),
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/TEST/TEST/test",
  CRON_SECRET: "c".repeat(16),
};

function errorOf(source: Record<string, string | undefined>): EnvError {
  try {
    loadEnv(source);
  } catch (e) {
    if (e instanceof EnvError) return e;
    throw e;
  }
  throw new Error("expected loadEnv to throw");
}

describe("loadEnv", () => {
  it.each(Object.keys(VALID))("missing %s fails and names it", (key) => {
    const source: Record<string, string | undefined> = { ...VALID, [key]: undefined };
    expect(errorOf(source).message).toContain(`${key} (missing)`);
  });

  it("an empty value counts as missing", () => {
    expect(errorOf({ ...VALID, WEBHOOK_SECRET: "" }).message).toContain("WEBHOOK_SECRET (missing)");
  });

  it("lists every problem at once", () => {
    const message = errorOf({}).message;
    for (const key of Object.keys(VALID)) expect(message).toContain(key);
  });

  it("WEBHOOK_SECRET shorter than 32 characters fails", () => {
    expect(errorOf({ ...VALID, WEBHOOK_SECRET: "w".repeat(31) }).message).toContain("WEBHOOK_SECRET (too_small)");
  });

  it("CRON_SECRET shorter than 16 characters fails", () => {
    expect(errorOf({ ...VALID, CRON_SECRET: "c".repeat(15) }).message).toContain("CRON_SECRET (too_small)");
  });

  it.each([
    ["SUPABASE_URL", "http://example.supabase.co"],
    ["SUPABASE_URL", "not a url"],
    ["SUPABASE_URL", "https:example"],
    ["SLACK_WEBHOOK_URL", "http://hooks.slack.com/services/x"],
  ])("%s must be an https URL with a host (%s)", (key, value) => {
    expect(errorOf({ ...VALID, [key]: value }).message).toContain(`${key} (invalid_format)`);
  });

  it.each(["WEBHOOK_SECRET", "CRON_SECRET", "SUPABASE_SERVICE_ROLE_KEY"])(
    "%s with surrounding whitespace fails instead of being trimmed",
    (key) => {
      const value = `${VALID[key as keyof typeof VALID]}\n`;
      expect(errorOf({ ...VALID, [key]: value }).message).toContain(`${key} (custom)`);
      expect(errorOf({ ...VALID, [key]: ` ${value.trim()}` }).message).toContain(`${key} (custom)`);
    },
  );

  it("32 spaces is not a valid WEBHOOK_SECRET", () => {
    expect(errorOf({ ...VALID, WEBHOOK_SECRET: " ".repeat(32) }).message).toContain("WEBHOOK_SECRET (custom)");
  });

  it("never includes values in the error", () => {
    const secretish = "short-but-sensitive-value";
    const message = errorOf({
      ...VALID,
      WEBHOOK_SECRET: secretish,
      CRON_SECRET: secretish,
      SLACK_WEBHOOK_URL: "http://hooks.slack.com/services/SECRETPATH",
    }).message;
    expect(message).toContain("SLACK_WEBHOOK_URL (invalid_format)");
    expect(message).not.toContain(secretish);
    expect(message).not.toContain("SECRETPATH");
  });

  it("returns the validated values, frozen", () => {
    const env = loadEnv({ ...VALID, UNRELATED: "x" });
    expect(env).toEqual(VALID);
    expect(Object.isFrozen(env)).toBe(true);
  });
});

describe("getEnv (lazy)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function stubAll(values: Record<string, string>) {
    for (const key of Object.keys(VALID)) vi.stubEnv(key, values[key] ?? "");
  }

  it("importing the module with no env does not throw", async () => {
    stubAll({});
    vi.resetModules();
    await expect(import("@/src/lib/env")).resolves.toBeDefined();
  });

  it("throws on first use when env is invalid", async () => {
    stubAll({});
    vi.resetModules();
    const { getEnv, EnvError: FreshEnvError } = await import("@/src/lib/env");
    expect(() => getEnv()).toThrow(FreshEnvError);
  });

  it("caches the first successful result", async () => {
    stubAll(VALID);
    vi.resetModules();
    const { getEnv } = await import("@/src/lib/env");
    const first = getEnv();
    vi.stubEnv("CRON_SECRET", "changed-after-first-use");
    expect(getEnv()).toBe(first);
  });

  it("does not cache a failure: fixing the env makes the next call succeed", async () => {
    stubAll({});
    vi.resetModules();
    const { getEnv } = await import("@/src/lib/env");
    expect(() => getEnv()).toThrow();
    stubAll(VALID);
    expect(getEnv().CRON_SECRET).toBe(VALID.CRON_SECRET);
  });
});

describe(".env.example", () => {
  it("lists every required variable", () => {
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    for (const key of Object.keys(VALID)) expect(example).toMatch(new RegExp(`^${key}=`, "m"));
  });
});
