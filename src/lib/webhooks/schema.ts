// zod schema for the onboarding webhook body (spec section 1).
// Validates at the boundary and maps to a camelCase domain type.
import { z } from "zod";
import { STEPS, type Step } from "@/src/lib/creators/transitions";

/** occurred_at may be at most this far in the future. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

// Derived from STEPS, so a new step can't be silently rejected here.
const UPDATE_STEPS = STEPS.filter((s): s is Exclude<Step, "signup"> => s !== "signup");

/**
 * Postgres `text` rejects NUL, and `jsonb` also rejects unpaired surrogates.
 * Rejecting them here makes them a 400 instead of a failed insert (500).
 */
function storable(s: string): boolean {
  return !s.includes("\u0000") && s.isWellFormed();
}
const STORABLE = { message: "unsupported characters" } as const;

// Not trimmed: the idempotency key is stored exactly as sent.
const eventId = z.string().min(1).max(255).refine(storable, STORABLE);
// Any 8-4-4-4-12 hex id, as Postgres `uuid` accepts. Lowercased so TS-side
// comparisons (in-memory repo, logs) agree with Postgres, which ignores case.
const creatorId = z.guid().transform((s) => s.toLowerCase());
const occurredAt = z.iso.datetime({ offset: true });

const signupCreator = z.object({
  id: creatorId,
  name: z.string().trim().min(1).max(200).refine(storable, STORABLE),
  // Light check on purpose: a rejected signup leaves the creator's later events
  // pending forever, and the upstream flow already validated the address.
  // Stored as sent (trimmed); uniqueness is case-insensitive in the database.
  email: z
    .string()
    .trim()
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+$/)
    .refine(storable, STORABLE),
  handle: z.string().trim().min(1).max(100).refine(storable, STORABLE),
});

// Unknown keys are stripped (zod default), so a sender adding fields doesn't break us.
const payloadSchema = z.discriminatedUnion("step", [
  z.object({
    event_id: eventId,
    step: z.literal("signup"),
    occurred_at: occurredAt,
    creator: signupCreator,
  }),
  z.object({
    event_id: eventId,
    step: z.literal(UPDATE_STEPS),
    occurred_at: occurredAt,
    creator: z.object({ id: creatorId }),
  }),
]);

export type CreatorProfile = {
  name: string;
  email: string;
  handle: string;
};

type EventBase = {
  eventId: string;
  occurredAt: Date;
  creatorId: string;
};

export type SignupEvent = EventBase & { step: "signup"; profile: CreatorProfile };
export type StepUpdateEvent = EventBase & { step: Exclude<Step, "signup"> };
export type OnboardingEvent = SignupEvent | StepUpdateEvent;

export type ParseResult =
  | { ok: true; event: OnboardingEvent }
  /** `issues` are field paths and issue codes only, never input values: safe to log. */
  | { ok: false; issues: string[] };

export function parseOnboardingEvent(json: unknown, now: Date): ParseResult {
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`),
    };
  }

  const p = parsed.data;
  const when = new Date(p.occurred_at);
  if (!Number.isFinite(now.getTime())) {
    return { ok: false, issues: ["now: invalid_date"] };
  }
  if (!Number.isFinite(when.getTime())) {
    return { ok: false, issues: ["occurred_at: invalid_date"] };
  }
  if (when.getTime() - now.getTime() > MAX_FUTURE_SKEW_MS) {
    return { ok: false, issues: ["occurred_at: too_far_in_future"] };
  }

  const base: EventBase = { eventId: p.event_id, occurredAt: when, creatorId: p.creator.id };
  const event: OnboardingEvent =
    p.step === "signup"
      ? {
          ...base,
          step: "signup",
          profile: { name: p.creator.name, email: p.creator.email, handle: p.creator.handle },
        }
      : { ...base, step: p.step };
  return { ok: true, event };
}
