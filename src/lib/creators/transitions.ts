// Pure status logic. No I/O. The same rules are mirrored in SQL
// (process_onboarding_event); tests/fixtures/transition-cases.ts keeps them in sync.

export const STEPS = ["signup", "app_installed", "payment_done"] as const;
export type Step = (typeof STEPS)[number];

export const STATUSES = ["signed_up", "app_installed", "live"] as const;
export type Status = (typeof STATUSES)[number];

export const STEP_STATUS: Readonly<Record<Step, Status>> = {
  signup: "signed_up",
  app_installed: "app_installed",
  payment_done: "live",
};

export const STATUS_RANK: Readonly<Record<Status, 1 | 2 | 3>> = {
  signed_up: 1,
  app_installed: 2,
  live: 3,
};

function stepRank(step: Step): 1 | 2 | 3 {
  return STATUS_RANK[STEP_STATUS[step]];
}

export type StepEvent = {
  step: Step;
  occurredAt: Date;
};

export type CreatorState = {
  status: Status;
  /** Earliest occurred_at among recorded events for the current status. */
  lastStepAt: Date;
};

export type Transition = {
  /** The status changed (resets stuck_alert_sent_at). */
  changed: boolean;
  status: Status;
  lastStepAt: Date;
  becameLive: boolean;
};

/**
 * Higher rank: status changes and lastStepAt = occurredAt.
 * Equal rank with an earlier occurredAt: lastStepAt moves back, status unchanged.
 * Anything else: no change.
 */
export function nextState(current: CreatorState, event: StepEvent): Transition {
  const target = STEP_STATUS[event.step];
  const rank = STATUS_RANK[target];
  const currentRank = STATUS_RANK[current.status];

  if (rank > currentRank) {
    return {
      changed: true,
      status: target,
      lastStepAt: event.occurredAt,
      becameLive: target === "live",
    };
  }
  const earlier = event.occurredAt.getTime() < current.lastStepAt.getTime();
  return {
    changed: false,
    status: current.status,
    lastStepAt: rank === currentRank && earlier ? event.occurredAt : current.lastStepAt,
    becameLive: false,
  };
}

export type Reconciled = {
  status: Status;
  lastStepAt: Date;
  becameLive: boolean;
};

/**
 * Initial state for a creator created by `signup`. Pass every event stored for
 * that creator (pending ones plus the signup itself, which must be included).
 * Ordered by rank desc, occurredAt asc; the first one wins.
 */
export function reconcile(events: readonly [StepEvent, ...StepEvent[]]): Reconciled {
  if (!events.some((e) => e.step === "signup")) {
    throw new Error("reconcile requires the signup event");
  }
  let best = events[0];
  for (const event of events) {
    const rank = stepRank(event.step);
    const bestRank = stepRank(best.step);
    if (
      rank > bestRank ||
      (rank === bestRank && event.occurredAt.getTime() < best.occurredAt.getTime())
    ) {
      best = event;
    }
  }
  const status = STEP_STATUS[best.step];
  return { status, lastStepAt: best.occurredAt, becameLive: status === "live" };
}
