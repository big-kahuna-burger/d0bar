// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { traceView } from "../../src/panel/views/trace";
import { connection, open, resetShell, selected, view } from "../../src/panel/shell";
import type { TraceContext } from "../../src/collector/correlate";
import { CAUSE_COPY } from "../../src/panel/views/untraced/copy";
import { F_HAS_SPAN, F_XHR } from "../../src/shared/flags";
import { scratch, type RequestRecord } from "../../src/shared/record";
import type { Tier1Access, Tier2State } from "../../src/shared/stage2";
import {
  TIER2_OFF_COPY,
  UNQUERYABLE_COPY,
  type SpanRow,
  type SpanRows,
  type TraceQuery,
  type TraceQueryOutcome,
  type TraceQueryRequest,
  type TraceSummary,
} from "../../src/trace/traceMachine";

/**
 * The trace surface.
 *
 * The property under test is the one the whole change exists for: found, not-queryable-yet
 * and no-span-at-all are three different screens, and no two of them can be reached by the
 * same input. The query is a fake — there is no shipped implementation to test against —
 * and tier 2's state is a value this file sets, because with it off *every* request must
 * land on the no-span screen.
 */

const ORIGIN = "https://app.example.com";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const LIVE: Tier2State = { kind: "live", owner: "d0bar" };
const OFF: Tier2State = { kind: "off", reason: "not-registered" };

const SUMMARY: TraceSummary = {
  spanCount: 7,
  serviceCount: 4,
  logCount: 3,
  truncated: false,
  mainThreadMs: null,
  workerMs: null,
  log: { level: "WARN", message: "tariff cache miss for corridor NL-DE" },
  /* An accessor, not an array — the shape the layout worker actually hands over. Backed by
     plain objects here because what is under test is the view, not the buffer; `layout.test.ts`
     owns the buffer. The scratch discipline is still exercised: the view reads into one record
     and must not retain what it read. */
  rows: rowsOf([
    {
      name: "GET /api/quote",
      service: "edge",
      depth: 0,
      left: 0,
      width: 1,
      durationMs: 412,
      colorIndex: 0,
      orphan: false,
      error: false,
      degenerate: false,
    },
    {
      name: "pricing.lookup",
      service: "pricing-svc",
      depth: 1,
      left: 0.2,
      width: 0.5,
      durationMs: 210,
      colorIndex: 2,
      orphan: false,
      error: true,
      degenerate: false,
    },
  ]),
};

/** Wraps plain rows in the accessor the machine's `TraceSummary` now carries. */
function rowsOf(list: SpanRow[]): SpanRows {
  return {
    count: list.length,
    read(index, out) {
      const row = list[index];
      if (!row) return false;
      Object.assign(out, row);
      return true;
    },
  };
}

function fakeRing(records: RequestRecord[]): Tier1Access {
  return {
    entries: () => [],
    correlate: () => {},
    /* Tier 4's side of the boundary. Not exercised here, but the boundary is one interface —
       stubbed rather than cast away so a change to it fails in this file. */
    spans: () => [],
    adoptSpan: () => {},
    flagConflict: () => {},
    stats: () => ({ written: records.length, dropped: 0, capacity: 64 }),
    read(index, out) {
      const record = records[index];
      if (!record) return false;
      Object.assign(out, record);
      return true;
    },
    onBatch: () => () => {},
    onVisibility: () => () => {},
    visible: () => true,
    /* The trace view reads neither, but the boundary is one interface. Stubbed as an empty
       reading rather than cast away, so a field added to `VitalsReading` fails here instead
       of being silently absent. */
    vitals: () => ({
      self: {
        mode: "unavailable",
        totalMs: 0,
        longestFrameMs: 0,
        frames: 0,
        namedFrames: 0,
        loadPhaseMs: 0,
        top: [],
      },
      lcp: -1,
      cls: 0,
      inp: -1,
      ttfb: -1,
      loafCount: 0,
      loafLongest: 0,
      lcpElement: "",
      clsSource: "",
      inpTarget: "",
      inpTargetIsScored: false,
      loafScript: "",
      entryTypes: [],
    }),
    onVitals: () => () => {},
  };
}

function requestRecord(over: Partial<RequestRecord> = {}): RequestRecord {
  return Object.assign(scratch(), {
    startTime: 100,
    duration: 300,
    url: `${ORIGIN}/api/quote`,
    method: "GET",
    status: 200,
    contextId: 1,
    flags: F_HAS_SPAN,
    ...over,
  });
}

const CONTEXT: TraceContext = {
  traceId: TRACE_ID,
  spanId: "00f067aa0ba902b7",
  sampled: true,
  confident: true,
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

function textOf(root: HTMLElement, selector: string): string {
  return root.querySelector(selector)?.textContent?.trim() ?? "";
}

function visible(root: HTMLElement, selector: string): boolean {
  const node = root.querySelector<HTMLElement>(selector);
  return node !== null && !node.hidden;
}

interface Mounted {
  el: HTMLElement;
  focus(): void;
  destroy(): void;
  calls: TraceQueryRequest[];
  settleQuery(index: number, outcome: TraceQueryOutcome): void;
}

function mount(
  options: {
    tier2: Tier2State;
    withQuery?: boolean;
    context?: TraceContext | undefined;
    ceiling?: number;
    /** Ring indices the worker held a record for — the untraced tab's set, same source. */
    seen?: number[];
  },
  records: RequestRecord[],
): Mounted {
  const calls: TraceQueryRequest[] = [];
  const resolvers: Array<(outcome: TraceQueryOutcome) => void> = [];
  const query: TraceQuery = (request) => {
    calls.push(request);
    return new Promise<TraceQueryOutcome>((resolve) => resolvers.push(resolve));
  };
  const context = "context" in options ? options.context : CONTEXT;
  const created = traceView({
    tier1: fakeRing(records),
    tier2: () => options.tier2,
    origin: ORIGIN,
    timeOrigin: 1_700_000_000_000,
    now: () => 1_700_000_001_000,
    /* Keyed on the record's own `contextId`, exactly as `correlate.ts`'s side table is:
       index 0 is reserved as absent, so a record with no trace context resolves to undefined
       rather than borrowing its neighbour's id. */
    context: (id: number) => (id === 0 ? undefined : context),
    seen: () => new Set(options.seen ?? []),
    ...(options.ceiling === undefined ? {} : { machine: { ceiling: options.ceiling } }),
    ...(options.withQuery === false ? {} : { query }),
  });
  document.body.appendChild(created.el);
  return {
    el: created.el,
    focus: created.focus,
    destroy: created.destroy,
    calls,
    settleQuery: (index, outcome) => resolvers[index]?.(outcome),
  };
}

beforeEach(() => {
  resetShell();
  document.body.replaceChildren();
});

describe("traceView", () => {
  it("puts focus on the back button when asked", () => {
    /* Escape is bound on the panel element, never on the host's document, so it only fires
       while focus is inside the panel. Pushing this surface hides the row that had focus and
       the browser drops focus to `<body>`, outside the shadow root — at which point Escape
       silently stops popping the surface. Observed in Chromium against the fixture before it
       was fixed; the panel calls this on entry. */
    const surface = mount({ tier2: OFF }, [requestRecord()]);
    surface.focus();
    expect(document.activeElement).toBe(surface.el.querySelector(".trace-back"));
    surface.destroy();
  });

  it("issues no query when the panel opens with nothing selected", async () => {
    const surface = mount({ tier2: LIVE }, [requestRecord()]);
    open.set(true);
    await settled();
    expect(surface.calls).toHaveLength(0);
    surface.destroy();
  });

  it("issues no query while the panel is closed, even with a request selected", async () => {
    const surface = mount({ tier2: LIVE }, [requestRecord()]);
    view.set("trace");
    selected.set(0);
    await settled();
    expect(surface.calls).toHaveLength(0);
    surface.destroy();
  });

  it("renders the no-span screen for every request when tier 2 is off", async () => {
    /* The degraded case, and the one most easily got wrong: with no service worker there is
       no traceparent on anything, so this must not read as "not found" and must not spin. */
    const surface = mount({ tier2: OFF }, [requestRecord()]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();

    expect(visible(surface.el, ".trace-none")).toBe(true);
    expect(visible(surface.el, ".trace-wait")).toBe(false);
    expect(visible(surface.el, ".trace-found")).toBe(false);
    expect(textOf(surface.el, ".trace-none-title")).toBe("No span exists for this request.");
    expect(textOf(surface.el, ".trace-none-why")).toBe(TIER2_OFF_COPY);
    /* Nothing was seen by any worker, so the line that claims one saw it is not printed. */
    expect(visible(surface.el, ".trace-none-sw")).toBe(false);
    expect(surface.calls).toHaveLength(0);
    surface.destroy();
  });

  it("names XHR as the cause, in the untraced tab's own words", async () => {
    /* Task 4.2. The sentence is `CAUSE_COPY`'s, from `classify()`'s answer — the same two
       functions the untraced tab uses on the same record, so the two surfaces cannot give a
       reader different reasons for the same missing span. */
    const surface = mount({ tier2: LIVE, context: undefined }, [
      requestRecord({ flags: F_XHR, contextId: 0 }),
    ]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();

    expect(textOf(surface.el, ".trace-none-why")).toBe(CAUSE_COPY["transport-xhr"]);
    expect(surface.calls).toHaveLength(0);
    surface.destroy();
  });

  it("credits the worker's observation only where the worker made one", async () => {
    /* Task 4.4, tightened by the classification. `not-propagated` *is* "the worker held a
       record and there was no traceparent on it", so it is the only cause that entails the
       line. The same record with the worker's set empty classifies as `unseen` and must not
       print it — which the old three-way copy did, on a request no worker ever saw. */
    const seenSurface = mount({ tier2: LIVE, context: undefined, seen: [0] }, [
      requestRecord({ flags: 0, contextId: 0 }),
    ]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();

    expect(textOf(seenSurface.el, ".trace-none-why")).toBe(CAUSE_COPY["not-propagated"]);
    expect(visible(seenSurface.el, ".trace-none-sw")).toBe(true);
    expect(textOf(seenSurface.el, ".trace-none-sw")).toBe(
      "seen by the SW · never reached the backend",
    );
    seenSurface.destroy();

    resetShell();
    document.body.replaceChildren();

    const unseenSurface = mount({ tier2: LIVE, context: undefined, seen: [] }, [
      requestRecord({ flags: 0, contextId: 0 }),
    ]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();

    expect(textOf(unseenSurface.el, ".trace-none-why")).toBe(CAUSE_COPY.unseen);
    expect(visible(unseenSurface.el, ".trace-none-sw")).toBe(false);
    unseenSurface.destroy();
  });

  it("distinguishes causes the old three-way copy could not express", async () => {
    /* Both of these used to render as "no traceparent" — a claim that instrumentation failed,
       about a stylesheet the browser fetched itself and about an origin nobody could have
       propagated into. */
    const subresource = mount({ tier2: LIVE, context: undefined, seen: [0] }, [
      requestRecord({ url: `${ORIGIN}/app.css`, initiator: "css", contextId: 0, flags: 0 }),
    ]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();
    expect(textOf(subresource.el, ".trace-none-why")).toBe(CAUSE_COPY.subresource);
    subresource.destroy();

    resetShell();
    document.body.replaceChildren();

    const thirdParty = mount({ tier2: LIVE, context: undefined, seen: [0] }, [
      requestRecord({ url: "https://cdn.example.net/rates.json", contextId: 0, flags: 0 }),
    ]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();
    expect(textOf(thirdParty.el, ".trace-none-why")).toBe(CAUSE_COPY["third-party"]);
    thirdParty.destroy();
  });

  it("tells an unconnected developer the one thing they can do about it", async () => {
    /* The span exists and d0bar cannot ask about it — but with no token connected that is a
       state the developer fixes in ten seconds, so the screen has to say which. This copy
       previously read "d0bar has no credentialed backend to query yet", which stopped being
       true the day the connect surface shipped. */
    connection.set({ connected: false, source: "none", hint: "", apiOrigin: "" });
    const surface = mount({ tier2: LIVE, withQuery: false }, [requestRecord()]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();

    expect(textOf(surface.el, ".trace-none-title")).toBe("Connect a token to fetch this span.");
    expect(textOf(surface.el, ".trace-none-why")).toBe(UNQUERYABLE_COPY["not-connected"]);
    expect(visible(surface.el, ".trace-none-sw")).toBe(false);
    expect(visible(surface.el, ".trace-wait")).toBe(false);
    surface.destroy();
  });

  it("blames itself, not the user's custody, once a token is connected", async () => {
    /* The other half of the same correction. Telling someone to connect a token when one is
       connected sends them to perform a no-op and then stop believing the panel. */
    connection.set({
      connected: true,
      source: "session",
      hint: "wxyz",
      apiOrigin: "https://api.eu-west-1.aws.dash0.com",
    });
    const surface = mount({ tier2: LIVE, withQuery: false }, [requestRecord()]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();

    expect(textOf(surface.el, ".trace-none-title")).toBe(
      "This panel does not query spans yet.",
    );
    expect(textOf(surface.el, ".trace-none-why")).toBe(UNQUERYABLE_COPY["not-wired"]);
    surface.destroy();
  });

  it("renders the ingest-lag screen with a live retry line, never the no-span ring", async () => {
    const surface = mount({ tier2: LIVE }, [requestRecord()]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();
    expect(surface.calls).toHaveLength(1);

    surface.settleQuery(0, { kind: "not-found" });
    await settled();

    expect(visible(surface.el, ".trace-wait")).toBe(true);
    expect(visible(surface.el, ".trace-none")).toBe(false);
    expect(visible(surface.el, ".lag-dots")).toBe(true);
    expect(textOf(surface.el, ".trace-wait-title")).toBe(
      "Trace not queryable yet — waiting for ingest.",
    );
    expect(textOf(surface.el, ".trace-wait-retry")).toMatch(
      /^retry 1 of 5 · next in \d\.\ds · backoff$/,
    );
    expect(textOf(surface.el, ".trace-wait-why")).toContain("The request finished");
    /* No manual retry while an automatic one is still scheduled. */
    expect(visible(surface.el, ".trace-retry")).toBe(false);
    surface.destroy();
  });

  it("renders the found screen with counts, span rows and the correlated-log footer", async () => {
    const surface = mount({ tier2: LIVE }, [requestRecord()]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();
    surface.settleQuery(0, { kind: "found", summary: SUMMARY });
    await settled();
    await frame();

    expect(visible(surface.el, ".trace-found")).toBe(true);
    expect(visible(surface.el, ".trace-none")).toBe(false);
    expect(visible(surface.el, ".trace-wait")).toBe(false);
    expect(textOf(surface.el, ".trace-meta span")).toBe("7 spans · 4 services · 3 logs");
    expect(surface.el.querySelectorAll(".trace-meta span")[1]?.textContent).toBe(
      "timeRange ±2s",
    );
    /* Nothing measured the flattening cost, so the panel prints no claim about it. */
    expect(visible(surface.el, ".trace-cost")).toBe(false);

    expect(textOf(surface.el, ".trace-id")).toBe(TRACE_ID);
    expect(surface.el.querySelector(".trace-id")?.hasAttribute("data-uncertain")).toBe(false);

    const rows = [...surface.el.querySelectorAll<HTMLElement>(".span-row")].filter(
      (row) => !row.hidden,
    );
    expect(rows).toHaveLength(2);
    expect(textOf(rows[0]!, ".span-label")).toBe("GET /api/quote");
    expect(rows[0]!.dataset["root"]).toBe("true");
    expect(rows[1]!.dataset["error"]).toBe("true");
    expect(
      rows[1]!.querySelector<HTMLElement>(".span-name")!.style.getPropertyValue("--depth"),
    ).toBe("1");
    expect(rows[1]!.style.getPropertyValue("--l")).toBe("0.2");
    expect(rows[1]!.style.getPropertyValue("--w")).toBe("0.5");

    expect(visible(surface.el, ".trace-log")).toBe(true);
    expect(textOf(surface.el, ".trace-log-level")).toBe("WARN");
    expect(textOf(surface.el, ".trace-log-link")).toBe("3 correlated logs");
    surface.destroy();
  });

  it("prints the worker-cost claim only from a measured value", async () => {
    const surface = mount({ tier2: LIVE }, [requestRecord()]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();
    surface.settleQuery(0, {
      kind: "found",
      summary: { ...SUMMARY, mainThreadMs: 0.4 },
    });
    await settled();
    expect(visible(surface.el, ".trace-cost")).toBe(true);
    expect(textOf(surface.el, ".trace-cost")).toBe(
      "flattened in worker · 0.4 ms on main thread",
    );
    surface.destroy();
  });

  it("marks a low-confidence trace id rather than asserting it", async () => {
    const surface = mount({ tier2: LIVE, context: { ...CONTEXT, confident: false } }, [
      requestRecord(),
    ]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();
    expect(surface.el.querySelector(".trace-id")?.hasAttribute("data-uncertain")).toBe(true);
    surface.destroy();
  });

  it("offers a manual retry once the ceiling is reached, and stops the dots", async () => {
    /* Ceiling of one, so exhaustion is reached without waiting out four real doublings. The
       ceiling's own arithmetic is asserted in `trace-machine.test.ts` against a fake clock;
       what is under test here is the screen it produces. */
    const surface = mount({ tier2: LIVE, ceiling: 1 }, [requestRecord()]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();
    surface.settleQuery(0, { kind: "not-found" });
    await settled();

    expect(textOf(surface.el, ".trace-wait-title")).toBe("The trace did not become queryable.");
    expect(visible(surface.el, ".lag-dots")).toBe(false);
    expect(visible(surface.el, ".trace-retry")).toBe(true);
    expect(visible(surface.el, ".trace-none")).toBe(false);
    surface.destroy();
  });

  it("never lets a response from a previous selection reach the panel", async () => {
    const first = requestRecord();
    const second = requestRecord({ url: `${ORIGIN}/api/other`, flags: F_XHR, contextId: 0 });
    const surface = mount({ tier2: LIVE, context: CONTEXT }, [first, second]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();
    expect(surface.calls).toHaveLength(1);

    /* The user clicks a different row while the first query is still open. */
    selected.set(1);
    await settled();

    surface.settleQuery(0, { kind: "found", summary: SUMMARY });
    await settled();
    await frame();

    /* The stale trace must not appear, and the screen must be the one the new selection
       resolves to on its own. */
    expect(visible(surface.el, ".trace-found")).toBe(false);
    expect(visible(surface.el, ".trace-none")).toBe(true);
    expect(textOf(surface.el, ".trace-none-title")).toBe("No span exists for this request.");
    surface.destroy();
  });

  it("aborts and clears when the surface is popped back to the list", async () => {
    const surface = mount({ tier2: LIVE }, [requestRecord()]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();

    const back = surface.el.querySelector<HTMLButtonElement>(".trace-back")!;
    back.click();
    await settled();

    expect(view()).toBe("list");
    expect(selected()).toBe(-1);

    surface.settleQuery(0, { kind: "found", summary: SUMMARY });
    await settled();
    expect(visible(surface.el, ".trace-found")).toBe(false);
    surface.destroy();
  });

  it("aborts when the panel closes", async () => {
    const surface = mount({ tier2: LIVE }, [requestRecord()]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();

    open.set(false);
    await settled();
    surface.settleQuery(0, { kind: "found", summary: SUMMARY });
    await settled();
    expect(visible(surface.el, ".trace-found")).toBe(false);
    surface.destroy();
  });

  it("hides the log footer when the trace has no correlated logs", async () => {
    const surface = mount({ tier2: LIVE }, [requestRecord()]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();
    surface.settleQuery(0, {
      kind: "found",
      summary: { ...SUMMARY, logCount: 0, log: undefined as never },
    });
    await settled();
    expect(visible(surface.el, ".trace-found")).toBe(true);
    expect(visible(surface.el, ".trace-log")).toBe(false);
    surface.destroy();
  });

  it("states truncation rather than presenting a partial waterfall as whole", async () => {
    const surface = mount({ tier2: LIVE }, [requestRecord()]);
    open.set(true);
    view.set("trace");
    selected.set(0);
    await settled();
    surface.settleQuery(0, { kind: "found", summary: { ...SUMMARY, truncated: true } });
    await settled();
    expect(visible(surface.el, ".trace-trunc")).toBe(true);
    surface.destroy();
  });
});
