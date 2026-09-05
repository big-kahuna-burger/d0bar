import { beforeEach, describe, expect, it } from "vitest";
import { join, joinSpans, type SpanEntry, type Tier1Entry } from "../../src/collector/join";
import { resetIntern } from "../../src/shared/intern";
import type { FetchRecord } from "../../src/sw/protocol";

/**
 * The tier 1 ↔ tier 2 join.
 *
 * Driven from recorded pairs of dumps rather than a browser: the whole point of keeping the
 * join pure is that its awkward cases — duplicates, concurrency, a counterpart missing on
 * either side — can be constructed directly instead of provoked.
 *
 * The property under test throughout is that neither source overwrites the other's fields,
 * and that an ordering the join cannot vouch for is reported as such rather than resolved by
 * guessing.
 */

const TRACE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRACE_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function tier1(url: string, index: number, startTime: number): Tier1Entry {
  return { index, url, startTime };
}

function tier2(url: string, order: number, traceId = "", method = "GET"): FetchRecord {
  return {
    order,
    url,
    method,
    at: 1_000 + order,
    traceId,
    spanId: traceId ? "00f067aa0ba902b7" : "",
    sampled: Boolean(traceId),
    destination: "empty",
  };
}

beforeEach(() => {
  /* The interning table is process-global and the join keys on it, so a leaked table from a
     previous test would silently change which ids collide. */
  resetIntern();
});

describe("matching", () => {
  it("joins one entry to one record", () => {
    const result = join(
      [tier1("https://x.test/a", 0, 10)],
      [tier2("https://x.test/a", 0, TRACE_A, "POST")],
    );

    expect(result.matched.get(0)).toEqual({
      traceId: TRACE_A,
      spanId: "00f067aa0ba902b7",
      sampled: true,
      method: "POST",
      confident: true,
    });
    expect(result.unjoined).toEqual([]);
  });

  it("keeps distinct URLs in their own queues", () => {
    const result = join(
      [tier1("https://x.test/a", 0, 10), tier1("https://x.test/b", 1, 20)],
      [tier2("https://x.test/b", 0, TRACE_B), tier2("https://x.test/a", 1, TRACE_A)],
    );

    expect(result.matched.get(0)?.traceId).toBe(TRACE_A);
    expect(result.matched.get(1)?.traceId).toBe(TRACE_B);
    expect(result.matched.get(0)?.confident).toBe(true);
  });

  it("pops repeats of one URL in issue order", () => {
    /* Tier 1 is in completion order and tier 2 in issue order. The entries are handed over
       deliberately out of start order to prove the join sorts them rather than trusting the
       array it was given. */
    const result = join(
      [tier1("https://x.test/a", 5, 300), tier1("https://x.test/a", 4, 100)],
      [tier2("https://x.test/a", 0, TRACE_A), tier2("https://x.test/a", 1, TRACE_B)],
    );

    expect(result.matched.get(4)?.traceId).toBe(TRACE_A);
    expect(result.matched.get(5)?.traceId).toBe(TRACE_B);
  });
});

describe("confidence", () => {
  it("flags every join of a URL that had a sibling in flight", () => {
    const result = join(
      [tier1("https://x.test/a", 0, 10), tier1("https://x.test/a", 1, 12)],
      [tier2("https://x.test/a", 0, TRACE_A), tier2("https://x.test/a", 1, TRACE_B)],
    );

    /* Both, not just the second: issue order and completion order can disagree for either
       of them, so neither trace id may be presented as certain. */
    expect(result.matched.get(0)?.confident).toBe(false);
    expect(result.matched.get(1)?.confident).toBe(false);
  });

  it("does not flag a URL that merely appears twice in sequence", () => {
    const single = join(
      [tier1("https://x.test/a", 0, 10)],
      [tier2("https://x.test/a", 0, TRACE_A)],
    );
    expect(single.matched.get(0)?.confident).toBe(true);
  });
});

describe("missing counterparts", () => {
  it("retains a worker record tier 1 never saw", () => {
    /* The un-instrumented request: the page cannot see it at all, so discarding it here
       would throw away the one diagnostic tier 2 uniquely provides. */
    const result = join([], [tier2("https://x.test/invisible", 0, "", "POST")]);

    expect(result.matched.size).toBe(0);
    expect(result.unjoined).toHaveLength(1);
    expect(result.unjoined[0]?.url).toBe("https://x.test/invisible");
  });

  it("leaves a tier 1 entry uncorrelated when the worker never saw it", () => {
    /* Everything before the worker claimed the scope lands here. Tier 1's `buffered: true`
       is what makes those entries exist at all, and they stay exactly as tier 1 recorded
       them — no invented method, no invented trace. */
    const result = join([tier1("https://x.test/early", 3, 5)], []);

    expect(result.matched.size).toBe(0);
    expect(result.unjoined).toEqual([]);
  });

  it("returns leftovers in issue order", () => {
    const result = join(
      [],
      [
        tier2("https://x.test/b", 2),
        tier2("https://x.test/a", 0),
        tier2("https://x.test/c", 1),
      ],
    );
    expect(result.unjoined.map((r) => r.order)).toEqual([0, 1, 2]);
  });
});

describe("records without a traceparent", () => {
  it("still carries the method tier 1 cannot see", () => {
    /* The browser reports no method on a resource entry, so this is the only source of it.
       A record with no traceparent is still worth joining for that reason alone. */
    const result = join(
      [tier1("https://x.test/a", 0, 10)],
      [tier2("https://x.test/a", 0, "", "DELETE")],
    );

    expect(result.matched.get(0)).toMatchObject({ method: "DELETE", traceId: "" });
  });
});

function span(url: string, order: number, traceId: string): SpanEntry {
  return { url, order, traceId, spanId: `span-${order}` };
}

describe("the tier 1 <-> tier 4 join", () => {
  it("matches a span to the entry with the same URL", () => {
    const result = joinSpans(
      [tier1("https://app.example.com/api/quote", 0, 100)],
      [span("https://app.example.com/api/quote", 0, TRACE_A)],
    );
    expect(result.matched.get(0)).toEqual({
      traceId: TRACE_A,
      spanId: "span-0",
      confident: true,
    });
    expect(result.unjoined).toHaveLength(0);
  });

  it("supplies identity and nothing else", () => {
    /* The result type has no field for a timing, a status or a size, so tier 4 cannot
       overwrite a number the browser measured. Asserted on the shape rather than trusted to
       the type, because the type is what a future change would edit. */
    const result = joinSpans(
      [tier1("https://app.example.com/a", 0, 100)],
      [span("https://app.example.com/a", 0, TRACE_A)],
    );
    expect(Object.keys(result.matched.get(0)!).sort()).toEqual([
      "confident",
      "spanId",
      "traceId",
    ]);
  });

  it("flags an ambiguous match rather than resolving it", () => {
    /* Two spans on one URL in one flush: issue order and completion order diverge exactly
       when requests overlap, so the pairing is a guess and says so. */
    const result = joinSpans(
      [tier1("https://app.example.com/a", 0, 100), tier1("https://app.example.com/a", 1, 110)],
      [span("https://app.example.com/a", 0, TRACE_A), span("https://app.example.com/a", 1, TRACE_B)],
    );
    expect(result.matched.get(0)?.confident).toBe(false);
    expect(result.matched.get(1)?.confident).toBe(false);
  });

  it("retains a span with no tier 1 counterpart instead of dropping it", () => {
    /* A span the resource timeline never saw is a real observation — an SDK-instrumented
       request the page cannot see. Dropping it would make tier 4 look like it found less
       than it did. */
    const result = joinSpans(
      [tier1("https://app.example.com/a", 0, 100)],
      [span("https://app.example.com/a", 0, TRACE_A), span("https://app.example.com/gone", 1, TRACE_B)],
    );
    expect(result.matched.size).toBe(1);
    expect(result.unjoined.map((s) => s.url)).toEqual(["https://app.example.com/gone"]);
  });

  it("pops in issue order across entries sorted by start time", () => {
    /* The ring is in completion order; the FIFO pops in issue order. Sorting the entries is
       what keeps the two lined up as closely as the sources allow. */
    const result = joinSpans(
      [tier1("https://app.example.com/a", 0, 200), tier1("https://app.example.com/a", 1, 100)],
      [span("https://app.example.com/a", 0, TRACE_A), span("https://app.example.com/a", 1, TRACE_B)],
    );
    /* Index 1 started first, so it takes the first span. */
    expect(result.matched.get(1)?.traceId).toBe(TRACE_A);
    expect(result.matched.get(0)?.traceId).toBe(TRACE_B);
  });

  it("returns nothing at all when there are no spans, which is the ordinary page", () => {
    const result = joinSpans([tier1("https://app.example.com/a", 0, 100)], []);
    expect(result.matched.size).toBe(0);
    expect(result.unjoined).toHaveLength(0);
  });
});
