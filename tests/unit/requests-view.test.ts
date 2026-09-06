// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestsView } from "../../src/panel/views/requests";
import { open, resetShell, selected, tab, view } from "../../src/panel/shell";
import { ROW_HEIGHT } from "../../src/panel/virtual";
import { scratch, type RequestRecord } from "../../src/shared/record";
import type { Tier1Access } from "../../src/shared/stage2";
import { F_HAS_SPAN } from "../../src/shared/flags";

/**
 * The requests view, driven against a fake ring.
 *
 * Everything asserted here is behaviour the spec states in prose and that no amount of
 * typechecking would catch: that appending does not move the user, that a record falling off
 * the front of the ring does not silently reselect a different request, and that a closed
 * panel costs nothing. The fake ring is deliberately tiny (capacity 8) so overflow is
 * reachable in a test rather than after five hundred appends.
 */

const ORIGIN = "https://app.example.com";
const CAPACITY = 8;

interface FakeRing extends Tier1Access {
  push(over?: Partial<RequestRecord>): void;
  fire(): void;
  setVisible(next: boolean): void;
}

function fakeRing(): FakeRing {
  const slots: RequestRecord[] = [];
  let written = 0;
  let dropped = 0;
  let visible = true;
  let batch: (() => void) | undefined;
  let onVisible: ((visible: boolean) => void) | undefined;

  return {
    push(over: Partial<RequestRecord> = {}) {
      const record = Object.assign(scratch(), {
        startTime: written * 10,
        duration: 100 + written,
        connectStart: written * 10 + 1,
        requestStart: written * 10 + 2,
        responseStart: written * 10 + 40,
        responseEnd: written * 10 + 100,
        url: `${ORIGIN}/api/item/${written}`,
        method: "GET",
        status: 200,
        flags: F_HAS_SPAN,
      });
      slots.push(Object.assign(record, over));
      written += 1;
      if (slots.length > CAPACITY) {
        slots.shift();
        dropped += 1;
      }
    },
    fire: () => batch?.(),
    setVisible(next: boolean) {
      visible = next;
      onVisible?.(next);
    },
    entries: () => [],
    correlate: () => {},
    /* Tier 4's side of the boundary. Not exercised here, but the boundary is one interface —
       stubbed rather than cast away so a change to it fails in this file. */
    spans: () => [],
    adoptSpan: () => {},
    flagConflict: () => {},
    stats: () => ({ written, dropped, capacity: CAPACITY }),
    read(index, out) {
      const record = slots[index];
      if (!record) return false;
      Object.assign(out, record);
      return true;
    },
    onBatch(fn) {
      batch = fn;
      return () => {
        batch = undefined;
      };
    },
    onVisibility(fn) {
      onVisible = fn;
      return () => {
        onVisible = undefined;
      };
    },
    visible: () => visible,
    /* The requests view reads neither, but the boundary is one interface. Stubbed as an
       empty reading rather than cast away, so a field added to `VitalsReading` fails here
       instead of being silently absent. */
    vitals: () => ({
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

function mount(ring: FakeRing) {
  const view = requestsView({ tier1: ring, origin: ORIGIN });
  document.body.appendChild(view.el);
  const scroller = view.el.querySelector(".rows-scroll") as HTMLElement;
  Object.defineProperty(scroller, "clientHeight", { value: 105, configurable: true });
  return { view, scroller };
}

function rows(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(".row")].filter((row) => !row.hidden);
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
  tab.set("requests");
});

describe("rendering", () => {
  it("renders one row per record, oldest first", () => {
    const ring = fakeRing();
    for (let i = 0; i < 5; i += 1) ring.push();
    const { view, scroller } = mount(ring);
    ring.fire();
    flush();

    const painted = rows(scroller);
    expect(painted.length).toBe(5);
    expect(painted[0]!.querySelector(".path")!.textContent).toBe("/api/item/0");
    expect(painted[4]!.querySelector(".path")!.textContent).toBe("/api/item/4");
    view.destroy();
  });

  it("writes the bar's geometry as custom properties on the row", () => {
    const ring = fakeRing();
    ring.push({ startTime: 600, duration: 300 });
    const { view, scroller } = mount(ring);
    ring.fire();
    flush();

    const row = rows(scroller)[0]!;
    expect(row.style.getPropertyValue("--l")).toBe("0.2");
    expect(row.style.getPropertyValue("--w")).toBe("0.1");
    view.destroy();
  });

  it("says so when the buffer dropped records rather than showing a short list as complete", () => {
    const ring = fakeRing();
    for (let i = 0; i < CAPACITY + 3; i += 1) ring.push();
    const { view } = mount(ring);
    ring.fire();
    flush();

    const notice = view.el.querySelector(".rows-dropped") as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("3 earlier requests dropped");
    view.destroy();
  });

  it("creates no row at all while the panel is closed", () => {
    const ring = fakeRing();
    for (let i = 0; i < 5; i += 1) ring.push();
    open.set(false);
    const { view, scroller } = mount(ring);
    ring.fire();
    flush();

    expect(scroller.querySelectorAll(".row").length).toBe(0);
    view.destroy();
  });

  it("creates no row at all while the document is hidden", () => {
    const ring = fakeRing();
    for (let i = 0; i < 5; i += 1) ring.push();
    ring.setVisible(false);
    const { view, scroller } = mount(ring);
    ring.fire();
    flush();
    expect(scroller.querySelectorAll(".row").length).toBe(0);

    /* And catches up in one repaint on the way back, rather than waiting for a request that
       may never arrive on a page that has gone quiet. */
    ring.setVisible(true);
    flush();
    expect(rows(scroller).length).toBe(5);
    view.destroy();
  });
});

describe("streaming", () => {
  it("does not move the viewport when records are appended", () => {
    const ring = fakeRing();
    for (let i = 0; i < CAPACITY; i += 1) ring.push();
    const { view, scroller } = mount(ring);
    ring.fire();
    flush();

    scroller.scrollTop = 2 * ROW_HEIGHT;
    ring.push();
    ring.push();
    ring.fire();
    flush();

    /* Two records arrived and two fell off the front, so the rows the user was looking at
       moved up by two — and the offset moved with them. */
    expect(scroller.scrollTop).toBe(0);
    view.destroy();
  });

  it("keeps the selection on the same request as the ring's base advances", () => {
    const ring = fakeRing();
    for (let i = 0; i < CAPACITY; i += 1) ring.push();
    const { view, scroller } = mount(ring);
    ring.fire();
    flush();

    rows(scroller)[5]!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(selected()).toBe(5);

    ring.push();
    ring.fire();
    flush();
    /* Same request, one row higher. Leaving the index alone would have quietly moved the
       selection to its neighbour. */
    expect(selected()).toBe(4);
    view.destroy();
  });

  it("drops the selection when the selected record falls out of the buffer", () => {
    const ring = fakeRing();
    for (let i = 0; i < CAPACITY; i += 1) ring.push();
    const { view, scroller } = mount(ring);
    ring.fire();
    flush();

    rows(scroller)[0]!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(selected()).toBe(0);

    ring.push();
    ring.fire();
    flush();
    /* The record is gone. `-1` says so; keeping the index would have pointed it at whatever
       record inherited slot zero. */
    expect(selected()).toBe(-1);
    view.destroy();
  });
});

describe("keyboard and accessibility", () => {
  it("opens the trace view on Enter", () => {
    const ring = fakeRing();
    for (let i = 0; i < 4; i += 1) ring.push();
    const { view: handle, scroller } = mount(ring);
    ring.fire();
    flush();

    const row = rows(scroller)[2]!;
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(selected()).toBe(2);
    expect(view()).toBe("trace");
    handle.destroy();
  });

  it("gives the list exactly one tab stop", () => {
    const ring = fakeRing();
    for (let i = 0; i < 6; i += 1) ring.push();
    const { view, scroller } = mount(ring);
    ring.fire();
    flush();

    /* A pool of two dozen focusable rows would put the whole viewport in the panel's Tab
       cycle; the roving tabindex is what keeps the list one stop. */
    const stops = scroller.querySelectorAll('.row[tabindex="0"]');
    expect(stops.length).toBeLessThanOrEqual(1);

    rows(scroller)[0]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    flush();
    expect(scroller.querySelectorAll('.row[tabindex="0"]').length).toBe(1);
    view.destroy();
  });

  it("names each row with its method, path, status and duration", () => {
    const ring = fakeRing();
    ring.push({ duration: 412, status: 500 });
    const { view, scroller } = mount(ring);
    ring.fire();
    flush();

    expect(rows(scroller)[0]!.getAttribute("aria-label")).toBe(
      "GET, /api/item/0, status 500, 412ms, traced",
    );
    view.destroy();
  });
});
