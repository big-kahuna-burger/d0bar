import { describe, expect, it } from "vitest";
import { barFor, MIN_WIDTH, WINDOW_MS } from "../../src/panel/views/requests/geometry";
import { scratch, type RequestRecord } from "../../src/shared/record";
import { F_NO_PHASES } from "../../src/shared/flags";

/**
 * Waterfall geometry, without a browser.
 *
 * The two claims the requests view makes about its bars — that they are comparable to each
 * other, and that a phase breakdown is measured rather than invented — are arithmetic, so
 * they are settled here rather than by reading pixels out of a rendered panel.
 */

function record(over: Partial<RequestRecord> = {}): RequestRecord {
  const base = scratch();
  /* A well-formed same-origin entry: connect at 110, request at 130, first byte at 300,
     last byte at 512. Every later case is a departure from this one. */
  Object.assign(base, {
    startTime: 100,
    duration: 412,
    connectStart: 110,
    requestStart: 130,
    responseStart: 300,
    responseEnd: 512,
    url: "https://app.example.com/api/shipments",
    status: 200,
  });
  return Object.assign(base, over);
}

describe("placement in the shared window", () => {
  it("positions by page-relative start over a fixed 3000ms span", () => {
    const bar = barFor(record({ startTime: 600, duration: 300 }));
    expect(bar.left).toBeCloseTo(0.2, 6);
    expect(bar.width).toBeCloseTo(0.1, 6);
  });

  it("gives equal durations equal widths at different offsets", () => {
    /* The whole point of a shared window: two bars the same length mean two requests the
       same length, anywhere in the list. */
    const early = barFor(record({ startTime: 60, duration: 250 }));
    const late = barFor(record({ startTime: 2000, duration: 250 }));
    expect(early.width).toBeCloseTo(late.width, 10);
    expect(early.left).toBeLessThan(late.left);
  });

  it("floors a sub-millisecond request at a visible width", () => {
    const bar = barFor(record({ startTime: 0, duration: 0.4 }));
    expect(bar.width).toBe(MIN_WIDTH);
  });

  it("pins a request that starts past the window and says it is clipped", () => {
    const bar = barFor(record({ startTime: WINDOW_MS + 500, duration: 100 }));
    expect(bar.clipped).toBe(true);
    expect(bar.left).toBe(1);
    /* Not dropped: the row exists and its duration column is correct, so the waterfall says
       "outside this window" rather than omitting it. */
    expect(bar.width).toBe(0);
  });

  it("never extends past the right edge", () => {
    const bar = barFor(record({ startTime: 2900, duration: 5000 }));
    expect(bar.left + bar.width).toBeLessThanOrEqual(1);
  });
});

describe("phase segments", () => {
  it("derives the three phases from the entry's own timestamps", () => {
    const bar = barFor(record());
    const kinds = bar.segments?.map((segment) => segment.kind);
    expect(kinds).toEqual(["lead", "connect", "wait", "transfer"]);

    const total = 512 - 100;
    const by = Object.fromEntries(bar.segments!.map((s) => [s.kind, s.fraction]));
    expect(by["lead"]).toBeCloseTo(10 / total, 10);
    expect(by["connect"]).toBeCloseTo(20 / total, 10);
    expect(by["wait"]).toBeCloseTo(170 / total, 10);
    expect(by["transfer"]).toBeCloseTo(212 / total, 10);
  });

  it("drops the connect segment on a reused connection instead of inventing one", () => {
    /* `connectStart` is zero when no connection was made — the request inherited one. */
    const bar = barFor(record({ connectStart: 0 }));
    expect(bar.segments?.map((s) => s.kind)).toEqual(["lead", "wait", "transfer"]);
  });

  it("reports no breakdown at all when the browser exposed no phases", () => {
    /* Cross-origin without Timing-Allow-Origin. The ring flags it; the bar must not split
       an unmeasured duration into plausible thirds. */
    const bar = barFor(
      record({ flags: F_NO_PHASES, connectStart: 0, requestStart: 0, responseStart: 0 }),
    );
    expect(bar.segments).toBeNull();
    /* Position and width survive: when the request ran and how long it took are still
       measured, and only the breakdown is missing. */
    expect(bar.left).toBeGreaterThan(0);
    expect(bar.width).toBeGreaterThan(0);
  });

  it("treats a zeroed timestamp as unreported, not as a measurement of zero", () => {
    /* No flag set here — just a `responseStart` the browser never filled in. A zero would
       otherwise produce a wait segment of impossible length. */
    const bar = barFor(record({ responseStart: 0 }));
    expect(bar.segments).toBeNull();
  });

  it("reports an exchange too fast to time as unmeasured rather than as an empty bar", () => {
    const bar = barFor(
      record({
        startTime: 100,
        connectStart: 100,
        requestStart: 100,
        responseStart: 100,
        responseEnd: 100,
        duration: 0,
      }),
    );
    expect(bar.segments).toBeNull();
  });

  it("keeps every fraction within the bar", () => {
    const bar = barFor(record());
    const sum = bar.segments!.reduce((total, segment) => total + segment.fraction, 0);
    expect(sum).toBeLessThanOrEqual(1.000001);
    for (const segment of bar.segments!) expect(segment.fraction).toBeGreaterThan(0);
  });
});
