// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { destroy, init } from "../../src/collector/index";
import { settleNow } from "../../src/collector/phase";
import { snapshot } from "../../src/collector/vitals";

/**
 * `destroy()` followed by `init()` must measure the page, not the page plus the toolbar's own
 * history.
 *
 * Every observer registers with `buffered: true`, which is the whole reason the toolbar can
 * mount late and still report a complete page. It is also the reason a second `init()` is
 * dangerous: the browser re-delivers every entry it has ever produced, so a ring that still
 * holds the first copy gets a second, and a CLS session that already contains a shift gets it
 * again. This file replays exactly that.
 *
 * The `PerformanceObserver` here is a stub, and being a stub is the point — the buffered
 * re-delivery is the browser behaviour under test, so the test has to be able to perform it on
 * demand rather than hope for it.
 */

interface StubEntry {
  entryType: string;
  name: string;
  startTime: number;
  duration: number;
  [key: string]: unknown;
}

/** Everything the page has "produced", in delivery order. Replayed on every registration. */
let buffer: StubEntry[] = [];
let registrations: Array<{ type: string; deliver: (entries: StubEntry[]) => void }> = [];

class StubObserver {
  static supportedEntryTypes = [
    "resource",
    "navigation",
    "largest-contentful-paint",
    "layout-shift",
    "event",
    "first-input",
    "visibility-state",
    "long-animation-frame",
  ];

  private deliver: (entries: StubEntry[]) => void;
  private registration: { type: string; deliver: (entries: StubEntry[]) => void } | undefined;

  constructor(callback: (list: { getEntries(): StubEntry[] }) => void) {
    this.deliver = (entries) => callback({ getEntries: () => entries });
  }

  observe(options: { type: string; buffered?: boolean }): void {
    if (!StubObserver.supportedEntryTypes.includes(options.type)) {
      throw new TypeError(`unsupported entry type: ${options.type}`);
    }
    this.registration = { type: options.type, deliver: this.deliver };
    registrations.push(this.registration);
    /* `buffered: true` — the browser delivers the backlog synchronously enough that a test
       may treat it as synchronous; what matters is that it delivers it at all. */
    if (options.buffered) emit(this.registration, buffer);
  }

  disconnect(): void {
    const at = this.registration ? registrations.indexOf(this.registration) : -1;
    if (at !== -1) registrations.splice(at, 1);
    this.registration = undefined;
  }

  takeRecords(): StubEntry[] {
    return [];
  }
}

function emit(
  registration: { type: string; deliver: (entries: StubEntry[]) => void },
  entries: StubEntry[],
): void {
  const mine = entries.filter((entry) => entry.entryType === registration.type);
  if (mine.length > 0) registration.deliver(mine);
}

/** Produces an entry: records it in the page's history, and delivers it to live observers. */
function produce(entry: StubEntry): void {
  buffer.push(entry);
  for (const registration of [...registrations]) emit(registration, [entry]);
}

function resource(name: string, startTime: number): StubEntry {
  return {
    entryType: "resource",
    name,
    startTime,
    duration: 12,
    initiatorType: "fetch",
    responseStatus: 200,
    transferSize: 1024,
    encodedBodySize: 900,
    decodedBodySize: 900,
    deliveryType: "",
    nextHopProtocol: "h2",
    workerStart: 0,
    redirectStart: 0,
    redirectEnd: 0,
    fetchStart: startTime,
    domainLookupStart: startTime,
    domainLookupEnd: startTime,
    connectStart: startTime,
    connectEnd: startTime,
    secureConnectionStart: 0,
    requestStart: startTime,
    responseStart: startTime + 6,
    responseEnd: startTime + 12,
    renderBlockingStatus: "non-blocking",
  };
}

function layoutShift(value: number, startTime: number): StubEntry {
  return {
    entryType: "layout-shift",
    name: "",
    startTime,
    duration: 0,
    value,
    hadRecentInput: false,
    sources: [],
  };
}

let originalObserver: unknown;

beforeEach(() => {
  buffer = [];
  registrations = [];
  originalObserver = (globalThis as Record<string, unknown>)["PerformanceObserver"];
  (globalThis as Record<string, unknown>)["PerformanceObserver"] = StubObserver;
});

afterEach(() => {
  destroy();
  (globalThis as Record<string, unknown>)["PerformanceObserver"] = originalObserver;
});

describe("destroy() then init()", () => {
  it("counts every entry once, despite buffered re-delivery", () => {
    const first = init({ enabled: true, shortcut: false });
    produce(resource("https://example.test/a.js", 10));
    produce(resource("https://example.test/b.css", 20));
    produce(layoutShift(0.05, 30));
    produce(layoutShift(0.02, 40));

    expect(first.diagnostics().requests).toBe(2);
    const before = snapshot();
    expect(before.cls).toBeCloseTo(0.07, 5);

    first.destroy();

    /* The same page, the same history. A browser re-registering here hands back all four. */
    const second = init({ enabled: true, shortcut: false });

    expect(second.diagnostics().requests).toBe(2);
    expect(snapshot().cls).toBeCloseTo(0.07, 5);
  });

  it("starts the phase over, so the second run is not born settled", () => {
    const first = init({ enabled: true, shortcut: false });
    settleNow();
    expect(first.diagnostics().phase).toBe("settled");

    first.destroy();
    expect(init({ enabled: true, shortcut: false }).diagnostics().phase).toBe("collecting");
  });

  it("re-interns the same URL to the same slot, so the table does not grow across runs", () => {
    /* This one passes with every reset removed, and that is worth stating rather than
       hiding: interning is keyed by URL, so a second run of the same page reaches the same
       slots either way. It is here to pin that property — a change making the table grow per
       run would be a leak — not as evidence that `destroy()` resets anything. The two tests
       above are the ones that go red without the resets; both were observed doing so. */
    const first = init({ enabled: true, shortcut: false });
    produce(resource("https://example.test/a.js", 10));
    const interned = first.diagnostics().interned;
    expect(interned).toBeGreaterThan(0);

    first.destroy();
    expect(init({ enabled: true, shortcut: false }).diagnostics().interned).toBe(interned);
  });
});

describe("init() while already running", () => {
  it("throws in development when the configuration differs", () => {
    init({ enabled: true, shortcut: false });
    expect(() => init({ enabled: true, shortcut: "Mod+Shift+9" })).toThrow(
      /different configuration/,
    );
  });

  it("accepts an equivalent configuration silently", () => {
    const first = init({ enabled: true, shortcut: false, sw: {} });
    /* A fresh object literal with identical contents is what a host that reinitialises
       ordinarily passes. It is not a difference. */
    expect(init({ enabled: true, shortcut: false, sw: {} })).toBe(first);
  });
});
