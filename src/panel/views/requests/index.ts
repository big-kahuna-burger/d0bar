import { scratch, type RequestRecord } from "../../../shared/record";
import type { Tier1Access } from "../../../shared/stage2";
import { open, recallScroll, rememberScroll, selected, tab, view } from "../../shell";
import { ROW_HEIGHT, virtualList, type VirtualList } from "../../virtual";
import { barFor, WINDOW_MS, type Segment } from "./geometry";
import {
  accessibleName,
  displayPath,
  formatDuration,
  hasTrace,
  isXhr,
  methodFor,
  statusFor,
} from "./format";

/**
 * The requests view — the tab people live in, and the only surface that streams.
 *
 * Three things are load-bearing here and each is deliberate:
 *
 *   - **Rows are windowed and pooled** (`virtual.ts`), so the DOM holds a viewport's worth of
 *     rows whether the ring has six records or five hundred.
 *   - **Bar geometry is two custom properties** on a `contain: layout style` row, so a bar
 *     that moves recalculates style inside that row and invalidates nothing above it.
 *   - **Nothing paints while nobody is looking.** Closed panel, another tab, a hidden
 *     document: the batch listener still fires, the repaint does not happen.
 *
 * Records are read into one shared scratch object. The list re-reads its whole window on
 * every repaint, so a per-row object would put an allocation per row per frame on the main
 * thread of the page being measured.
 */

/** Segment spans preallocated per row: lead, connect, wait, transfer. */
const MAX_SEGMENTS = 4;

export interface RequestsViewOptions {
  tier1: Tier1Access;
  /** The page's own origin, for shortening same-origin URLs. Injected so it is testable. */
  origin?: string;
}

export interface RequestsView {
  readonly el: HTMLElement;
  /** Re-reads the ring and repaints. Called when the view becomes visible again. */
  refresh(): void;
  destroy(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

/** Writes only when the text actually changed — a same-value write still dirties the node. */
function setText(node: Text, value: string): void {
  if (node.data !== value) node.data = value;
}

interface RowParts {
  root: HTMLElement;
  chip: HTMLElement;
  chipText: Text;
  method: Text;
  path: Text;
  kind: Text;
  status: HTMLElement;
  statusText: Text;
  duration: Text;
  bar: HTMLElement;
  segments: HTMLElement[];
}

const rowParts = new WeakMap<HTMLElement, RowParts>();

export function requestsView(options: RequestsViewOptions): RequestsView {
  const tier1 = options.tier1;
  const origin = options.origin ?? location.origin;
  const record: RequestRecord = scratch();

  const root = el("div", "requests");

  /* ── column header ──
     The same grid template as a row, declared once in CSS and applied to both, so the
     header cannot drift out of alignment with the columns it names. */
  const header = el("div", "rows-head");
  header.setAttribute("role", "row");
  for (const [label, cls] of [
    ["trace", "col-trace"],
    ["request", "col-req"],
    ["status", "col-status"],
    ["dur", "col-dur"],
    [`0 → ${(WINDOW_MS / 1000).toFixed(1)}s`, "col-bar"],
  ] as const) {
    const cell = el("span", cls);
    cell.setAttribute("role", "columnheader");
    cell.textContent = label;
    /* The shell's container query drops this column below 560px; the contract is the
       attribute, and it must be on the header cell and the row cell alike. */
    if (cls === "col-bar") cell.dataset["col"] = "waterfall";
    header.appendChild(cell);
  }

  /* ── the list ── */
  let count = 0;
  /** Absolute index of retained row 0. Advances when the ring overwrites its oldest. */
  let base = 0;
  /** The row that owns the list's single tab stop. `-1` until one is chosen. */
  let focusRow = -1;

  const list: VirtualList = virtualList({
    create: createRow,
    update: updateRow,
    /* The whole of requirement 4.4. Note it is read, not subscribed: the batch listener
       fires regardless, and this decides whether that means anything. */
    enabled: () =>
      open.peek() && tab.peek() === "requests" && view.peek() === "list" && tier1.visible(),
  });
  list.el.setAttribute("role", "rowgroup");
  list.el.setAttribute("aria-label", "Requests");

  const empty = el("div", "rows-empty");
  empty.textContent = "No requests recorded yet.";

  const dropped = el("div", "rows-dropped");
  const droppedText = document.createTextNode("");
  dropped.appendChild(droppedText);
  dropped.hidden = true;

  root.append(header, list.el, empty, dropped);

  /* ── rows ── */

  function createRow(): HTMLElement {
    const row = el("div", "row");
    row.setAttribute("role", "row");
    /* Not a `<button>`: the panel's focus trap collects every button in the panel, and a
       pool of two dozen row buttons would put the whole viewport in the Tab order. A roving
       `tabindex` gives the list exactly one tab stop, and the trap's selector
       (`[tabindex]:not([tabindex="-1"])`) already agrees with that. */
    row.tabIndex = -1;

    const traceCell = el("span", "col-trace");
    const chip = el("span", "chip");
    const chipText = document.createTextNode("");
    chip.appendChild(chipText);
    traceCell.appendChild(chip);

    const reqCell = el("span", "col-req");
    const methodEl = el("span", "method");
    const method = document.createTextNode("");
    methodEl.appendChild(method);
    const pathEl = el("span", "path");
    const path = document.createTextNode("");
    pathEl.appendChild(path);
    const kindEl = el("span", "kind");
    const kind = document.createTextNode("");
    kindEl.appendChild(kind);
    reqCell.append(methodEl, pathEl, kindEl);

    const status = el("span", "col-status");
    const statusText = document.createTextNode("");
    status.appendChild(statusText);

    const durEl = el("span", "col-dur");
    const duration = document.createTextNode("");
    durEl.appendChild(duration);

    const barCell = el("span", "col-bar");
    barCell.dataset["col"] = "waterfall";
    const bar = el("span", "bar");
    const segments: HTMLElement[] = [];
    for (let i = 0; i < MAX_SEGMENTS; i += 1) {
      const seg = el("i", "seg");
      seg.hidden = true;
      bar.appendChild(seg);
      segments.push(seg);
    }
    barCell.appendChild(bar);

    row.append(traceCell, reqCell, status, durEl, barCell);
    rowParts.set(row, {
      root: row,
      chip,
      chipText,
      method,
      path,
      kind,
      status,
      statusText,
      duration,
      bar,
      segments,
    });
    return row;
  }

  function updateRow(row: HTMLElement, index: number): void {
    const parts = rowParts.get(row);
    if (!parts) return;
    if (!tier1.read(index, record)) {
      /* The ring moved under the paint. Blanking is wrong and so is stale content, so the
         row is hidden for this frame and the next one refills it. */
      row.hidden = true;
      return;
    }

    row.dataset["index"] = String(index);
    row.tabIndex = index === focusRow ? 0 : -1;
    row.setAttribute("aria-selected", String(selected.peek() === index));
    row.setAttribute("aria-label", accessibleName(record, origin));

    const traced = hasTrace(record);
    setText(parts.chipText, traced ? "TRACE" : "NONE");
    parts.chip.dataset["traced"] = String(traced);

    setText(parts.method, methodFor(record));
    setText(parts.path, displayPath(record.url, origin));
    setText(parts.kind, isXhr(record) ? "xhr" : "");

    const status = statusFor(record);
    setText(parts.statusText, status.text);
    parts.status.dataset["tone"] = status.tone;

    setText(parts.duration, formatDuration(record.duration));

    const bar = barFor(record);
    /* The two properties the whole design rests on. Written on the row, read by the bar's
       own rule, so geometry never becomes a JavaScript layout calculation. */
    row.style.setProperty("--l", String(bar.left));
    row.style.setProperty("--w", String(bar.width));
    /* An error is a state of the request, not of its phases: it colours the whole bar. */
    parts.bar.dataset["tone"] = status.tone === "error" ? "error" : "normal";
    parts.bar.dataset["clipped"] = String(bar.clipped);
    paintSegments(parts.segments, bar.segments);
    parts.bar.dataset["phases"] = bar.segments ? "measured" : "none";
  }

  function paintSegments(nodes: HTMLElement[], segments: Segment[] | null): void {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i] as HTMLElement;
      const segment = segments ? segments[i] : undefined;
      if (!segment) {
        if (!node.hidden) node.hidden = true;
        continue;
      }
      node.hidden = false;
      node.dataset["kind"] = segment.kind;
      const width = `${(segment.fraction * 100).toFixed(3)}%`;
      if (node.style.width !== width) node.style.width = width;
    }
  }

  /* ── streaming ── */

  function sync(): void {
    const stats = tier1.stats();
    const retained = Math.min(stats.written, stats.capacity);
    const nextBase = stats.written - retained;

    if (nextBase > base) {
      /* The ring overwrote its oldest records, so every retained index dropped by this
         much. Left uncompensated, the viewport would appear to scroll on its own and the
         selected row would silently become a different request. */
      const shifted = nextBase - base;
      base = nextBase;
      list.shiftBy(shifted);
      const chosen = selected.peek();
      if (chosen >= 0) selected.set(chosen - shifted >= 0 ? chosen - shifted : -1);
      if (focusRow >= 0) focusRow = focusRow - shifted >= 0 ? focusRow - shifted : -1;
    }

    count = retained;
    list.setCount(count);
    list.invalidate();

    empty.hidden = count !== 0;
    list.el.hidden = count === 0;

    /* A truncated list presented as complete would be the toolbar losing data quietly —
       the one failure the ring's fixed capacity makes possible, so it is stated. */
    dropped.hidden = stats.dropped === 0;
    if (stats.dropped > 0) {
      setText(
        droppedText,
        `${stats.dropped} earlier ${stats.dropped === 1 ? "request" : "requests"} dropped — the buffer holds ${stats.capacity}.`,
      );
    }
  }

  /* ── interaction ── */

  function indexOf(target: EventTarget | null): number {
    const row = (target as HTMLElement | null)?.closest?.(".row") as HTMLElement | null;
    if (!row) return -1;
    const raw = row.dataset["index"];
    return raw === undefined ? -1 : Number(raw);
  }

  function openRow(index: number): void {
    if (index < 0 || index >= count) return;
    /* Recorded here rather than left to the scroll handler. Pushing the trace surface hides
       the list, and `display: none` discards `scrollTop` on the spot — so an offset that has
       not yet been through a `scroll` event is simply gone. Escape would then land the user
       at the top of the list rather than where they left it, and this is the one path that
       knows for certain the list is being left. */
    rememberScroll("requests", list.scrollTop());
    selected.set(index);
    view.set("trace");
  }

  function moveFocus(next: number): void {
    if (count === 0) return;
    const clamped = Math.max(0, Math.min(count - 1, next));
    focusRow = clamped;
    /* Scrolled by arithmetic rather than `scrollIntoView`, which would scroll the panel's
       own body — and every ancestor scroller — to bring the row into view. */
    const top = clamped * ROW_HEIGHT;
    const offset = list.scrollTop();
    const height = list.el.clientHeight;
    if (top < offset) list.setScrollTop(top);
    else if (top + ROW_HEIGHT > offset + height) list.setScrollTop(top + ROW_HEIGHT - height);
    else list.invalidate();

    /* After the repaint that gives the row its tab stop, not before it. */
    requestAnimationFrame(() => {
      const row = list.el.querySelector<HTMLElement>(`.row[data-index="${clamped}"]`);
      row?.focus();
    });
  }

  const onClick = (event: Event) => {
    const index = indexOf(event.target);
    if (index >= 0) openRow(index);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const index = indexOf(event.target);
    switch (event.key) {
      case "Enter":
      case " ":
        if (index < 0) return;
        event.preventDefault();
        openRow(index);
        return;
      case "ArrowDown":
        event.preventDefault();
        moveFocus((index < 0 ? -1 : index) + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveFocus((index < 0 ? count : index) - 1);
        return;
      case "Home":
        event.preventDefault();
        moveFocus(0);
        return;
      case "End":
        event.preventDefault();
        moveFocus(count - 1);
        return;
      default:
    }
  };

  /* Focus entering the list from outside lands on a row; without this the roving tabindex
     has nowhere to start and the list is reachable but not navigable. */
  const onFocusIn = (event: FocusEvent) => {
    if (focusRow >= 0) return;
    const index = indexOf(event.target);
    if (index >= 0) focusRow = index;
  };

  /**
   * Scroll memory.
   *
   * The list is its own scroller, and `scroll` does not bubble, so the panel's body-level
   * handler never sees this — the offset has to be recorded here or not at all. It has to be
   * recorded at all because a hidden tab means `display: none`, which discards `scrollTop`
   * outright: without this, every return to the requests tab lands at the top of the list.
   */
  const onScroll = () => {
    /* Not while the list is unlaid-out. Hiding it resets `scrollTop` to zero and the browser
       reports that reset as a scroll — so without this guard, leaving the tab overwrites the
       offset being remembered with the zero that leaving it just caused, and the restore on
       the way back has nothing left to restore. Measured: the probe showed `clientHeight` 0
       and `scrollTop` 0 in the same frame the view was hidden. */
    if (list.el.clientHeight === 0) return;
    rememberScroll("requests", list.scrollTop());
  };

  list.el.addEventListener("click", onClick);
  list.el.addEventListener("keydown", onKeyDown);
  list.el.addEventListener("focusin", onFocusIn);
  list.el.addEventListener("scroll", onScroll, { passive: true });

  /**
   * Puts the list back where the user left it.
   *
   * Retried across frames because the caller cannot help but be early: re-entering the tab
   * flips a signal, and the binding that un-hides the list is a separate subscriber to that
   * same signal. Whichever order they run in, this can be reached while the element is still
   * `display: none` — and a `scrollTop` write to an unlaid-out element is silently discarded,
   * which is exactly the no-op that put the user back at the top of the list.
   *
   * Bounded rather than a loop: if the view never becomes visible there is nothing to
   * restore, and a self-rescheduling frame callback on a hidden element would be a permanent
   * cost for a state that no longer wants one.
   */
  function restoreScroll(attempts: number): void {
    const saved = recallScroll("requests");
    if (saved <= 0 || attempts <= 0) return;
    if (list.el.clientHeight === 0) {
      requestAnimationFrame(() => restoreScroll(attempts - 1));
      return;
    }
    /* Only from the top. A restore that fired over the user's own scrolling would fight it;
       arriving at zero is the state the `display: none` reset leaves behind. */
    if (list.scrollTop() === 0) list.setScrollTop(saved);
  }

  const stopBatch = tier1.onBatch(sync);
  /* Coming back from a hidden tab: the batches that arrived meanwhile were dropped on the
     floor by `enabled()`, so the list has to catch up in one repaint rather than wait for
     the next request to arrive — on a page that has gone quiet, that could be never. */
  const stopVisibility = tier1.onVisibility((visible) => {
    if (visible) sync();
  });

  sync();

  return {
    el: root,
    refresh() {
      sync();
      restoreScroll(3);
    },
    destroy() {
      stopBatch();
      stopVisibility();
      list.el.removeEventListener("click", onClick);
      list.el.removeEventListener("keydown", onKeyDown);
      list.el.removeEventListener("focusin", onFocusIn);
      list.el.removeEventListener("scroll", onScroll);
      list.destroy();
      root.remove();
    },
  };
}
