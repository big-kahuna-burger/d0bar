// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OVERSCAN, ROW_HEIGHT, virtualList, windowFor } from "../../src/panel/virtual";

/**
 * The virtualizer.
 *
 * The property under test is the one the budget rests on: the number of row elements is a
 * function of the viewport, never of the record count. That is arithmetic plus a pool, so
 * it is settled here — the browser bench then confirms the frame cost, which this cannot.
 */

describe("window arithmetic", () => {
  it("covers the viewport plus overscan on both sides", () => {
    const win = windowFor(0, 288, 2000);
    expect(win.first).toBe(0);
    /* ceil(288/21) = 14 visible rows, +1 for the partial one at the bottom, +6 overscan. */
    expect(win.last).toBe(14 + 1 + OVERSCAN);
  });

  it("keeps the window proportional to the viewport, not to the record count", () => {
    /* The requirement, stated as arithmetic: a hundredfold more records is the same number
       of rows. The widest the window ever gets is viewport + overscan on *both* sides,
       reached once the list has scrolled off the top. */
    const widest = 15 + 2 * OVERSCAN;
    expect(windowFor(0, 288, 2000).last).toBeLessThanOrEqual(widest);
    expect(windowFor(500 * ROW_HEIGHT, 288, 2000)).toMatchObject({ first: 494, last: 521 });
    /* A short list is bounded by its own length instead. */
    expect(windowFor(0, 288, 20)).toEqual({ first: 0, last: 20 });
  });

  it("clamps to the ends rather than running past them", () => {
    expect(windowFor(0, 288, 0)).toEqual({ first: 0, last: 0 });
    const end = windowFor(2000 * ROW_HEIGHT, 288, 2000);
    expect(end.last).toBe(2000);
    expect(end.first).toBeLessThan(end.last);
  });

  it("scrolls the window down with the offset", () => {
    const win = windowFor(100 * ROW_HEIGHT, 288, 2000);
    expect(win.first).toBe(100 - OVERSCAN);
    expect(win.last).toBe(100 + 15 + OVERSCAN);
  });
});

describe("the list", () => {
  let frames: Array<() => void> = [];

  beforeEach(() => {
    frames = [];
    /* rAF driven by hand: the point of the coalescing is that N invalidations in one frame
       produce one paint, and a real rAF would make that a race rather than an assertion. */
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
      frames.push(fn);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  function flush(): void {
    const pending = frames;
    frames = [];
    for (const frame of pending) frame();
  }

  function mount(count: number, enabled = true) {
    const updated: number[] = [];
    const list = virtualList({
      create: () => document.createElement("div"),
      update: (_row, index) => updated.push(index),
      enabled: () => enabled,
    });
    document.body.appendChild(list.el);
    /* jsdom lays nothing out, so `clientHeight` is 0 and the window would be overscan
       alone. Pinned to the handoff's 288px so the arithmetic under test is the real one. */
    Object.defineProperty(list.el, "clientHeight", { value: 288, configurable: true });
    list.setCount(count);
    return { list, updated };
  }

  it("holds a viewport's worth of rows for 2000 records", () => {
    const { list } = mount(2000);
    flush();
    expect(list.poolSize()).toBe(21);
    expect(list.el.querySelectorAll("div:not(.rows-spacer):not(.rows)").length).toBe(21);
  });

  it("recycles the pool instead of creating rows per scroll", () => {
    const { list } = mount(2000);
    flush();
    /* The pool grows once, to the widest window — at the top of the list `first` is clamped
       to zero, so the leading overscan only exists after the first scroll. It must not grow
       again after that, however far the list is dragged. */
    list.el.scrollTop = 40 * ROW_HEIGHT;
    list.invalidate();
    flush();
    const widest = list.poolSize();
    expect(widest).toBe(15 + 2 * OVERSCAN);

    for (let offset = 41; offset < 400; offset += 1) {
      list.el.scrollTop = offset * ROW_HEIGHT;
      list.invalidate();
      flush();
    }
    expect(list.poolSize()).toBe(widest);
  });

  it("coalesces repeated invalidations into one paint", () => {
    const { list, updated } = mount(100);
    flush();
    updated.length = 0;
    list.invalidate();
    list.invalidate();
    list.invalidate();
    expect(frames.length).toBe(1);
    flush();
    expect(updated.length).toBe(21);
  });

  it("creates and updates nothing while disabled", () => {
    /* Requirement 4.4: a closed panel or a hidden document costs no row work at all. */
    const { list, updated } = mount(500, false);
    flush();
    expect(list.poolSize()).toBe(0);
    expect(updated).toEqual([]);
  });

  it("sizes the spacer to the whole list so the scrollbar reports the real extent", () => {
    const { list } = mount(2000);
    const spacer = list.el.querySelector(".rows-spacer") as HTMLElement;
    expect(spacer.style.height).toBe(`${2000 * ROW_HEIGHT}px`);
  });

  it("moves the offset with the records when the ring's base advances", () => {
    const { list } = mount(512);
    flush();
    list.el.scrollTop = 100 * ROW_HEIGHT;
    list.shiftBy(10);
    /* The user was looking at record N; after ten fell off the front, record N is ten rows
       higher. Staying at the same pixel offset would silently show them different requests. */
    expect(list.scrollTop()).toBe(90 * ROW_HEIGHT);
  });

  it("does not scroll above the top when more records fall off than are scrolled past", () => {
    const { list } = mount(512);
    flush();
    list.el.scrollTop = 2 * ROW_HEIGHT;
    list.shiftBy(50);
    expect(list.scrollTop()).toBe(0);
  });
});
