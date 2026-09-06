/**
 * A fixed-height row virtualizer.
 *
 * The requests list is the one surface in the toolbar that streams, and it streams onto the
 * main thread of the page it is measuring. Two costs are structural if they are not designed
 * out, and both are:
 *
 *   - **Rows in the DOM.** Only the visible window plus an overscan exists, so a ring holding
 *     512 records has the same node count as one holding six.
 *   - **Rows created per frame.** Row elements are pooled and refilled. Scrolling allocates
 *     nothing; it writes text into nodes that already exist.
 *
 * The window arithmetic is a pure function ({@link windowFor}) so the property that matters —
 * node count stays proportional to the viewport, not to the record count — is settled by a
 * node test rather than by measuring a browser.
 */

import { marked } from "../shared/mark";

/** Row height, in pixels. Fixed by the handoff, and fixed by this module's arithmetic. */
export const ROW_HEIGHT = 21;

/** Rows rendered beyond each edge of the viewport, so a scroll does not expose blank space. */
export const OVERSCAN = 6;

/** Half-open: `first` inclusive, `last` exclusive. */
export interface RowWindow {
  first: number;
  last: number;
}

/**
 * The rows that must exist for a given scroll offset.
 *
 * `+ 1` on the visible count, not a rounding convenience: a viewport whose height is not an
 * exact multiple of the row height always shows a partial row at the bottom, and it is a
 * whole element.
 */
export function windowFor(
  scrollTop: number,
  viewportHeight: number,
  count: number,
  rowHeight: number = ROW_HEIGHT,
  overscan: number = OVERSCAN,
): RowWindow {
  if (count <= 0) return { first: 0, last: 0 };
  const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight));
  const visible = Math.ceil(viewportHeight / rowHeight) + 1;
  const first = Math.max(0, Math.min(firstVisible - overscan, Math.max(0, count - 1)));
  const last = Math.min(count, firstVisible + visible + overscan);
  return { first, last: Math.max(first, last) };
}

export interface VirtualOptions {
  /** Creates one pooled row. Called only when the pool has to grow. */
  create(): HTMLElement;
  /** Refills a pooled row with the record at `index`. Must not create elements. */
  update(row: HTMLElement, index: number): void;
  /**
   * Whether painting is worth doing at all. Returning false skips the frame entirely — no
   * row is created and none is updated, which is the requirement for a panel that is closed
   * or a document that is hidden.
   */
  enabled(): boolean;
  rowHeight?: number;
  overscan?: number;
}

export interface VirtualList {
  /** The scroll container. The caller mounts this. */
  readonly el: HTMLElement;
  /** Sets the record count. Repaints only when something actually changed. */
  setCount(count: number): void;
  /**
   * Compensates for records falling off the front of the ring: every retained record's index
   * has dropped by `rows`, so the offset that used to show row *n* now shows row *n + rows*.
   * Moving the scroll position by the same amount keeps the user looking at the same
   * requests instead of at the same pixels.
   */
  shiftBy(rows: number): void;
  /** Schedules a repaint on the next frame. Repeated calls in one frame coalesce to one. */
  invalidate(): void;
  scrollTop(): number;
  setScrollTop(offset: number): void;
  /** Row elements currently held. Test seam — the property this module exists for. */
  poolSize(): number;
  destroy(): void;
}

export function virtualList(options: VirtualOptions): VirtualList {
  const rowHeight = options.rowHeight ?? ROW_HEIGHT;
  const overscan = options.overscan ?? OVERSCAN;

  const el = document.createElement("div");
  el.className = "rows-scroll";

  /* Sized to the full list so the scrollbar reports the real extent; empty, so a list of
     2000 records costs one element's worth of layout rather than 2000. */
  const spacer = document.createElement("div");
  spacer.className = "rows-spacer";

  /* One transform for the whole window. Positioning each row individually would write a
     style on every row on every frame; this writes one, and the compositor owns it. */
  const rows = document.createElement("div");
  rows.className = "rows";
  spacer.appendChild(rows);
  el.appendChild(spacer);

  const pool: HTMLElement[] = [];
  let count = 0;
  let frame = 0;

  function paint(): void {
    frame = 0;
    if (!options.enabled()) return;

    const win = windowFor(el.scrollTop, el.clientHeight, count, rowHeight, overscan);
    const need = win.last - win.first;

    while (pool.length < need) {
      const row = options.create();
      pool.push(row);
      rows.appendChild(row);
    }

    for (let i = 0; i < pool.length; i += 1) {
      const row = pool[i] as HTMLElement;
      if (i < need) {
        row.hidden = false;
        options.update(row, win.first + i);
      } else if (!row.hidden) {
        /* Kept, not removed. The pool is the point: a row that scrolls out of view is the
           row that scrolls back in, and detaching it would trade a style write for a DOM
           mutation on every frame of a drag. */
        row.hidden = true;
      }
    }

    rows.style.transform = `translateY(${win.first * rowHeight}px)`;
  }

  /* The panel's repaint is the largest main-thread cost d0bar has, and stage 2's URL is not
     stage 1's — a URL-only attribution would miss it entirely. Marked, so it cannot. */
  const paintFrame = marked({
    "d0bar:panel-paint"(): void {
      paint();
    },
  });

  function invalidate(): void {
    if (frame !== 0) return;
    frame = requestAnimationFrame(paintFrame);
  }

  /* Passive: this handler never calls `preventDefault`, and a non-passive scroll listener
     makes the compositor wait for script before it scrolls — the exact cost the toolbar
     exists not to impose. The listener is on the panel's own element, inside the shadow
     root, so it is not a listener on the host page. */
  el.addEventListener("scroll", invalidate, { passive: true });

  return {
    el,
    setCount(next: number) {
      if (next === count) return;
      count = next;
      spacer.style.height = `${count * rowHeight}px`;
      invalidate();
    },
    shiftBy(shifted: number) {
      if (shifted <= 0) return;
      const offset = el.scrollTop - shifted * rowHeight;
      el.scrollTop = Math.max(0, offset);
    },
    invalidate,
    scrollTop: () => el.scrollTop,
    setScrollTop(offset: number) {
      el.scrollTop = offset;
      invalidate();
    },
    poolSize: () => pool.length,
    destroy() {
      el.removeEventListener("scroll", invalidate);
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      pool.length = 0;
      el.remove();
    },
  };
}
