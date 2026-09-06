import { describe, expect, it } from "vitest";
import { MAX_GAPS, classify, coverage, type Cause } from "../../src/collector/coverage";
import { F_HAS_SPAN, F_XHR } from "../../src/shared/flags";
import { scratch, type RequestRecord } from "../../src/shared/record";

/**
 * Coverage classification.
 *
 * The property under test is that every cause is an observation. There is no test here for a
 * propagator match list, because d0bar does not read one — the tab reports that the worker
 * saw a request with no `traceparent` on it, and leaves the reason to the host, who is the
 * only one who can know it.
 */

const ORIGIN = "https://app.example.com";

function record(over: Partial<RequestRecord> = {}): RequestRecord {
  return Object.assign(scratch(), { url: `${ORIGIN}/api/quote`, ...over });
}

function ring(records: RequestRecord[]) {
  return {
    count: records.length,
    read(index: number, out: RequestRecord) {
      const found = records[index];
      if (!found) return false;
      Object.assign(out, found);
      return true;
    },
    scratch: scratch(),
    origin: ORIGIN,
    seen: new Set<number>(),
    determinable: true,
  };
}

describe("classifying one request", () => {
  const cases: Array<[string, RequestRecord, boolean, Cause]> = [
    ["an XHR, whatever else is true of it", record({ flags: F_XHR }), true, "transport-xhr"],
    ["a stylesheet the parser fetched", record({ initiator: "css" }), true, "subresource"],
    [
      "a script tag",
      record({ url: `${ORIGIN}/app.js`, initiator: "script" }),
      false,
      "subresource",
    ],
    [
      "a cross-origin fetch",
      record({ url: "https://cdn.other.example/lib.js" }),
      false,
      "third-party",
    ],
    ["a same-origin fetch the worker read and found bare", record(), true, "not-propagated"],
    ["a same-origin fetch the worker never saw", record(), false, "unseen"],
    ["a URL with no parseable origin", record({ url: "blob:whatever" }), true, "unknown"],
  ];

  for (const [name, input, seen, expected] of cases) {
    it(`calls ${name} ${expected}`, () => {
      expect(classify(input, ORIGIN, seen)).toBe(expected);
    });
  }

  it("does not call a subresource an instrumentation gap", () => {
    /* Found by looking at the rendered tab: the first four cards were `/metrics.js`,
       `/app.css`, `/app.js` and d0bar's own bundle. Every one of them is true — the worker
       saw it, no traceparent — and every one of them is unactionable, because no SDK can
       put trace context on a request the parser issued. */
    const css = record({ url: `${ORIGIN}/app.css`, initiator: "css" });
    expect(classify(css, ORIGIN, true)).toBe("subresource");
    /* And a fetch to the same URL still is one. The initiator is the browser's word for who
       issued it; the extension is a guess. */
    expect(
      classify(record({ url: `${ORIGIN}/app.css`, initiator: "fetch" }), ORIGIN, true),
    ).toBe("not-propagated");
  });

  it("keeps an XHR ahead of the subresource check", () => {
    /* `initiatorType` for an XHR is `xmlhttprequest`, which is not in the set — but the
       ordering is asserted rather than assumed, because reversing it would silently reclassify
       every XHR the day a value is added to that set. */
    const xhr = record({ initiator: "xmlhttprequest", flags: F_XHR });
    expect(classify(xhr, ORIGIN, true)).toBe("transport-xhr");
  });

  it("puts transport ahead of origin, because it is the more actionable finding", () => {
    /* A cross-origin XHR is both. Reporting it as third-party would send the reader to a
       match list when the actual answer is that their instrumentation does not cover XHR. */
    const both = record({ url: "https://cdn.other.example/data", flags: F_XHR });
    expect(classify(both, ORIGIN, false)).toBe("transport-xhr");
  });
});

describe("the reading as a whole", () => {
  it("counts only records with no span", () => {
    const result = coverage(
      ring([
        record({ flags: F_HAS_SPAN }),
        record({ url: `${ORIGIN}/api/a` }),
        record({ url: `${ORIGIN}/api/b`, flags: F_XHR }),
      ]),
    );
    expect(result).toMatchObject({ determinable: true, total: 3, untraced: 2 });
    expect(result.gaps.map((gap) => gap.cause)).toEqual(["unseen", "transport-xhr"]);
  });

  it("says every request produced a span rather than reporting nothing", () => {
    const result = coverage(ring([record({ flags: F_HAS_SPAN })]));
    expect(result).toMatchObject({ determinable: true, total: 1, untraced: 0 });
    expect(result.gaps).toHaveLength(0);
  });

  it("reports coverage as undeterminable when tier 2 is off, rather than as total failure", () => {
    /* The failure this flag exists to prevent: with no worker, nothing carries a trace id
       d0bar can see, so every request would classify as a gap and the tab would read
       `3 of 3` on a page that may be perfectly instrumented. */
    const result = coverage({ ...ring([record(), record(), record()]), determinable: false });
    expect(result).toMatchObject({ determinable: false, untraced: 0 });
    expect(result.gaps).toHaveLength(0);
    /* The total is still real — it is the one number that does not depend on tier 2. */
    expect(result.total).toBe(3);
  });

  it("counts past the card cap but stops listing", () => {
    const many = Array.from({ length: MAX_GAPS + 7 }, (_, i) =>
      record({ url: `${ORIGIN}/api/item/${i}` }),
    );
    const result = coverage(ring(many));
    expect(result.untraced).toBe(MAX_GAPS + 7);
    expect(result.gaps).toHaveLength(MAX_GAPS);
  });

  it("carries the ring index, so a card can open the request it came from", () => {
    const result = coverage(ring([record({ flags: F_HAS_SPAN }), record()]));
    expect(result.gaps[0]?.index).toBe(1);
  });

  it("marks a request the worker did see as not-propagated", () => {
    const input = { ...ring([record()]), seen: new Set([0]) };
    expect(coverage(input).gaps[0]?.cause).toBe("not-propagated");
  });
});
