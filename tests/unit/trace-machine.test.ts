import { describe, expect, it } from "vitest";
import {
  backoffFor,
  createTraceMachine,
  inputFor,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  RANGE_MS,
  type TraceInput,
  type TraceQuery,
  type TraceQueryOutcome,
  type TraceQueryRequest,
  type TraceState,
  type TraceSummary,
} from "../../src/trace/traceMachine";

/**
 * The trace machine, driven entirely through fakes.
 *
 * There is no backend and no browser here on purpose. The query is an injected function with
 * no shipped implementation, the clock is a number this file increments, and the timer queue
 * is an array — so the properties that matter (a stale response can never write, the backoff
 * has a ceiling, and the three outcomes never collapse into one) are settled by assertions
 * rather than by watching a panel.
 */

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const AT = 1_700_000_000_000;

const SUMMARY: TraceSummary = {
  spanCount: 7,
  serviceCount: 4,
  logCount: 3,
  truncated: false,
  spans: [],
  mainThreadMs: null,
};

/** A manual timer queue: nothing fires until the test says so. */
function fakeClock() {
  let now = AT;
  const queue: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimer(fn: () => void, ms: number) {
      const id = nextId++;
      queue.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimer(handle: unknown) {
      const at = queue.findIndex((entry) => entry.id === handle);
      if (at >= 0) queue.splice(at, 1);
    },
    pending: () => queue.length,
    /** Runs every timer that is due, advancing the clock to the latest of them. */
    flush() {
      const due = queue.splice(0, queue.length);
      for (const entry of due) {
        now = Math.max(now, entry.at);
        entry.fn();
      }
    },
  };
}

/** A query the test resolves by hand, recording every call and every abort signal. */
function deferredQuery() {
  const calls: TraceQueryRequest[] = [];
  const signals: AbortSignal[] = [];
  const resolvers: Array<(outcome: TraceQueryOutcome) => void> = [];
  const rejecters: Array<(error: unknown) => void> = [];
  const query: TraceQuery = (request, signal) => {
    calls.push(request);
    signals.push(signal);
    return new Promise<TraceQueryOutcome>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    });
  };
  return {
    query,
    calls,
    signals,
    settle(index: number, outcome: TraceQueryOutcome) {
      resolvers[index]?.(outcome);
    },
    fail(index: number, error: unknown) {
      rejecters[index]?.(error);
    },
  };
}

function traceInput(): Extract<TraceInput, { kind: "trace" }> {
  return { kind: "trace", traceId: TRACE_ID, confident: true, at: AT };
}

/** Lets every already-resolved promise continuation run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function record(machine: ReturnType<typeof createTraceMachine>): TraceState[] {
  const seen: TraceState[] = [];
  machine.subscribe((state) => seen.push(state));
  return seen;
}

describe("backoffFor", () => {
  it("doubles per attempt and clamps at the ceiling", () => {
    expect(backoffFor(1)).toBe(BASE_DELAY_MS);
    expect(backoffFor(2)).toBe(BASE_DELAY_MS * 2);
    expect(backoffFor(3)).toBe(BASE_DELAY_MS * 4);
    expect(backoffFor(4)).toBe(BASE_DELAY_MS * 8);
    expect(backoffFor(5)).toBe(MAX_DELAY_MS);
    /* The whole point of the ceiling: it does not keep doubling past it. */
    expect(backoffFor(12)).toBe(MAX_DELAY_MS);
  });
});

describe("inputFor", () => {
  it("resolves every request to no-span when tier 2 is off", () => {
    /* Not "not found", and not a spinner: with no service worker there is no traceparent on
       anything, so the backend was never a party to this. */
    expect(
      inputFor({
        tier2Live: false,
        hasSpan: true,
        xhr: false,
        traceId: TRACE_ID,
        confident: true,
        at: AT,
      }),
    ).toEqual({ kind: "none", why: "tier-2-off" });
  });

  it("names XHR as the cause where the entry says so", () => {
    expect(
      inputFor({
        tier2Live: true,
        hasSpan: false,
        xhr: true,
        traceId: "",
        confident: true,
        at: AT,
      }),
    ).toEqual({ kind: "none", why: "xhr" });
  });

  it("falls back to the observed absence of a traceparent", () => {
    expect(
      inputFor({
        tier2Live: true,
        hasSpan: false,
        xhr: false,
        traceId: "",
        confident: true,
        at: AT,
      }),
    ).toEqual({ kind: "none", why: "no-traceparent" });
  });

  it("produces a trace input only with a live tier 2 and a real id", () => {
    expect(
      inputFor({
        tier2Live: true,
        hasSpan: true,
        xhr: false,
        traceId: TRACE_ID,
        confident: false,
        at: AT,
      }),
    ).toEqual({ kind: "trace", traceId: TRACE_ID, confident: false, at: AT });
  });
});

describe("createTraceMachine", () => {
  it("issues nothing until a request is selected", async () => {
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query });
    expect(machine.state()).toEqual({ name: "idle" });
    machine.select(null);
    await settled();
    expect(q.calls).toHaveLength(0);
    expect(machine.state()).toEqual({ name: "idle" });
  });

  it("resolves a no-span selection without touching the query", async () => {
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query });
    machine.select({ kind: "none", why: "tier-2-off" });
    await settled();
    expect(q.calls).toHaveLength(0);
    expect(machine.state()).toEqual({ name: "none", why: "tier-2-off" });
  });

  it("reports unqueryable rather than inventing an outcome when no query is injected", async () => {
    /* This is what a real deployment sees today: `add-credential-broker` has not landed, so
       the panel constructs the machine with no query at all. It must not read as "not found
       yet" — nothing was asked. */
    const machine = createTraceMachine();
    machine.select(traceInput());
    await settled();
    expect(machine.state()).toEqual({ name: "unqueryable", traceId: TRACE_ID });
  });

  it("carries a ±2s time range on every attempt", async () => {
    const clock = fakeClock();
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query, ...clock });
    machine.select(traceInput());
    await settled();
    expect(q.calls[0]).toEqual({
      traceId: TRACE_ID,
      timeRange: { from: AT - RANGE_MS, to: AT + RANGE_MS },
    });
    q.settle(0, { kind: "not-found" });
    await settled();
    clock.flush();
    await settled();
    expect(q.calls[1]?.timeRange).toEqual({ from: AT - RANGE_MS, to: AT + RANGE_MS });
  });

  it("goes straight to found on an immediate success", async () => {
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query, ...fakeClock() });
    const seen = record(machine);
    machine.select(traceInput());
    await settled();
    expect(machine.state().name).toBe("fetching");
    q.settle(0, { kind: "found", summary: SUMMARY });
    await settled();
    expect(machine.state()).toEqual({
      name: "found",
      traceId: TRACE_ID,
      summary: SUMMARY,
      timeRange: { from: AT - RANGE_MS, to: AT + RANGE_MS },
    });
    expect(seen.map((state) => state.name)).toEqual(["fetching", "found"]);
  });

  it("walks the ingest-lag path: not-found, backoff, retry, found", async () => {
    const clock = fakeClock();
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query, ...clock });
    const seen = record(machine);

    machine.select(traceInput());
    await settled();
    q.settle(0, { kind: "not-found" });
    await settled();

    const waiting = machine.state();
    expect(waiting.name).toBe("waiting");
    if (waiting.name !== "waiting") throw new Error("unreachable");
    expect(waiting.attempt).toBe(1);
    expect(waiting.delay).toBe(BASE_DELAY_MS);
    expect(waiting.nextAt).toBe(AT + BASE_DELAY_MS);

    clock.flush();
    await settled();
    expect(q.calls).toHaveLength(2);
    q.settle(1, { kind: "found", summary: SUMMARY });
    await settled();

    expect(machine.state().name).toBe("found");
    expect(seen.map((state) => state.name)).toEqual([
      "fetching",
      "waiting",
      "fetching",
      "found",
    ]);
  });

  it("stops at the ceiling and offers a manual retry rather than polling forever", async () => {
    const clock = fakeClock();
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query, ...clock });

    machine.select(traceInput());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await settled();
      expect(machine.state().name).toBe("fetching");
      q.settle(attempt, { kind: "not-found" });
      await settled();
      if (attempt < 4) {
        expect(machine.state().name).toBe("waiting");
        clock.flush();
      }
    }

    expect(q.calls).toHaveLength(5);
    expect(machine.state()).toEqual({ name: "exhausted", traceId: TRACE_ID, attempts: 5 });
    /* No timer is left behind — an exhausted machine is genuinely stopped, not slowed. */
    expect(clock.pending()).toBe(0);

    machine.retry();
    await settled();
    const retried = machine.state();
    expect(retried.name).toBe("fetching");
    if (retried.name !== "fetching") throw new Error("unreachable");
    expect(retried.attempt).toBe(1);
  });

  it("separates a failed query from an un-ingested trace", async () => {
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query, ...fakeClock() });
    machine.select(traceInput());
    await settled();
    q.settle(0, { kind: "error", message: "401" });
    await settled();
    expect(machine.state()).toEqual({
      name: "failed",
      traceId: TRACE_ID,
      attempt: 1,
      message: "401",
    });
  });

  it("treats a rejected query as a failure, not as a missing trace", async () => {
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query, ...fakeClock() });
    machine.select(traceInput());
    await settled();
    q.fail(0, new Error("network down"));
    await settled();
    const state = machine.state();
    expect(state.name).toBe("failed");
    if (state.name !== "failed") throw new Error("unreachable");
    expect(state.message).toBe("network down");
  });

  it("aborts the in-flight query when another request is selected", async () => {
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query, ...fakeClock() });
    machine.select(traceInput());
    await settled();
    expect(q.signals[0]?.aborted).toBe(false);

    machine.select({ kind: "trace", traceId: "beef", confident: true, at: AT + 50 });
    await settled();
    expect(q.signals[0]?.aborted).toBe(true);
  });

  it("drops a response that arrives after the selection moved", async () => {
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query, ...fakeClock() });
    const seen = record(machine);

    machine.select(traceInput());
    await settled();

    /* The user clicks another request while the first query is still open. */
    machine.select({ kind: "none", why: "xhr" });
    await settled();
    expect(machine.state()).toEqual({ name: "none", why: "xhr" });

    /* The first query now resolves — with a trace, which is the worst case: it would look
       entirely plausible in the panel and would belong to a different request. */
    q.settle(0, { kind: "found", summary: SUMMARY });
    await settled();

    expect(machine.state()).toEqual({ name: "none", why: "xhr" });
    expect(seen.map((state) => state.name)).toEqual(["fetching", "none"]);
  });

  it("drops a not-found that arrives after the selection moved, scheduling no retry", async () => {
    const clock = fakeClock();
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query, ...clock });

    machine.select(traceInput());
    await settled();
    machine.select(null);
    await settled();

    q.settle(0, { kind: "not-found" });
    await settled();

    expect(machine.state()).toEqual({ name: "idle" });
    /* The dangerous half: a stale not-found must not leave a backoff timer running that
       would later fire a query for a request nobody is looking at. */
    expect(clock.pending()).toBe(0);
    expect(q.calls).toHaveLength(1);
  });

  it("cancels a scheduled retry when the selection changes during the backoff", async () => {
    const clock = fakeClock();
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query, ...clock });

    machine.select(traceInput());
    await settled();
    q.settle(0, { kind: "not-found" });
    await settled();
    expect(machine.state().name).toBe("waiting");
    expect(clock.pending()).toBe(1);

    machine.select({ kind: "none", why: "no-traceparent" });
    await settled();
    expect(clock.pending()).toBe(0);

    clock.flush();
    await settled();
    expect(q.calls).toHaveLength(1);
    expect(machine.state()).toEqual({ name: "none", why: "no-traceparent" });
  });

  it("aborts and goes idle on stop, which is what closing the panel does", async () => {
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query, ...fakeClock() });
    machine.select(traceInput());
    await settled();

    machine.stop();
    await settled();
    expect(q.signals[0]?.aborted).toBe(true);
    expect(machine.state()).toEqual({ name: "idle" });

    q.settle(0, { kind: "found", summary: SUMMARY });
    await settled();
    expect(machine.state()).toEqual({ name: "idle" });

    /* Nothing to retry: stop clears the selection as well as the query. */
    machine.retry();
    await settled();
    expect(machine.state()).toEqual({ name: "idle" });
  });

  it("honours a shortened ceiling", async () => {
    const clock = fakeClock();
    const q = deferredQuery();
    const machine = createTraceMachine({ query: q.query, ceiling: 2, ...clock });
    machine.select(traceInput());
    await settled();
    q.settle(0, { kind: "not-found" });
    await settled();
    clock.flush();
    await settled();
    q.settle(1, { kind: "not-found" });
    await settled();
    expect(machine.state()).toEqual({ name: "exhausted", traceId: TRACE_ID, attempts: 2 });
  });
});
