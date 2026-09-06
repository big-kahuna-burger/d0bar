// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { vitalsView } from "../../src/panel/views/vitals";
import { open, resetShell, tab, view } from "../../src/panel/shell";
import type { Tier1Access, VitalsReading } from "../../src/shared/stage2";

/**
 * The vitals view, driven against a fake accumulator.
 *
 * What is asserted here is the behaviour no typechecker would catch: that a closed panel, a
 * different tab and a hidden document all cost nothing, that repaints coalesce to one frame,
 * and that a browser which reports no LCP is shown as reporting none rather than as zero.
 */

const ALL_TYPES = ["largest-contentful-paint", "layout-shift", "event", "long-animation-frame"];

interface FakeTier1 extends Tier1Access {
  set(over: Partial<VitalsReading>): void;
  fire(): void;
  setVisible(next: boolean): void;
  reads(): number;
}

function fakeTier1(): FakeTier1 {
  let reading: VitalsReading = {
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
    entryTypes: ALL_TYPES,
  };
  let visible = true;
  let reads = 0;
  let batch: (() => void) | undefined;
  let onVisible: ((visible: boolean) => void) | undefined;

  return {
    set(over) {
      reading = { ...reading, ...over };
    },
    fire: () => batch?.(),
    setVisible(next) {
      visible = next;
      onVisible?.(next);
    },
    reads: () => reads,
    entries: () => [],
    correlate: () => {},
    /* Tier 4's side of the boundary. Not exercised here, but the boundary is one interface —
       stubbed rather than cast away so a change to it fails in this file. */
    spans: () => [],
    adoptSpan: () => {},
    flagConflict: () => {},
    stats: () => ({ written: 0, dropped: 0, capacity: 0 }),
    read: () => false,
    onBatch: () => () => {},
    onVisibility(fn) {
      onVisible = fn;
      return () => {
        onVisible = undefined;
      };
    },
    visible: () => visible,
    vitals() {
      reads += 1;
      return reading;
    },
    onVitals(fn) {
      batch = fn;
      return () => {
        batch = undefined;
      };
    },
  };
}

let frames: Array<() => void> = [];

function flush(): void {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame();
}

function mount(tier1: FakeTier1) {
  const instance = vitalsView({ tier1 });
  document.body.appendChild(instance.el);
  return instance;
}

function values(el: HTMLElement): string[] {
  return [...el.querySelectorAll<HTMLElement>(".vvalue")].map((n) => n.textContent ?? "");
}

function tones(el: HTMLElement): Array<string | undefined> {
  return [...el.querySelectorAll<HTMLElement>(".vvalue")].map((n) => n.dataset["tone"]);
}

function attributions(el: HTMLElement): string[] {
  return [...el.querySelectorAll<HTMLElement>(".vattr")].map((n) => n.textContent ?? "");
}

beforeEach(() => {
  document.body.innerHTML = "";
  frames = [];
  resetShell();
  open.set(true);
  tab.set("vitals");
  view.set("list");
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

describe("painting", () => {
  it("renders the four cards from the browser's reading", () => {
    const tier1 = fakeTier1();
    tier1.set({
      lcp: 4530,
      lcpElement: "img.hero-map",
      ttfb: 1900,
      cls: 0.04,
      clsSource: "div.rate-table",
      inp: 112,
      inpTarget: "button.confirm-hold",
      inpTargetIsScored: true,
      loafCount: 3,
      loafLongest: 84,
      loafScript: "renderQuote",
    });
    const instance = mount(tier1);

    expect(values(instance.el)).toEqual(["4.53s", "0.04", "112ms", "3"]);
    expect(tones(instance.el)).toEqual(["error", "healthy", "healthy", "neutral"]);
    expect(attributions(instance.el)).toEqual([
      "element: img.hero-map · TTFB 1.90s",
      "largest shift: div.rate-table",
      "target: button.confirm-hold",
      "longest 84ms · renderQuote",
    ]);
  });

  it("shows an unreported vital as unreported, never as zero", () => {
    const instance = mount(fakeTier1());
    expect(values(instance.el)[0]).toBe("not reported");
    expect(tones(instance.el)[0]).toBe("unknown");
    expect(values(instance.el)[0]).not.toContain("0");
  });

  it("states which entry type a browser does not support", () => {
    const tier1 = fakeTier1();
    tier1.set({ entryTypes: ["largest-contentful-paint", "layout-shift", "event"] });
    const instance = mount(tier1);
    expect(values(instance.el)[3]).toBe("unsupported");
    expect(attributions(instance.el)[3]).toBe(
      "This browser reports no long-animation-frame entries.",
    );
  });

  it("carries the provenance note, naming the browser as the source", () => {
    const instance = mount(fakeTier1());
    const note = instance.el.querySelector(".vnote")?.textContent ?? "";
    expect(note).toBe(
      "Every number here is read from the browser's own PerformanceObserver entries: LCP, " +
        "layout-shift, event and long-animation-frame, with attribution. d0bar records " +
        "nothing itself.",
    );
    expect(instance.el.querySelector(".vnote-api")?.textContent).toBe("PerformanceObserver");
  });
});

describe("nothing paints while nobody is looking", () => {
  it("drops a batch while the panel is closed", () => {
    const tier1 = fakeTier1();
    const instance = mount(tier1);
    const before = tier1.reads();

    open.set(false);
    tier1.set({ lcp: 4530 });
    tier1.fire();
    flush();

    expect(tier1.reads()).toBe(before);
    expect(values(instance.el)[0]).toBe("not reported");
  });

  it("drops a batch while another tab is showing", () => {
    const tier1 = fakeTier1();
    const instance = mount(tier1);
    const before = tier1.reads();

    tab.set("requests");
    tier1.set({ lcp: 4530 });
    tier1.fire();
    flush();

    expect(tier1.reads()).toBe(before);
    expect(values(instance.el)[0]).toBe("not reported");
  });

  it("drops a batch while the document is hidden", () => {
    const tier1 = fakeTier1();
    const instance = mount(tier1);
    tier1.setVisible(false);
    const before = tier1.reads();

    tier1.set({ lcp: 4530 });
    tier1.fire();
    flush();

    expect(tier1.reads()).toBe(before);
    expect(values(instance.el)[0]).toBe("not reported");
  });

  it("catches up in one paint when the document becomes visible again", () => {
    const tier1 = fakeTier1();
    const instance = mount(tier1);
    tier1.setVisible(false);
    tier1.set({ lcp: 4530, lcpElement: "img.hero" });
    tier1.fire();
    flush();

    tier1.setVisible(true);
    flush();
    expect(values(instance.el)[0]).toBe("4.53s");
  });

  it("catches up on tab entry without waiting for the next entry", () => {
    const tier1 = fakeTier1();
    tab.set("requests");
    const instance = mount(tier1);
    tier1.set({ lcp: 4530 });

    tab.set("vitals");
    instance.refresh();
    expect(values(instance.el)[0]).toBe("4.53s");
  });
});

describe("repaints coalesce", () => {
  it("collapses a burst of batches into a single frame", () => {
    const tier1 = fakeTier1();
    mount(tier1);
    const before = tier1.reads();

    for (let i = 0; i < 20; i += 1) tier1.fire();
    expect(frames.length).toBe(1);
    flush();
    expect(tier1.reads()).toBe(before + 1);
  });

  it("does not paint if the tab changed between the request and the frame", () => {
    const tier1 = fakeTier1();
    const instance = mount(tier1);
    tier1.set({ lcp: 4530 });
    tier1.fire();
    tab.set("requests");
    flush();
    expect(values(instance.el)[0]).toBe("not reported");
  });
});

describe("teardown", () => {
  it("unsubscribes and removes its node", () => {
    const tier1 = fakeTier1();
    const instance = mount(tier1);
    instance.destroy();
    const after = tier1.reads();

    tier1.fire();
    flush();
    expect(tier1.reads()).toBe(after);
    expect(instance.el.isConnected).toBe(false);
  });
});
