import { beforeEach, describe, expect, it } from "vitest";
import {
  CAPACITY,
  pushResource,
  read,
  resetRing,
  scratch,
  size,
  stats,
} from "../../src/collector/ring";
import { resetIntern } from "../../src/shared/intern";
import {
  F_CACHED,
  F_CACHE_INFERRED,
  F_NO_PHASES,
  F_STATUS_UNKNOWN,
  F_XHR,
} from "../../src/shared/flags";

/** A resource entry shaped like the browser's, without needing a browser. */
function entry(over: Partial<PerformanceResourceTiming> = {}): PerformanceResourceTiming {
  return {
    name: "https://app.example.com/api/shipments",
    entryType: "resource",
    initiatorType: "fetch",
    startTime: 60,
    duration: 412,
    connectStart: 62,
    requestStart: 90,
    responseStart: 420,
    responseEnd: 472,
    transferSize: 4200,
    encodedBodySize: 3800,
    responseStatus: 200,
    ...over,
  } as PerformanceResourceTiming;
}

describe("ring", () => {
  beforeEach(() => {
    resetIntern();
    resetRing({ statusSupported: true });
  });

  it("round-trips a record", () => {
    pushResource(entry());
    const out = scratch();
    const row = read(0, out);

    expect(row).toBe(out);
    expect(row?.url).toBe("https://app.example.com/api/shipments");
    expect(row?.initiator).toBe("fetch");
    expect(row?.startTime).toBe(60);
    expect(row?.duration).toBe(412);
    expect(row?.status).toBe(200);
  });

  it("copies values rather than retaining the browser's entry", () => {
    const live = entry();
    pushResource(live);
    /* If the ring held a reference, mutating the entry would change what we read back. */
    (live as { startTime: number }).startTime = 99_999;

    const row = read(0, scratch());
    expect(row?.startTime).toBe(60);
  });

  it("does not report a method, because resource entries do not carry one", () => {
    pushResource(entry());
    /* Tier 2 supplies the method later. Until then it is absent, not assumed to be GET. */
    expect(read(0, scratch())?.method).toBe("");
  });

  it("flags XHR requests", () => {
    pushResource(entry({ initiatorType: "xmlhttprequest" }));
    expect((read(0, scratch())?.flags ?? 0) & F_XHR).toBeTruthy();
  });

  it("quotes deliveryType for cache status where the browser reports it", () => {
    resetRing({ statusSupported: true, deliverySupported: true });
    pushResource(entry({ deliveryType: "cache" } as Partial<PerformanceResourceTiming>));
    const flags = read(0, scratch())?.flags ?? 0;
    expect(flags & F_CACHED).toBeTruthy();
    expect(flags & F_CACHE_INFERRED).toBeFalsy();
  });

  it("does not infer a cache hit from sizes when deliveryType says network", () => {
    resetRing({ statusSupported: true, deliverySupported: true });
    /* The shape the old heuristic read as a hit — but the browser says otherwise, and the
       browser is the authority. A 304 produces exactly this. */
    pushResource(
      entry({
        transferSize: 0,
        encodedBodySize: 3800,
        deliveryType: "",
      } as Partial<PerformanceResourceTiming>),
    );
    expect((read(0, scratch())?.flags ?? 0) & F_CACHED).toBeFalsy();
  });

  it("falls back to the size heuristic, marked inferred, where deliveryType is absent", () => {
    resetRing({ statusSupported: true, deliverySupported: false });
    pushResource(entry({ transferSize: 0, encodedBodySize: 3800 }));
    const flags = read(0, scratch())?.flags ?? 0;
    expect(flags & F_CACHED).toBeTruthy();
    expect(flags & F_CACHE_INFERRED).toBeTruthy();
  });

  it("marks a miss as inferred too, so confidence is a property of the source", () => {
    resetRing({ statusSupported: true, deliverySupported: false });
    pushResource(entry());
    const flags = read(0, scratch())?.flags ?? 0;
    expect(flags & F_CACHED).toBeFalsy();
    expect(flags & F_CACHE_INFERRED).toBeTruthy();
  });

  it("flags a cross-origin entry with no phase timings", () => {
    /* No Timing-Allow-Origin: the browser zeroes the phase timestamps. The waterfall must
       draw one undifferentiated bar rather than inventing proportions. */
    pushResource(entry({ requestStart: 0, responseStart: 0 }));
    expect((read(0, scratch())?.flags ?? 0) & F_NO_PHASES).toBeTruthy();
  });

  it("flags an unknown status where the browser does not expose responseStatus", () => {
    resetRing({ statusSupported: false });
    pushResource(entry());
    const row = read(0, scratch());
    expect((row?.flags ?? 0) & F_STATUS_UNKNOWN).toBeTruthy();
    expect(row?.status).toBe(0);
  });

  it("reports out-of-range reads as undefined", () => {
    expect(read(0, scratch())).toBeUndefined();
    pushResource(entry());
    expect(read(1, scratch())).toBeUndefined();
    expect(read(-1, scratch())).toBeUndefined();
  });

  it("keeps records in arrival order", () => {
    for (let i = 0; i < 5; i++) pushResource(entry({ name: `/n/${i}`, startTime: i }));
    const out = scratch();
    const seen = Array.from({ length: size() }, (_, i) => read(i, out)?.startTime);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it("overwrites the oldest record on overflow and counts the loss", () => {
    const extra = 10;
    for (let i = 0; i < CAPACITY + extra; i++) {
      pushResource(entry({ name: `/n/${i}`, startTime: i }));
    }

    expect(size()).toBe(CAPACITY);
    expect(stats().dropped).toBe(extra);
    expect(stats().written).toBe(CAPACITY + extra);

    /* The oldest retained record is the first that survived the overwrite, and the newest
       is the last written — so the window slid rather than the writes being discarded. */
    const out = scratch();
    expect(read(0, out)?.startTime).toBe(extra);
    expect(read(CAPACITY - 1, out)?.startTime).toBe(CAPACITY + extra - 1);
  });

  it("keeps its buffer a fixed size no matter how much traffic it sees", () => {
    const before = stats().capacity;
    for (let i = 0; i < CAPACITY * 4; i++) pushResource(entry({ name: `/n/${i}` }));
    expect(stats().capacity).toBe(before);
    expect(size()).toBe(CAPACITY);
  });
});
