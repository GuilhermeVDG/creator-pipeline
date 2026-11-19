// Creator persistence (spec sections 2, 3.1 and 4).
// - `CreatorRepository`: what route handlers depend on.
// - `InMemoryCreatorRepository`: a fake with the same semantics as the SQL
//   function `process_onboarding_event`, used by tests and checked against
//   the shared transition table.
// - The Supabase implementation comes with the migration (step 7).
// Server only: the Supabase implementation holds the service role key.
import "server-only";
import { nextState, reconcile, type Status, type StepEvent } from "@/src/lib/creators/transitions";
import type { OnboardingEvent } from "@/src/lib/webhooks/schema";

/** Data for the Slack "live" message. */
export type LiveCreator = {
  name: string;
  handle: string | null;
  onboardingStartedAt: Date;
  /** occurred_at of the event that made the creator live */
  liveAt: Date;
};

export type ProcessResult =
  | { result: "duplicate" }
  | { result: "pending" }
  | { result: "email_conflict" }
  | { result: "processed"; becameLive: false }
  | { result: "processed"; becameLive: true; creator: LiveCreator };

/** What JSON.parse can return, and what jsonb can store faithfully. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type ProcessEventInput = {
  event: OnboardingEvent;
  /**
   * The parsed request body (JSON.parse output), stored in
   * webhook_events.payload. Not the raw bytes: jsonb drops key order and
   * whitespace either way.
   */
  payload: JsonValue;
};

export type ClaimedStuckCreator = {
  id: string;
  name: string;
  handle: string | null;
  status: Exclude<Status, "live">;
  lastStepAt: Date;
};

/** Creators are stuck after this many hours on the same step. */
export const STUCK_AFTER_HOURS = 48;

export interface CreatorRepository {
  /** Records the event and applies the transition atomically (spec 3.1). */
  processEvent(input: ProcessEventInput): Promise<ProcessResult>;
  /**
   * Atomically finds creators stuck for STUCK_AFTER_HOURS+ that haven't been
   * alerted for their current step, marks them alerted, and returns them.
   */
  claimStuckCreators(): Promise<ClaimedStuckCreator[]>;
}

// ---------------------------------------------------------------------------
// In-memory fake

export type CreatorRow = {
  id: string;
  name: string;
  email: string;
  handle: string | null;
  status: Status;
  lastStepAt: Date;
  stuckAlertSentAt: Date | null;
  onboardingStartedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type EventRow = {
  eventId: string;
  creatorId: string;
  step: OnboardingEvent["step"];
  occurredAt: Date;
  payload: JsonValue;
  receivedAt: Date;
};

const HOUR_MS = 3_600_000;

/**
 * Each method runs synchronously between awaits, so it is atomic the same way
 * the SQL function is under its per-creator lock. Rows, Dates and payloads are
 * copied on the way in and out, so callers can't mutate stored state.
 */
export class InMemoryCreatorRepository implements CreatorRepository {
  private readonly creators = new Map<string, CreatorRow>();
  private readonly events = new Map<string, EventRow>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async processEvent({ event, payload }: ProcessEventInput): Promise<ProcessResult> {
    // 1. Idempotency: the event_id primary key.
    if (this.events.has(event.eventId)) return { result: "duplicate" };

    const now = this.now();
    const eventRow: EventRow = {
      eventId: event.eventId,
      creatorId: event.creatorId,
      step: event.step,
      occurredAt: copyDate(event.occurredAt),
      payload: structuredClone(payload),
      receivedAt: now,
    };
    const current = this.creators.get(event.creatorId);

    if (current === undefined) {
      // 3. Non-signup for a creator that doesn't exist yet: store it, pending.
      if (event.step !== "signup") {
        this.events.set(event.eventId, eventRow);
        return { result: "pending" };
      }

      // 2. Signup creates the creator. Unique index on lower(email): a conflict
      // rolls back everything, so the event is not recorded either.
      // Postgres lower() is the source of truth for uniqueness. JS toLowerCase()
      // only matches it for ASCII; non-ASCII case variants (e.g. U+0130) can
      // differ by collation and are checked by the opt-in integration test.
      const email = event.profile.email;
      const taken = [...this.creators.values()].some((c) => c.email.toLowerCase() === email.toLowerCase());
      if (taken) return { result: "email_conflict" };

      const stored: StepEvent[] = [...this.events.values()]
        .filter((e) => e.creatorId === event.creatorId)
        .map((e) => ({ step: e.step, occurredAt: e.occurredAt }));
      const initial = reconcile([{ step: "signup", occurredAt: event.occurredAt }, ...stored]);
      const row: CreatorRow = {
        id: event.creatorId,
        name: event.profile.name,
        email,
        handle: event.profile.handle,
        status: initial.status,
        lastStepAt: initial.lastStepAt,
        stuckAlertSentAt: null,
        onboardingStartedAt: event.occurredAt,
        createdAt: now,
        updatedAt: now,
      };
      this.events.set(event.eventId, eventRow);
      this.creators.set(row.id, copyCreator(row));
      return initial.becameLive
        ? { result: "processed", becameLive: true, creator: liveCreator(row, initial.lastStepAt) }
        : { result: "processed", becameLive: false };
    }

    // 4. Existing creator: status change (a), else time correction (b), and for
    // signup the onboarding start correction (c). Name, email, handle never change.
    this.events.set(event.eventId, eventRow);
    const t = nextState(current, { step: event.step, occurredAt: event.occurredAt });
    const next: CreatorRow = { ...current };
    if (t.changed) {
      next.status = t.status;
      next.lastStepAt = t.lastStepAt;
      next.stuckAlertSentAt = null;
      next.updatedAt = now;
    } else if (t.lastStepAt.getTime() !== current.lastStepAt.getTime()) {
      next.lastStepAt = t.lastStepAt;
      next.updatedAt = now;
    }
    if (event.step === "signup" && event.occurredAt < current.onboardingStartedAt) {
      next.onboardingStartedAt = event.occurredAt;
      next.updatedAt = now;
    }
    this.creators.set(next.id, copyCreator(next));

    return t.becameLive
      ? { result: "processed", becameLive: true, creator: liveCreator(next, event.occurredAt) }
      : { result: "processed", becameLive: false };
  }

  async claimStuckCreators(): Promise<ClaimedStuckCreator[]> {
    const now = this.now();
    const cutoff = now.getTime() - STUCK_AFTER_HOURS * HOUR_MS;
    const claimed: ClaimedStuckCreator[] = [];
    for (const c of this.creators.values()) {
      if (c.status === "live" || c.stuckAlertSentAt !== null || !(c.lastStepAt.getTime() < cutoff)) continue;
      this.creators.set(c.id, copyCreator({ ...c, stuckAlertSentAt: now }));
      claimed.push({ id: c.id, name: c.name, handle: c.handle, status: c.status, lastStepAt: copyDate(c.lastStepAt) });
    }
    return claimed;
  }

  // --- Test helpers (not part of CreatorRepository) ---

  getCreator(id: string): CreatorRow | undefined {
    const row = this.creators.get(id);
    return row === undefined ? undefined : copyCreator(row);
  }

  getEvents(): EventRow[] {
    return [...this.events.values()].map((e) => ({
      ...e,
      occurredAt: copyDate(e.occurredAt),
      receivedAt: copyDate(e.receivedAt),
      payload: structuredClone(e.payload),
    }));
  }

  /** Sets stuck_alert_sent_at directly, e.g. to check that a step resets it. */
  setStuckAlertSentAt(id: string, at: Date | null): void {
    const row = this.creators.get(id);
    if (row === undefined) throw new Error(`no creator ${id}`);
    this.creators.set(id, copyCreator({ ...row, stuckAlertSentAt: at }));
  }
}

function liveCreator(row: CreatorRow, liveAt: Date): LiveCreator {
  return {
    name: row.name,
    handle: row.handle,
    onboardingStartedAt: copyDate(row.onboardingStartedAt),
    liveAt: copyDate(liveAt),
  };
}

function copyDate(d: Date): Date {
  return new Date(d.getTime());
}

function copyCreator(row: CreatorRow): CreatorRow {
  return {
    ...row,
    lastStepAt: copyDate(row.lastStepAt),
    stuckAlertSentAt: row.stuckAlertSentAt === null ? null : copyDate(row.stuckAlertSentAt),
    onboardingStartedAt: copyDate(row.onboardingStartedAt),
    createdAt: copyDate(row.createdAt),
    updatedAt: copyDate(row.updatedAt),
  };
}
