import { describe, expect, it } from "vitest";
import type { QueryOutcome } from "../../src/shared/broker";
import type { Flattened, LayoutClient } from "../../src/panel/layout-client";
import { TRACE_DETAILS_PATH, createTraceQuery, traceDetailsBody } from "../../src/trace/query";
import { NO_SPANS, type TraceQueryRequest } from "../../src/trace/traceMachine";

/**
 * The trace query: the POST, and the handoff of its body to the layout worker.
 *
 * The property worth asserting most is a negative one — **the body is never parsed here**. It is
 * checked by giving the query a body that is not JSON at all and asserting the call still
 * succeeds, because nothing on this side ever looks at it. A future change that added a
 * `JSON.parse` for a status field, a count, or an error envelope would fail this file, which is
 * the only place such a change would be caught before a benchmark.
 */

const AT = 1_700_000_000_000;
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const ORIGIN = "https://api.eu-west-1.aws.dash0.com";

const REQUEST: TraceQueryRequest = {
  traceId: TRACE_ID,
  timeRange: { from: AT - 2000, to: AT + 2000 },
};

function flattened(over: Partial<Flattened> = {}): Flattened {
  return {
    rows: { count: 3, read: () => true },
    summary: {
      spanCount: 3,
      spansSeen: 3,
      serviceCount: 2,
      logCount: 1,
      truncated: false,
      totalDurationNs: 412_000_000,
      log: { level: "WARN", message: "tariff cache miss" },
    },
    workerMs: 6,
    ...over,
  };
}

interface Harness {
  calls: Array<{ url: string; init: { method: string; body: string } }>;
  bodies: string[];
}

function harness(
  outcome: QueryOutcome | (() => Promise<QueryOutcome>),
  layoutResult: Flattened | Error = flattened(),
  origin = ORIGIN,
  dataset = "default",
) {
  const state: Harness = { calls: [], bodies: [] };
  const layout: LayoutClient = {
    flatten(body) {
      state.bodies.push(body);
      return layoutResult instanceof Error
        ? Promise.reject(layoutResult)
        : Promise.resolve(layoutResult);
    },
    destroy() {},
  };
  const query = createTraceQuery({
    send(url, init) {
      state.calls.push({ url, init });
      return typeof outcome === "function" ? outcome() : Promise.resolve(outcome);
    },
    layout,
    apiOrigin: () => origin,
    dataset: () => dataset,
  });
  return { query, state };
}

const ok = (body: string, status = 200): QueryOutcome => ({ ok: true, status, body });

describe("the request", () => {
  it("POSTs to /api/trace/details on the connected region's origin", async () => {
    const { query, state } = harness(ok("{}"));
    await query(REQUEST, new AbortController().signal);

    expect(state.calls[0]!.url).toBe(`${ORIGIN}${TRACE_DETAILS_PATH}`);
    expect(state.calls[0]!.init.method).toBe("POST");
  });

  it("never omits the time range", async () => {
    /* The backend falls back to a full table scan without it, and the toolbar is the one client
       that knows the request's own timestamp to the millisecond. `timeRange` is required on
       `TraceQueryRequest` so it cannot be dropped upstream; this is the conversion. */
    const body = JSON.parse(traceDetailsBody(REQUEST, "default")) as {
      traceId: string;
      dataset: string;
      timeRange: { from: string; to: string };
    };

    expect(body.traceId).toBe(TRACE_ID);
    expect(body.dataset).toBe("default");
    expect(body.timeRange.from).toBe(new Date(AT - 2000).toISOString());
    expect(body.timeRange.to).toBe(new Date(AT + 2000).toISOString());
    /* Four seconds wide, not the whole day. */
    expect(Date.parse(body.timeRange.to) - Date.parse(body.timeRange.from)).toBe(4000);
  });

  it("reads the origin at call time, not at construction", async () => {
    /* The developer can reconnect to a different region with the panel open. A captured origin
       would query the previous one and fail as an authorization error, which reads as a bad
       token rather than as a stale wiring bug. */
    let origin = "https://api.eu-west-1.aws.dash0.com";
    const query = createTraceQuery({
      send: (url) => {
        seen.push(url);
        return Promise.resolve(ok("{}"));
      },
      layout: { flatten: () => Promise.resolve(flattened()), destroy() {} },
      apiOrigin: () => origin,
      dataset: () => "default",
    });
    const seen: string[] = [];

    await query(REQUEST, new AbortController().signal);
    origin = "https://api.us-west-2.aws.dash0.com";
    await query(REQUEST, new AbortController().signal);

    expect(seen[0]).toContain("eu-west-1");
    expect(seen[1]).toContain("us-west-2");
  });

  it("sends the connected dataset, not a hardcoded default", async () => {
    /* This is the assertion whose absence let the original defect ship. `dataset` was an optional
       field nobody passed, so every query in the built product went to `"default"` — and because
       a query into the wrong dataset is answered 404 rather than rejected, the panel presented it
       as a trace that had not been ingested. */
    const { query, state } = harness(ok("{}"), flattened(), ORIGIN, "app-prod");
    await query(REQUEST, new AbortController().signal);

    expect((JSON.parse(state.calls[0]!.init.body) as { dataset: string }).dataset).toBe(
      "app-prod",
    );
  });

  it("reads the dataset at call time, not at construction", async () => {
    /* Same property as the origin above, and the failure is quieter: a stale origin produces an
       authorization error, a stale dataset produces an empty answer that reads as a missing
       trace. Asserted by changing the value between two calls and reading both bodies — a
       snapshot taken in the factory passes every other test in this file. */
    let dataset = "app-prod";
    const sent: string[] = [];
    const query = createTraceQuery({
      send: (_url, init) => {
        sent.push((JSON.parse(init.body) as { dataset: string }).dataset);
        return Promise.resolve(ok("{}"));
      },
      layout: { flatten: () => Promise.resolve(flattened()), destroy() {} },
      apiOrigin: () => ORIGIN,
      dataset: () => dataset,
    });

    await query(REQUEST, new AbortController().signal);
    dataset = "app-staging";
    await query(REQUEST, new AbortController().signal);

    expect(sent).toEqual(["app-prod", "app-staging"]);
  });

  it("refuses to query at all with nothing connected", async () => {
    const { query, state } = harness(ok("{}"), flattened(), "");
    const outcome = await query(REQUEST, new AbortController().signal);

    expect(state.calls).toHaveLength(0);
    expect(outcome).toEqual({
      kind: "error",
      message: "No token is connected, so d0bar cannot ask about this trace.",
    });
  });
});

describe("the response body", () => {
  it("hands the body to the layout worker untouched", async () => {
    const body = '{"resourceSpans":[{"scopeSpans":[]}]}';
    const { query, state } = harness(ok(body));
    await query(REQUEST, new AbortController().signal);

    expect(state.bodies).toEqual([body]);
  });

  it("does not parse it — a body that is not JSON still reaches the worker", async () => {
    /* The assertion that keeps this path honest. If anything on this thread ever called
       `JSON.parse` on a response, this test would throw instead of resolving. */
    const { query, state } = harness(ok("<html>gateway timeout</html>"));
    const outcome = await query(REQUEST, new AbortController().signal);

    expect(state.bodies).toEqual(["<html>gateway timeout</html>"]);
    expect(outcome.kind).toBe("found");
  });

  it("reports the worker's time and its own, separately", async () => {
    const { query } = harness(ok("{}"), flattened({ workerMs: 6 }));
    const outcome = await query(REQUEST, new AbortController().signal);
    if (outcome.kind !== "found") throw new Error(outcome.kind);

    /* The header prints `flattened in worker · N ms on main thread`, and neither half may be a
       number nobody measured. The worker's is the worker's own; the main thread's excludes it. */
    expect(outcome.summary.workerMs).toBe(6);
    expect(outcome.summary.mainThreadMs).not.toBeNull();
    expect(outcome.summary.mainThreadMs!).toBeGreaterThanOrEqual(0);
    expect(outcome.summary.mainThreadMs!).toBeLessThan(50);
  });

  it("carries the summary's counts and its worst log through", async () => {
    const { query } = harness(ok("{}"));
    const outcome = await query(REQUEST, new AbortController().signal);
    if (outcome.kind !== "found") throw new Error(outcome.kind);

    expect(outcome.summary.spanCount).toBe(3);
    expect(outcome.summary.serviceCount).toBe(2);
    expect(outcome.summary.logCount).toBe(1);
    expect(outcome.summary.log).toEqual({ level: "WARN", message: "tariff cache miss" });
  });
});

describe("outcomes", () => {
  it("reads 404 as ingest lag, which is the only retried state", async () => {
    const { query } = harness({ ok: true, status: 404, body: "" });
    expect(await query(REQUEST, new AbortController().signal)).toEqual({ kind: "not-found" });
  });

  it("reads an empty trace the same way, not as found", async () => {
    /* The API answered and had nothing. That is "not yet", the same reading as a 404 — and it
       must not render as a found trace with an empty waterfall. */
    const { query } = harness(ok("{}"), flattened({ rows: NO_SPANS }));
    expect(await query(REQUEST, new AbortController().signal)).toEqual({ kind: "not-found" });
  });

  it("names each connection failure rather than collapsing them", async () => {
    /* Every one of these is a statement about d0bar or the connection, never about the trace.
       A query that could not be issued must not render as a trace that does not exist. */
    for (const [reason, fragment] of [
      ["rejected", /rejected the connected token/i],
      ["unreachable", /could not reach the Dash0 API/i],
      ["refused-origin", /bug in the toolbar/i],
      ["not-connected", /No token is connected/i],
    ] as const) {
      const { query } = harness({ ok: false, reason });
      const outcome = await query(REQUEST, new AbortController().signal);
      expect(outcome.kind).toBe("error");
      expect((outcome as { message: string }).message).toMatch(fragment);
    }
  });

  it("does not blame the trace for a 5xx", async () => {
    const { query } = harness(ok("", 503));
    const outcome = await query(REQUEST, new AbortController().signal);
    expect(outcome.kind).toBe("error");
    expect((outcome as { message: string }).message).toContain(
      "not a statement about the trace",
    );
  });

  it("turns a layout failure into an error with the worker's own sentence", async () => {
    const { query } = harness(
      ok("{"),
      new Error("The trace response was not valid JSON, so there is nothing to lay out."),
    );
    const outcome = await query(REQUEST, new AbortController().signal);
    expect(outcome).toEqual({
      kind: "error",
      message: "The trace response was not valid JSON, so there is nothing to lay out.",
    });
  });

  it("stops before the worker when the selection moved mid-flight", async () => {
    const controller = new AbortController();
    const { query, state } = harness(() => {
      controller.abort();
      return Promise.resolve(ok("{}"));
    });

    const outcome = await query(REQUEST, controller.signal);
    /* The machine's generation counter would refuse the write anyway. Returning here means the
       layout worker is never asked to flatten a trace nobody is looking at. */
    expect(state.bodies).toEqual([]);
    expect(outcome.kind).toBe("error");
  });
});
