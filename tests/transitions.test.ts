import { describe, expect, it } from "vitest";
import {
  nextState,
  reconcile,
  type CreatorState,
  type Status,
  type Step,
  type StepEvent,
} from "@/src/lib/creators/transitions";
import {
  TRANSITION_CASES,
  at,
  eventIdFor,
  type CaseEvent,
  type EventResult,
} from "./fixtures/transition-cases";

describe("nextState: status matrix (event later than lastStepAt)", () => {
  const cases: ReadonlyArray<[Status, Step, Status, boolean, boolean]> = [
    // current,        step,            status,          changed, becameLive
    ["live", "signup", "live", false, false],
    ["live", "app_installed", "live", false, false],
    ["live", "payment_done", "live", false, false],
    ["app_installed", "signup", "app_installed", false, false],
    ["app_installed", "app_installed", "app_installed", false, false],
    ["app_installed", "payment_done", "live", true, true],
    ["signed_up", "signup", "signed_up", false, false],
    ["signed_up", "app_installed", "app_installed", true, false],
    ["signed_up", "payment_done", "live", true, true],
  ];

  it.each(cases)("%s + %s -> %s", (current, step, status, changed, becameLive) => {
    const result = nextState({ status: current, lastStepAt: at(0) }, { step, occurredAt: at(10) });
    expect(result).toEqual({
      status,
      changed,
      becameLive,
      lastStepAt: changed ? at(10) : at(0),
    });
  });
});

describe("nextState: lastStepAt", () => {
  const appInstalledAt15: CreatorState = { status: "app_installed", lastStepAt: at(15) };

  it("equal rank, earlier time: moves lastStepAt back without a status change", () => {
    expect(nextState(appInstalledAt15, { step: "app_installed", occurredAt: at(10) })).toEqual({
      changed: false,
      status: "app_installed",
      lastStepAt: at(10),
      becameLive: false,
    });
  });

  it("equal rank, same time: no change", () => {
    expect(nextState(appInstalledAt15, { step: "app_installed", occurredAt: at(15) })).toEqual({
      changed: false,
      status: "app_installed",
      lastStepAt: at(15),
      becameLive: false,
    });
  });

  it("lower rank, earlier time: no change", () => {
    expect(nextState(appInstalledAt15, { step: "signup", occurredAt: at(0) })).toEqual({
      changed: false,
      status: "app_installed",
      lastStepAt: at(15),
      becameLive: false,
    });
  });

  it("higher rank, earlier time: status changes and takes the event time", () => {
    expect(nextState(appInstalledAt15, { step: "payment_done", occurredAt: at(5) })).toEqual({
      changed: true,
      status: "live",
      lastStepAt: at(5),
      becameLive: true,
    });
  });
});

describe("reconcile", () => {
  it("rejects an empty list at compile time", () => {
    // Never called: only checks that the type forbids [].
    const typeCheckOnly = () => {
      // @ts-expect-error reconcile needs at least one event
      reconcile([]);
    };
    expect(typeCheckOnly).toBeTypeOf("function");
  });

  it("throws when the signup event is missing", () => {
    expect(() => reconcile([{ step: "payment_done", occurredAt: at(10) }])).toThrow();
  });

  it("a tie in rank keeps the earliest time", () => {
    const result = reconcile([
      { step: "app_installed", occurredAt: at(15) },
      { step: "app_installed", occurredAt: at(10) },
      { step: "signup", occurredAt: at(0) },
    ]);
    expect(result).toEqual({ status: "app_installed", lastStepAt: at(10), becameLive: false });
  });

  it("pending payment_done makes the new creator live", () => {
    const result = reconcile([
      { step: "payment_done", occurredAt: at(30) },
      { step: "signup", occurredAt: at(0) },
    ]);
    expect(result).toEqual({ status: "live", lastStepAt: at(30), becameLive: true });
  });

  it("a single signup gives signed_up at its time", () => {
    expect(reconcile([{ step: "signup", occurredAt: at(0) }])).toEqual({
      status: "signed_up",
      lastStepAt: at(0),
      becameLive: false,
    });
  });
});

/**
 * Reference model for the shared table, built only from the pure functions:
 * a repeated event id is a duplicate; a non-signup with no creator is stored
 * (pending); signup creates the creator via reconcile; otherwise nextState.
 */
function runSequence(events: readonly CaseEvent[]) {
  const seen = new Set<string>();
  const pending: StepEvent[] = [];
  let creator: CreatorState | null = null;
  const perEvent: Array<{ result: EventResult; becameLive: boolean }> = [];

  for (const [index, e] of events.entries()) {
    const id = eventIdFor(e, index);
    if (seen.has(id)) {
      perEvent.push({ result: "duplicate", becameLive: false });
      continue;
    }
    seen.add(id);
    const event: StepEvent = { step: e.step, occurredAt: at(e.at) };

    if (creator === null) {
      if (event.step !== "signup") {
        pending.push(event);
        perEvent.push({ result: "pending", becameLive: false });
        continue;
      }
      const r = reconcile([event, ...pending]);
      creator = { status: r.status, lastStepAt: r.lastStepAt };
      perEvent.push({ result: "processed", becameLive: r.becameLive });
      continue;
    }

    const t = nextState(creator, event);
    creator = { status: t.status, lastStepAt: t.lastStepAt };
    perEvent.push({ result: "processed", becameLive: t.becameLive });
  }

  return {
    perEvent,
    status: creator?.status ?? null,
    lastStepAt: creator?.lastStepAt ?? null,
    liveMessages: perEvent.filter((p) => p.becameLive).length,
  };
}

describe("shared transition cases (pure reference model)", () => {
  it.each(TRANSITION_CASES)("$name", ({ events, expected }) => {
    expect(runSequence(events)).toEqual({
      perEvent: events.map((e) => e.expect),
      status: expected.status,
      lastStepAt: expected.lastStepAt === null ? null : at(expected.lastStepAt),
      liveMessages: expected.liveMessages,
    });
  });

  it("every case's liveMessages matches its per-event becameLive count", () => {
    for (const c of TRANSITION_CASES) {
      expect(c.events.filter((e) => e.expect.becameLive).length, c.name).toBe(
        c.expected.liveMessages,
      );
    }
  });
});
