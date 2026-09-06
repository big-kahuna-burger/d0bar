// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { untracedView } from "../../src/panel/views/untraced";
import {
  open,
  resetShell,
  selected,
  tab,
  tier2,
  untracedCount,
  untracedTooltip,
} from "../../src/panel/shell";
import { scratch, type RequestRecord } from "../../src/shared/record";
import type { Tier1Access } from "../../src/shared/stage2";
import { F_HAS_SPAN, F_XHR } from "../../src/shared/flags";

/**
 * The untraced view.
 *
 * What is asserted here is the ladder, not the layout: a real count, a clean page, and a page
 * where tier 2 is off and the whole question cannot be answered are three different screens,
 * and the third must never be rendered as either of the first two. That is the failure mode
 * this tab is one bad line away from — with no worker, nothing carries a trace id d0bar can
 * see, so a naive count reads `11 of 11` on a page that may be perfectly instrumented.
 */

const ORIGIN = "https://app.example.com";
const LIVE = { kind: "live", owner: "d0bar" } as const;

interface FakeRing extends Tier1Access {
  push(over?: Partial<RequestRecord>): void;
  fire(): void;
}

function fakeRing(): FakeRing {
  const slots: RequestRecord[] = [];
  let batch: (() => void) | undefined;

  return {
    push(over: Partial<RequestRecord> = {}) {
      slots.push(
        Object.assign(scratch(), {
          url: `${ORIGIN}/api/item/${slots.length}`,
          method: "GET",
          status: 200,
          ...over,
        }),
      );
    },
    fire: () => batch?.(),
    entries: () => [],
    correlate: () => {},
    spans: () => [],
    adoptSpan: () => {},
    flagConflict: () => {},
    stats: () => ({ written: slots.length, dropped: 0, capacity: 512 }),
    read(index, out) {
      const found = slots[index];
      if (!found) return false;
      Object.assign(out, found);
      return true;
    },
    onBatch(fn) {
      batch = fn;
      return () => {
        batch = undefined;
      };
    },
    onVisibility: () => () => {},
    visible: () => true,
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

let frames: Array<() => void> = [];

function flush(): void {
  for (let i = 0; i < 4 && frames.length > 0; i += 1) {
    const pending = frames;
    frames = [];
    for (const frame of pending) frame();
  }
}

function mount(ring: FakeRing, seen: ReadonlySet<number> = new Set()) {
  const handle = untracedView({ tier1: ring, origin: ORIGIN, seen: () => seen });
  document.body.appendChild(handle.el);
  return handle;
}

function textOf(root: HTMLElement, selector: string): string {
  return root.querySelector(selector)?.textContent?.trim() ?? "";
}

function cards(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".ucard")].filter((card) => !card.hidden);
}

beforeEach(() => {
  resetShell();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  document.body.replaceChildren();
  open.set(true);
  tab.set("untraced");
  tier2.set(LIVE);
});

describe("the headline", () => {
  it("counts untraced against the total", () => {
    const ring = fakeRing();
    ring.push({ flags: F_HAS_SPAN });
    ring.push();
    ring.push({ flags: F_XHR });
    const handle = mount(ring);
    ring.fire();
    flush();

    expect(textOf(handle.el, ".coverage-count")).toBe("2 of 3");
    expect(textOf(handle.el, ".coverage-detail")).toContain("produced no span");
    handle.destroy();
  });

  it("says every request produced a span rather than showing an empty screen", () => {
    const ring = fakeRing();
    ring.push({ flags: F_HAS_SPAN });
    const handle = mount(ring);
    ring.fire();
    flush();

    expect(textOf(handle.el, ".coverage-count")).toBe("0 of 1");
    expect((handle.el.querySelector(".coverage-count") as HTMLElement).dataset["kind"]).toBe(
      "clean",
    );
    expect(textOf(handle.el, ".coverage-detail")).toBe(
      "Every request on this page produced a span.",
    );
    handle.destroy();
  });

  it("states that coverage is unknown when tier 2 is off, and shows no cards", () => {
    /* The whole reason this state exists. `3 of 3` here would be an artefact of the worker
       being absent, presented as a finding about the host's instrumentation. */
    tier2.set({ kind: "off", reason: "not-registered" });
    const ring = fakeRing();
    for (let i = 0; i < 3; i += 1) ring.push();
    const handle = mount(ring);
    ring.fire();
    flush();

    const count = handle.el.querySelector(".coverage-count") as HTMLElement;
    expect(count.dataset["kind"]).toBe("undeterminable");
    expect(count.textContent).toBe("coverage unknown");
    expect(textOf(handle.el, ".coverage-detail")).toContain("not a report of zero gaps");
    expect(cards(handle.el)).toHaveLength(0);
    handle.destroy();
  });
});

describe("the cards", () => {
  it("gives each gap its own cause, not one shared 'missing'", () => {
    const ring = fakeRing();
    ring.push({ flags: F_XHR });
    ring.push({ url: "https://cdn.other.example/lib.js" });
    ring.push();
    const handle = mount(ring, new Set([2]));
    ring.fire();
    flush();

    const painted = cards(handle.el);
    expect(painted.map((card) => card.dataset["cause"])).toEqual([
      "transport-xhr",
      "third-party",
      "not-propagated",
    ]);
    /* Three different sentences, because they have three different fixes. */
    const sentences = new Set(painted.map((card) => textOf(card, ".ucause")));
    expect(sentences.size).toBe(3);
    handle.destroy();
  });

  it("names no configuration file d0bar cannot read", () => {
    /* The spec asked for a cause worded as "outside your propagator match list". d0bar does
       not read the host's SDK config, so that copy would be a plausible explanation rather
       than an observation — the same copy `add-trace-view` rejected. */
    const ring = fakeRing();
    ring.push();
    const handle = mount(ring, new Set([0]));
    ring.fire();
    flush();

    const text = handle.el.textContent ?? "";
    expect(text).not.toContain("PropagatorConfig");
    expect(text).not.toContain("match list");
    handle.destroy();
  });

  it("selects the request and returns to the list when a card is clicked", () => {
    const ring = fakeRing();
    ring.push({ flags: F_HAS_SPAN });
    ring.push();
    const handle = mount(ring);
    ring.fire();
    flush();

    cards(handle.el)[0]!.dispatchEvent(new Event("click", { bubbles: true }));
    /* The ring index, not the card index — the gap was the second record. */
    expect(selected()).toBe(1);
    expect(tab()).toBe("requests");
    handle.destroy();
  });
});

describe("the badge and the tooltip", () => {
  it("comes from the same reading as the headline", () => {
    const ring = fakeRing();
    ring.push({ flags: F_HAS_SPAN });
    ring.push();
    const handle = mount(ring);
    ring.fire();
    flush();

    expect(untracedCount()).toBe(1);
    expect(untracedTooltip()).toBe("1 of 2 requests on this page produced no span.");
    handle.destroy();
  });

  it("reports zero and says why when coverage cannot be determined", () => {
    tier2.set({ kind: "off", reason: "not-registered" });
    const ring = fakeRing();
    ring.push();
    const handle = mount(ring);
    ring.fire();
    flush();

    /* Zero so the badge hides — but the tooltip must not let that read as "no gaps". */
    expect(untracedCount()).toBe(0);
    expect(untracedTooltip()).toBe("Coverage cannot be determined while tier 2 is off.");
    handle.destroy();
  });

  it("keeps counting while another tab is showing", () => {
    /* The badge is on the tab, so it has to be right before anyone opens it. */
    const ring = fakeRing();
    const handle = mount(ring);
    tab.set("requests");
    ring.push();
    ring.push();
    ring.fire();
    flush();

    expect(untracedCount()).toBe(2);
    /* And no DOM work happened while nobody was looking. */
    expect(cards(handle.el)).toHaveLength(0);
    handle.destroy();
  });

  it("does nothing at all while the panel is closed", () => {
    open.set(false);
    const ring = fakeRing();
    const handle = mount(ring);
    ring.push();
    ring.fire();
    flush();

    expect(untracedCount()).toBe(0);
    expect(cards(handle.el)).toHaveLength(0);
    handle.destroy();
  });
});
