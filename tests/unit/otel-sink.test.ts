import { beforeEach, describe, expect, it } from "vitest";
import {
  SPAN_CAPACITY,
  createSpanSink,
  readSpan,
  spanCount,
  spanScratch,
  spanStats,
  resetSpanSink,
  type EndedSpan,
} from "../../src/collector/otel-sink";
import { resetIntern } from "../../src/shared/intern";

/**
 * The span sink.
 *
 * The properties under test are the two the tier's honesty rests on: a span that cannot be
 * joined is counted and dropped rather than matched by name, and no `ReadableSpan` survives
 * the callback that received it. Everything else here is arithmetic.
 */

/* A fixed wall-clock origin, so the HrTime conversion is checkable by hand rather than
   against whatever `performance.timeOrigin` happens to be in this process. */
const ORIGIN = 1_700_000_000_000;

function endedSpan(over: Partial<EndedSpan> & { url?: string | null } = {}): EndedSpan {
  const { url, ...rest } = over;
  const attributes =
    url === null ? {} : { "url.full": url ?? "https://app.example.com/api/quote" };
  return {
    name: "GET /api/quote",
    spanContext: () => ({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    }),
    /* 1s and 1.4s after the origin. */
    startTime: [ORIGIN / 1000 + 1, 0],
    endTime: [ORIGIN / 1000 + 1, 400_000_000],
    attributes,
    ...rest,
  };
}

beforeEach(() => {
  resetSpanSink();
  resetIntern();
});

describe("reading a span", () => {
  it("copies the five fields out onto the performance timeline", () => {
    const sink = createSpanSink(ORIGIN);
    sink.onEnd(endedSpan());

    const row = spanScratch();
    expect(readSpan(0, row)).toBe(true);
    expect(row.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(row.spanId).toBe("00f067aa0ba902b7");
    expect(row.url).toBe("https://app.example.com/api/quote");
    /* Wall clock moved onto `performance.now()`'s axis: 1000ms and 1400ms after page start,
       not 1.7 trillion. Getting this wrong yields a join that is off by the age of the page. */
    expect(row.startTime).toBe(1000);
    expect(row.endTime).toBe(1400);
  });

  it("reads http.url when url.full is absent", () => {
    const sink = createSpanSink(ORIGIN);
    sink.onEnd(endedSpan({ attributes: { "http.url": "https://app.example.com/legacy" } }));

    const row = spanScratch();
    expect(readSpan(0, row)).toBe(true);
    expect(row.url).toBe("https://app.example.com/legacy");
  });

  it("prefers url.full over http.url when a span carries both", () => {
    const sink = createSpanSink(ORIGIN);
    sink.onEnd(
      endedSpan({
        attributes: {
          "url.full": "https://app.example.com/new",
          "http.url": "https://app.example.com/old",
        },
      }),
    );

    const row = spanScratch();
    readSpan(0, row);
    expect(row.url).toBe("https://app.example.com/new");
  });

  it("resolves a relative URL against the document, so the join can match it", () => {
    /* A hand-instrumented span often carries `/api/quote`, while the resource entry's `name`
       is always absolute. Left alone the two never match and the panel shows the request
       untraced on a page where the SDK traced it — silently. Found against a real
       `WebTracerProvider`, not reasoned about. */
    const sink = createSpanSink(ORIGIN, "https://app.example.com/shipments/8821");
    sink.onEnd(endedSpan({ url: "/api/quote?leg=2" }));

    const row = spanScratch();
    readSpan(0, row);
    expect(row.url).toBe("https://app.example.com/api/quote?leg=2");
  });

  it("counts a URL attribute that is not a URL at all, rather than storing an unmatchable key", () => {
    const sink = createSpanSink(ORIGIN, "not a base either");
    sink.onEnd(endedSpan({ url: "::::" }));
    expect(spanCount()).toBe(0);
    expect(spanStats().urlless).toBe(1);
  });

  it("reports an unreadable HrTime as -1 rather than as time zero", () => {
    const sink = createSpanSink(ORIGIN);
    sink.onEnd(endedSpan({ endTime: undefined }));

    const row = spanScratch();
    readSpan(0, row);
    /* Zero would render as "ended at page start", which is a measurement. -1 is not. */
    expect(row.endTime).toBe(-1);
  });

  it("returns false for an index past the end", () => {
    const sink = createSpanSink(ORIGIN);
    sink.onEnd(endedSpan());
    expect(readSpan(1, spanScratch())).toBe(false);
    expect(readSpan(-1, spanScratch())).toBe(false);
  });
});

describe("spans that cannot be joined", () => {
  it("counts and drops a span with no URL attribute, never matching it by name", () => {
    const sink = createSpanSink(ORIGIN);
    sink.onEnd(endedSpan({ url: null }));

    expect(spanCount()).toBe(0);
    expect(spanStats().urlless).toBe(1);
    /* The name was `GET /api/quote` and a request to that path exists in every fixture. The
       point of this test is that it was not used. */
    expect(readSpan(0, spanScratch())).toBe(false);
  });

  it("counts and drops a span whose context carries no ids", () => {
    const sink = createSpanSink(ORIGIN);
    sink.onEnd(endedSpan({ spanContext: () => ({}) }));
    expect(spanCount()).toBe(0);
    expect(spanStats().urlless).toBe(1);
  });

  it("survives a span with no spanContext function at all", () => {
    const sink = createSpanSink(ORIGIN);
    const span = endedSpan();
    delete span.spanContext;
    expect(() => sink.onEnd(span)).not.toThrow();
    expect(spanCount()).toBe(0);
  });
});

describe("bounds", () => {
  it("overwrites oldest-first past capacity and reports the loss", () => {
    const sink = createSpanSink(ORIGIN);
    for (let i = 0; i < SPAN_CAPACITY + 4; i += 1) {
      sink.onEnd(endedSpan({ url: `https://app.example.com/api/item/${i}` }));
    }

    expect(spanCount()).toBe(SPAN_CAPACITY);
    expect(spanStats().dropped).toBe(4);

    /* Index 0 is the oldest *retained* span, which is the fifth one written. */
    const row = spanScratch();
    readSpan(0, row);
    expect(row.url).toBe("https://app.example.com/api/item/4");
  });
});

describe("the processor surface", () => {
  it("resolves forceFlush and shutdown immediately, exporting nothing", async () => {
    const sink = createSpanSink(ORIGIN);
    sink.onEnd(endedSpan());
    await expect(sink.forceFlush()).resolves.toBeUndefined();
    await expect(sink.shutdown()).resolves.toBeUndefined();
    /* Shutdown is not a flush-and-clear: the panel still shows what was adopted. */
    expect(spanCount()).toBe(1);
  });

  it("does nothing on start", () => {
    const sink = createSpanSink(ORIGIN);
    sink.onStart();
    expect(spanCount()).toBe(0);
  });
});

describe("retention", () => {
  it("copies every field out, so a span mutated after the callback cannot change the row", () => {
    /* The property that makes this tier free rather than expensive: a `ReadableSpan` holds
       its attributes, links, events and the whole `Resource`, so retaining one retains all
       of it.

       A `WeakRef` would state that directly and was tried first. It is not observable in
       this harness: a probe asserting that a plain, unreferenced object is collected after
       ten `global.gc()` calls fails too, so the assertion would have been measuring vitest,
       not the sink. What is asserted instead is the mechanism that makes retention
       impossible — every field is copied out of the span before the callback returns, and
       the module's whole state is five `TypedArray`s and three counters, none of which can
       hold an object reference at all. Mutating the span afterwards proves the copy. */
    const sink = createSpanSink(ORIGIN);
    const attributes: Record<string, unknown> = { "url.full": "https://app.example.com/one" };
    let ids = { traceId: "a".repeat(32), spanId: "b".repeat(16) };
    const span: EndedSpan = endedSpan({ attributes, spanContext: () => ids });
    sink.onEnd(span);

    attributes["url.full"] = "https://app.example.com/two";
    ids = { traceId: "c".repeat(32), spanId: "d".repeat(16) };
    span.startTime = [ORIGIN / 1000 + 99, 0];

    const row = spanScratch();
    readSpan(0, row);
    expect(row.url).toBe("https://app.example.com/one");
    expect(row.traceId).toBe("a".repeat(32));
    expect(row.spanId).toBe("b".repeat(16));
    expect(row.startTime).toBe(1000);
  });
});
