// Shared transition cases. Each case is a sequence of events for one creator,
// in arrival order, applied to an empty store. The same table runs against the
// pure functions now, the in-memory repository (step 6) and the SQL function
// process_onboarding_event (step 10), so it records the expected result of
// every call, not only the final state.
import type { Status, Step } from "@/src/lib/creators/transitions";

export const BASE_TIME = new Date("2026-11-01T00:00:00Z");

/** `occurred_at` as minutes after BASE_TIME. */
export function at(minutes: number): Date {
  return new Date(BASE_TIME.getTime() + minutes * 60_000);
}

export type EventResult = "processed" | "pending" | "duplicate";

export type EventExpectation = {
  result: EventResult;
  /**
   * The creator was created or its status changed by this event. Runners
   * check that stuck_alert_sent_at is reset only when this is true.
   */
  statusChanged: boolean;
  becameLive: boolean;
};

export type CaseEvent = {
  step: Step;
  /** occurred_at, minutes after BASE_TIME */
  at: number;
  /** Set only to reuse an id (duplicates). Runners default to `eventIdFor`. */
  eventId?: string;
  expect: EventExpectation;
};

export type TransitionCase = {
  name: string;
  events: readonly CaseEvent[];
  expected: {
    /** null: the creator doesn't exist (only pending events) */
    status: Status | null;
    /** minutes after BASE_TIME, null when the creator doesn't exist */
    lastStepAt: number | null;
    /** minutes after BASE_TIME, null when the creator doesn't exist */
    onboardingStartedAt: number | null;
    /** how many times the creator became live (Slack "live" messages) */
    liveMessages: number;
  };
};

/** Event id a runner should send for the event at `index`. */
export function eventIdFor(event: CaseEvent, index: number): string {
  return event.eventId ?? `evt_${index}`;
}

type Opts = { statusChanged?: boolean; becameLive?: boolean; eventId?: string };

function e(step: Step, minutes: number, result: EventResult = "processed", opts: Opts = {}): CaseEvent {
  return {
    step,
    at: minutes,
    ...(opts.eventId === undefined ? {} : { eventId: opts.eventId }),
    expect: {
      result,
      statusChanged: opts.statusChanged ?? false,
      becameLive: opts.becameLive ?? false,
    },
  };
}

/** Creator created, or status changed. */
const CHANGED = { statusChanged: true } as const;
/** Status changed to live. */
const LIVE = { statusChanged: true, becameLive: true } as const;

export const TRANSITION_CASES: readonly TransitionCase[] = [
  // Pending events, reconciled when signup arrives
  {
    name: "payment_done before signup: signup reconciles to live",
    events: [e("payment_done", 30, "pending"), e("signup", 0, "processed", LIVE)],
    expected: { status: "live", lastStepAt: 30, onboardingStartedAt: 0, liveMessages: 1 },
  },
  {
    name: "pending payment_done earlier than signup: lastStepAt before signup",
    events: [e("payment_done", -5, "pending"), e("signup", 0, "processed", LIVE)],
    expected: { status: "live", lastStepAt: -5, onboardingStartedAt: 0, liveMessages: 1 },
  },
  {
    name: "app_installed before signup: signup reconciles to app_installed",
    events: [e("app_installed", 10, "pending"), e("signup", 0, "processed", CHANGED)],
    expected: { status: "app_installed", lastStepAt: 10, onboardingStartedAt: 0, liveMessages: 0 },
  },
  {
    name: "app_installed and payment_done before signup: live once",
    events: [
      e("app_installed", 10, "pending"),
      e("payment_done", 20, "pending"),
      e("signup", 0, "processed", LIVE),
    ],
    expected: { status: "live", lastStepAt: 20, onboardingStartedAt: 0, liveMessages: 1 },
  },
  {
    name: "two pending app_installed: earliest time wins",
    events: [
      e("app_installed", 15, "pending"),
      e("app_installed", 10, "pending"),
      e("signup", 0, "processed", CHANGED),
    ],
    expected: { status: "app_installed", lastStepAt: 10, onboardingStartedAt: 0, liveMessages: 0 },
  },

  // Equal rank after signup: lastStepAt is the earliest time for the current status
  {
    name: "equal rank with an earlier time moves lastStepAt back, no status change",
    events: [e("signup", 0, "processed", CHANGED), e("app_installed", 15, "processed", CHANGED), e("app_installed", 10)],
    expected: { status: "app_installed", lastStepAt: 10, onboardingStartedAt: 0, liveMessages: 0 },
  },
  {
    name: "equal rank with a later time leaves lastStepAt",
    events: [e("signup", 0, "processed", CHANGED), e("app_installed", 10, "processed", CHANGED), e("app_installed", 15)],
    expected: { status: "app_installed", lastStepAt: 10, onboardingStartedAt: 0, liveMessages: 0 },
  },
  {
    name: "earlier payment_done while live moves lastStepAt back, no second live message",
    events: [e("signup", 0, "processed", CHANGED), e("payment_done", 25, "processed", LIVE), e("payment_done", 20)],
    expected: { status: "live", lastStepAt: 20, onboardingStartedAt: 0, liveMessages: 1 },
  },
  {
    name: "later payment_done while live changes nothing",
    events: [
      e("signup", 0, "processed", CHANGED),
      e("app_installed", 10, "processed", CHANGED),
      e("payment_done", 20, "processed", LIVE),
      e("payment_done", 25),
    ],
    expected: { status: "live", lastStepAt: 20, onboardingStartedAt: 0, liveMessages: 1 },
  },
  {
    name: "lower-rank event with an earlier time after a status change moves nothing",
    events: [e("signup", 0, "processed", CHANGED), e("app_installed", 10, "processed", CHANGED), e("signup", -5)],
    // signup@-5 is lower rank: lastStepAt stays; it still moves onboardingStartedAt back.
    expected: { status: "app_installed", lastStepAt: 10, onboardingStartedAt: -5, liveMessages: 0 },
  },

  // Resent signup: onboardingStartedAt earliest wins, lastStepAt only while signed_up
  {
    name: "signup resent earlier while signed_up moves onboardingStartedAt and lastStepAt back",
    events: [e("signup", 5, "processed", CHANGED), e("signup", 0)],
    expected: { status: "signed_up", lastStepAt: 0, onboardingStartedAt: 0, liveMessages: 0 },
  },
  {
    name: "signup resent earlier while live moves only onboardingStartedAt back",
    events: [e("signup", 0, "processed", CHANGED), e("payment_done", 20, "processed", LIVE), e("signup", -10)],
    expected: { status: "live", lastStepAt: 20, onboardingStartedAt: -10, liveMessages: 1 },
  },
  {
    name: "signup resent later leaves the creator unchanged",
    events: [e("signup", 0, "processed", CHANGED), e("signup", 5)],
    expected: { status: "signed_up", lastStepAt: 0, onboardingStartedAt: 0, liveMessages: 0 },
  },

  // Ordering and duplicates
  {
    name: "app_installed after payment_done does not move status back",
    events: [e("signup", 0, "processed", CHANGED), e("payment_done", 20, "processed", LIVE), e("app_installed", 10)],
    expected: { status: "live", lastStepAt: 20, onboardingStartedAt: 0, liveMessages: 1 },
  },
  {
    name: "same event_id twice: duplicate, no second live message",
    events: [
      e("signup", 0, "processed", CHANGED),
      e("payment_done", 20, "processed", { ...LIVE, eventId: "evt_pay" }),
      e("payment_done", 20, "duplicate", { eventId: "evt_pay" }),
    ],
    expected: { status: "live", lastStepAt: 20, onboardingStartedAt: 0, liveMessages: 1 },
  },

  // Happy paths
  {
    name: "skipping app_installed goes straight to live",
    events: [e("signup", 0, "processed", CHANGED), e("payment_done", 20, "processed", LIVE)],
    expected: { status: "live", lastStepAt: 20, onboardingStartedAt: 0, liveMessages: 1 },
  },
  {
    name: "full flow ends live with one live message",
    events: [
      e("signup", 0, "processed", CHANGED),
      e("app_installed", 10, "processed", CHANGED),
      e("payment_done", 20, "processed", LIVE),
    ],
    expected: { status: "live", lastStepAt: 20, onboardingStartedAt: 0, liveMessages: 1 },
  },
  {
    name: "app_installed only: creator doesn't exist yet",
    events: [e("app_installed", 10, "pending")],
    expected: { status: null, lastStepAt: null, onboardingStartedAt: null, liveMessages: 0 },
  },
  {
    name: "signup only creates signed_up",
    events: [e("signup", 0, "processed", CHANGED)],
    expected: { status: "signed_up", lastStepAt: 0, onboardingStartedAt: 0, liveMessages: 0 },
  },
];
