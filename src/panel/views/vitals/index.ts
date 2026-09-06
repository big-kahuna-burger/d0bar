import type { Tier1Access } from "../../../shared/stage2";
import { open, tab, view } from "../../shell";
import { accessibleName, cards, selfReport, type Card } from "./format";
import { marked } from "../../../shared/mark";

/**
 * The vitals view.
 *
 * Four cards and a provenance note. Everything that decides *what* a card says lives in
 * `format.ts`, which node tests settle; this file only paints it — the same split the
 * requests view uses, for the same reason.
 *
 * Two properties are structural rather than intentional:
 *
 *   - **Nothing paints while nobody is looking.** Closed panel, another tab, a hidden
 *     document: the vitals batch still fires in stage 1, the repaint does not happen.
 *   - **No DOM node from a performance entry ever reaches here.** The reading crossing the
 *     boundary is numbers and short strings; an `element` or a shift's `node` held in a
 *     module variable would keep a detached subtree alive for the life of the page, which is
 *     the class of leak a performance tool must not introduce. `selectorOf` in
 *     `collector/vitals.ts` is where the node is turned into a string and dropped.
 */

export interface VitalsViewOptions {
  tier1: Tier1Access;
}

export interface VitalsView {
  readonly el: HTMLElement;
  /** Re-reads the accumulator and repaints. Called when the view becomes visible again. */
  refresh(): void;
  destroy(): void;
}

/** The handoff's §5 note, verbatim. `PerformanceObserver` is the one emphasised span. */
const NOTE_BEFORE = "Every number here is read from the browser's own ";
const NOTE_AFTER =
  " entries: LCP, layout-shift, event and long-animation-frame, with attribution. d0bar records nothing itself.";

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
  name: Text;
  value: HTMLElement;
  valueText: Text;
  attribution: Text;
}

export function vitalsView(options: VitalsViewOptions): VitalsView {
  const tier1 = options.tier1;

  const root = el("div", "vitals");
  const grid = el("div", "vitals-grid");
  grid.setAttribute("role", "list");

  /* Four cards, created once. The set is fixed — there is no vital that appears or
     disappears, only one whose value cannot be stated, and that is a change of text. */
  const parts: CardParts[] = [];
  for (let i = 0; i < 4; i += 1) {
    const card = el("div", "vcard");
    card.setAttribute("role", "listitem");

    const nameEl = el("div", "vname");
    const name = document.createTextNode("");
    nameEl.appendChild(name);

    const valueEl = el("div", "vvalue");
    const valueText = document.createTextNode("");
    valueEl.appendChild(valueText);

    const attrEl = el("div", "vattr");
    const attribution = document.createTextNode("");
    attrEl.appendChild(attribution);

    card.append(nameEl, valueEl, attrEl);
    grid.appendChild(card);
    parts.push({ root: card, name, value: valueEl, valueText, attribution });
  }

  const note = el("div", "vnote");
  const mono = el("span", "vnote-api");
  mono.textContent = "PerformanceObserver";
  note.append(document.createTextNode(NOTE_BEFORE), mono, document.createTextNode(NOTE_AFTER));

  /* Gated on the data, not on `__DEV__`.
     
     The obvious `__DEV__ ? … : undefined` was wrong here and shipped nothing: `__DEV__` is
     compiled per bundle, stage 2 has no dev artifact, and `?d0bar=dev` loads a dev stage 1 with
     the *production* panel as its sibling — so the block would have been compiled out in the one
     arm it exists for. `SelfCost.top` is the dev flag that actually crosses the boundary: stage 1
     fills it only under its own `__DEV__`, so this stays empty and hidden in a shipped build
     without stage 2 needing to know which build it is. */
  const selfEl = el("pre", "vself");
  selfEl.hidden = true;

  root.append(grid, note, selfEl);

  /* ── painting ── */

  function enabled(): boolean {
    /* Read, not subscribed — the batch listener fires regardless, and this decides whether
       that means anything. Identical to the requests view's gate, and for the same reason:
       a repaint nobody can see is work on the main thread of the page being measured. */
    return open.peek() && tab.peek() === "vitals" && view.peek() === "list" && tier1.visible();
  }

  function paint(): void {
    const reading = tier1.vitals();
    const next = cards(reading);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] as CardParts;
      const card = next[i] as Card;
      setText(part.name, card.name);
      setText(part.valueText, card.value);
      setText(part.attribution, card.attribution);
      /* The tone is an attribute, so the threshold colour is a CSS decision and the
         unavailable tones cannot accidentally be given a healthy green. */
      part.value.dataset["tone"] = card.tone;
      part.root.setAttribute("aria-label", accessibleName(card));
    }
    /* `hidden`, not a removed node: the block appears and disappears with the dev build, and
       toggling a property is cheaper than mutating the panel's DOM on a repaint. */
    selfEl.hidden = reading.self.top.length === 0;
    if (!selfEl.hidden) selfEl.textContent = selfReport(reading).join("\n");
  }

  /**
   * One repaint per frame at most.
   *
   * A busy page delivers layout-shift entries several times a frame, and repainting on each
   * would put the toolbar's own work into the very frames whose length it is reporting.
   */
  let frame = 0;
  function schedule(): void {
    if (!enabled() || frame) return;
    frame = requestAnimationFrame(
      marked({
        "d0bar:vitals-paint"(): void {
          frame = 0;
          /* Re-checked inside the frame: the tab can change between the request and the
             callback, and the state at paint time is the one that matters. */
          if (enabled()) paint();
        },
      }),
    );
  }

  const stopVitals = tier1.onVitals(schedule);
  /* Coming back from a hidden document: the batches that arrived meanwhile were dropped by
     `enabled()`, so the cards have to catch up in one paint rather than wait for the next
     entry — on a settled page, that could be never. */
  const stopVisibility = tier1.onVisibility((visible) => {
    if (visible) schedule();
  });

  paint();

  return {
    el: root,
    refresh() {
      /* Synchronous, not scheduled. This is the tab-entry path, and a card that is still
         showing the previous reading for a frame is a stale number in front of the user. */
      if (enabled()) paint();
    },
    destroy() {
      stopVitals();
      stopVisibility();
      if (frame) cancelAnimationFrame(frame);
      root.remove();
    },
  };
}
