import { coverage, type Coverage, type Gap } from "../../../collector/coverage";
import { scratch } from "../../../shared/record";
import type { Tier1Access } from "../../../shared/stage2";
import {
  open,
  selected,
  tab,
  tier2Live,
  untracedCount,
  untracedTooltip,
  view,
} from "../../shell";
import {
  CAUSE_COPY,
  CAUSE_LABEL,
  CLOSING_NOTE,
  headline,
  tabTooltip,
  truncationNote,
} from "./copy";

/**
 * The untraced view.
 *
 * A headline, one card per gap, and the note explaining why only the worker can see any of
 * this. What a card *says* lives in `copy.ts` and the classification lives in
 * `collector/coverage.ts`; this file paints them, the same split the other two views use.
 *
 * **Not virtualized, deliberately, unlike the requests list.** The list can hold 512 rows and
 * has to stream; this holds at most `MAX_GAPS` cards and only changes when a batch arrives.
 * A pooled virtualizer here would be machinery guarding against a case the cap already
 * removes — and the cards are variable height, which is the one shape a fixed-row virtualizer
 * cannot do.
 *
 * The gate is the same as everywhere else: nothing paints while nobody is looking.
 */

export interface UntracedViewOptions {
  tier1: Tier1Access;
  /** This page's origin, for the third-party comparison. Injected so a test can set it. */
  origin: string;
  /** Ring indices the worker produced a record for. Read at paint time, not captured. */
  seen(): ReadonlySet<number>;
}

export interface UntracedView {
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

function setText(node: Text, value: string): void {
  if (node.data !== value) node.data = value;
}

interface CardParts {
  root: HTMLElement;
  url: Text;
  label: Text;
  cause: Text;
}

export function untracedView(options: UntracedViewOptions): UntracedView {
  const tier1 = options.tier1;
  /* One record, reused for the whole walk. The tab repaints on every batch, and a per-record
     object would put an allocation per request per repaint on the page's main thread. */
  const record = scratch();

  /* `coverage`, not `untraced`: the pill's stylesheet already owns `.untraced`, and both
     sheets are adopted on this one shadow root. See the note in panel.css. */
  const root = el("div", "coverage");

  const head = el("div", "coverage-head");
  const countEl = el("div", "coverage-count");
  const countText = document.createTextNode("");
  countEl.appendChild(countText);
  const detailEl = el("div", "coverage-detail");
  const detailText = document.createTextNode("");
  detailEl.appendChild(detailText);
  head.append(countEl, detailEl);

  const list = el("div", "coverage-list");
  list.setAttribute("role", "list");

  const truncEl = el("div", "coverage-trunc");
  const truncText = document.createTextNode("");
  truncEl.appendChild(truncText);

  const note = el("div", "coverage-note");
  note.textContent = CLOSING_NOTE;

  root.append(head, list, truncEl, note);

  /* Cards are created as the page needs them and then reused. The count only ever grows
     within a page's life, and dropping a card to recreate it on the next batch would churn
     the DOM for no benefit. */
  const cards: CardParts[] = [];

  function cardAt(index: number): CardParts {
    const existing = cards[index];
    if (existing) return existing;

    const card = el("div", "ucard");
    card.setAttribute("role", "listitem");
    /* A card is a way back to the request it describes: clicking one selects that row and
       returns to the list, which is where the timings are. */
    card.tabIndex = -1;

    const dot = el("i", "udot");
    const body = el("div", "ubody");

    const urlEl = el("div", "uurl");
    const url = document.createTextNode("");
    urlEl.appendChild(url);

    const causeEl = el("div", "ucause");
    const labelEl = el("span", "ucause-label");
    const label = document.createTextNode("");
    labelEl.appendChild(label);
    const cause = document.createTextNode("");
    causeEl.append(labelEl, document.createTextNode(" "), cause);

    body.append(urlEl, causeEl);
    card.append(dot, body);
    list.appendChild(card);

    const parts: CardParts = { root: card, url, label, cause };
    cards[index] = parts;
    return parts;
  }

  function enabled(): boolean {
    return open.peek() && tab.peek() === "untraced" && view.peek() === "list" && tier1.visible();
  }

  function read(): Coverage {
    const stats = tier1.stats();
    const retained = Math.min(stats.written, stats.capacity);
    return coverage({
      count: retained,
      read: tier1.read,
      scratch: record,
      origin: options.origin,
      seen: options.seen(),
      /* Tier 2 is what makes the comparison possible at all. Read from the shell's signal
         rather than passed in at construction: registration completes after settle, so a
         value captured when the panel mounted would say `off` for a live worker. */
      determinable: tier2Live(),
    });
  }

  function paint(): void {
    const reading = read();
    const line = headline(reading);

    setText(countText, line.text);
    setText(detailText, line.detail);
    /* An attribute rather than a class, so the three states cannot share a colour by
       omission — an undeterminable reading must never pick up the clean green. */
    countEl.dataset["kind"] = line.kind;

    for (let i = 0; i < reading.gaps.length; i += 1) {
      const gap = reading.gaps[i] as Gap;
      const parts = cardAt(i);
      setText(parts.url, gap.url);
      setText(parts.label, CAUSE_LABEL[gap.cause]);
      setText(parts.cause, CAUSE_COPY[gap.cause]);
      parts.root.dataset["cause"] = gap.cause;
      parts.root.dataset["index"] = String(gap.index);
      parts.root.hidden = false;
      parts.root.setAttribute("aria-label", `${gap.url}, ${CAUSE_LABEL[gap.cause]}`);
    }
    /* Hidden, not removed — see the note on `cards`. */
    for (let i = reading.gaps.length; i < cards.length; i += 1) {
      (cards[i] as CardParts).root.hidden = true;
    }

    const trunc = truncationNote(reading, reading.gaps.length);
    setText(truncText, trunc);
    truncEl.hidden = trunc === "";

    /* The badge, the tooltip and this headline all come from one reading, so they cannot
       disagree. */
    publish(reading);
  }

  /**
   * Keeps the badge current without painting.
   *
   * The badge is on the tab, so it has to be right *before* anyone opens the tab — a count
   * that only becomes true once visited is a count nobody sees. The DOM work is what the
   * visibility gate protects; the walk is one pass over at most 512 records with no
   * allocation beyond the gap list, and it only runs while the panel is open at all.
   */
  function recount(): void {
    publish(read());
  }

  /** The one place a reading becomes the badge and the tab's hover copy. */
  function publish(reading: Coverage): void {
    /* Zero when undeterminable because there is no count to show — not because there are no
       gaps. The badge is hidden at zero by the shell, and the tooltip says which of the two
       this is. */
    untracedCount.set(reading.determinable ? reading.untraced : 0);
    untracedTooltip.set(tabTooltip(reading));
  }

  /* One repaint per frame at most, and only when something can see it. The count is updated
     either way — see `recount`. */
  let frame = 0;
  function schedule(): void {
    if (!open.peek()) return;
    if (!enabled()) {
      recount();
      return;
    }
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (enabled()) paint();
      else recount();
    });
  }

  function openRow(index: number): void {
    selected.set(index);
    tab.set("requests");
  }

  function onClick(event: Event): void {
    const card = (event.target as Element | null)?.closest?.(".ucard") as HTMLElement | null;
    if (!card) return;
    const index = Number(card.dataset["index"]);
    if (Number.isFinite(index)) openRow(index);
  }

  list.addEventListener("click", onClick);

  const stopBatch = tier1.onBatch(schedule);
  /* Coming back from a hidden document: the batches that arrived meanwhile were dropped by
     `enabled()`, so the tab has to catch up in one paint rather than wait for a request that
     a settled page may never make. */
  const stopVisibility = tier1.onVisibility((visible) => {
    if (visible) schedule();
  });

  /* Once at construction, so the badge is right the moment the panel opens. */
  paint();

  return {
    el: root,
    refresh() {
      /* Synchronous, not scheduled. This is the tab-entry path — and the post-flush path,
         where the correlation has just written trace ids into the ring behind this tab's
         back — and a headline still showing the previous reading for a frame is a stale
         number in front of the user. */
      if (enabled()) paint();
      else recount();
    },
    destroy() {
      stopBatch();
      stopVisibility();
      list.removeEventListener("click", onClick);
      if (frame) cancelAnimationFrame(frame);
      root.remove();
    },
  };
}
