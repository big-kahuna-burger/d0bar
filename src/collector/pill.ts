import { HEALTHY, WARNING, worstVital } from "./vitals";
import { size, stats } from "./ring";
import { PRELUDE, V } from "./tokens.gen";
import pillCss from "./pill.css?inline";
import { assertSettled, onVisibility, whenSettled } from "./phase";
import { delayed } from "../shared/schedule";
import { marked } from "../shared/mark";

/**
 * The collapsed pill.
 *
 * The whole of the toolbar's presence on a host page until someone opens it: one custom
 * element with a closed shadow root, styles supplied only through `adoptedStyleSheets`, and
 * `contain: layout paint style` so it cannot induce layout or paint work in the host.
 *
 * `all: initial` on the host gives a clean slate against whatever the customer's page sets
 * on inherited properties. Custom properties are deliberately not reset by `all`, so a
 * Dash0-styled host still resolves the real design tokens through it.
 *
 * The pill is mounted only after the load phase settles, so the host document sees zero
 * mutations from the toolbar while its own metrics are being recorded.
 */

const TAG = "d0-bar";

/** Coalescing floor for text updates, per the handoff's ambient-not-twitchy intent. */
const REFRESH_MS = 500;

let sheet: CSSStyleSheet | undefined;

function styleSheet(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(PRELUDE + pillCss);
  }
  return sheet;
}

export interface PillHandle {
  destroy(): void;
  /** Test seam: apply pending values immediately rather than on the coalescing clock. */
  refreshNow(): void;
  /**
   * The closed shadow root, so stage 2 mounts the panel inside it rather than adding a
   * second element to the host document. Undefined before settle.
   */
  root(): ShadowRoot | undefined;
  /** Returns focus to the pill when the panel closes. */
  focus(): void;
  /**
   * Marks the pill as waiting on stage 2.
   *
   * Only ever visible on a slow or cold fetch — on a warm prefetch the panel opens in the
   * same frame and this never paints. Without it a click on a throttled connection looks
   * like the pill is broken.
   */
  setPending(pending: boolean): void;
}

interface PillNodes {
  count: Text;
  pulse: HTMLElement;
  dot: HTMLElement;
  vitalWrap: HTMLElement;
  vitalText: Text;
  untraced: HTMLElement;
  dropped: HTMLElement;
  droppedText: Text;
}

function build(root: ShadowRoot, onActivate: () => void): PillNodes {
  const button = document.createElement("button");
  button.className = "pill";
  button.type = "button";
  button.setAttribute("aria-label", "Open d0bar");
  button.addEventListener("click", onActivate);

  const mark = document.createElement("span");
  mark.className = "mark";

  const count = document.createElement("span");
  count.className = "count";
  const countText = document.createTextNode("0 req");
  count.appendChild(countText);

  const pulse = document.createElement("i");
  pulse.className = "pulse";

  const sep = document.createElement("span");
  sep.className = "sep";

  const vitalWrap = document.createElement("span");
  vitalWrap.className = "vital";
  vitalWrap.hidden = true;
  const dot = document.createElement("i");
  dot.className = "dot";
  const vitalText = document.createElement("span");
  vitalText.className = "vtext";
  const vitalTextNode = document.createTextNode("");
  vitalText.appendChild(vitalTextNode);
  vitalWrap.append(dot, vitalText);

  const untraced = document.createElement("span");
  untraced.className = "untraced";
  untraced.hidden = true;

  const dropped = document.createElement("span");
  dropped.className = "dropped";
  dropped.hidden = true;
  const droppedText = document.createTextNode("");
  dropped.appendChild(droppedText);

  button.append(mark, pulse, count, sep, vitalWrap, untraced, dropped);
  root.appendChild(button);

  return {
    count: countText,
    pulse,
    dot,
    vitalWrap,
    vitalText: vitalTextNode,
    untraced,
    dropped,
    droppedText,
  };
}

/**
 * Blinks the activity dot.
 *
 * Restarting a running animation rather than toggling a class: `currentTime = 0` needs no style
 * recalculation and cannot force a layout, and a fresh batch mid-settle should restart the blink
 * rather than be swallowed by it or stack a second animation on top.
 *
 * **`getAnimations()` is called once and the result cached**, because it is a style-flushing read —
 * it has to resolve current style to answer — and calling it per blink put a synchronous style
 * recalculation on the main thread every time the request count moved. `persist()` is what makes
 * caching safe: Chrome removes a finished, non-filling animation from the element automatically,
 * and a removed animation cannot be restarted.
 *
 * Reduced motion is handled in CSS, so on a page that asks for it `getAnimations()` returns nothing
 * and this stays permanently empty rather than reading a media query per tick.
 */
function fire(pulse: HTMLElement, cache: { blink?: Animation | null }): void {
  pulse.classList.add("firing");
  if (cache.blink === undefined) {
    const running = pulse.getAnimations();
    const first = running.length > 0 ? (running[0] as Animation) : null;
    first?.persist();
    cache.blink = first;
  }
  const animation = cache.blink;
  if (!animation) return;
  animation.currentTime = 0;
  animation.play();
}

/**
 * Mounts the pill once the load phase settles. Returns a handle whose `destroy()` removes
 * the element and every listener and timer it owns.
 */
export function mountPill(onActivate: () => void): PillHandle {
  let host: HTMLElement | undefined;
  let shadow: ShadowRoot | undefined;
  let button: HTMLButtonElement | undefined;
  let nodes: PillNodes | undefined;
  let cancelTick: (() => void) | undefined;
  let destroyed = false;
  /* `undefined` = not looked up yet, `null` = looked up and there is none (reduced motion). */
  const pulseAnimation: { blink?: Animation | null } = {};

  /* Last rendered values, so a tick with nothing to say writes no DOM at all. */
  let shownCount = -1;
  let shownVital = "";
  let shownDropped = -1;

  function refresh(): void {
    if (!nodes) return;

    const count = size();
    if (count !== shownCount) {
      nodes.count.nodeValue = `${count} req`;
      /* Not on the first paint: `shownCount` starts at -1, and a pill that blinks the moment
         it mounts is reporting its own arrival as page activity. */
      if (shownCount >= 0) fire(nodes.pulse, pulseAnimation);
      shownCount = count;
    }

    const worst = worstVital();
    const text = worst ? worst.text : "";
    if (text !== shownVital) {
      if (worst) {
        nodes.vitalText.nodeValue = worst.text;
        nodes.dot.style.background =
          worst.bucket === HEALTHY ? V.healthy : worst.bucket === WARNING ? V.warning : V.error;
        nodes.vitalWrap.hidden = false;
      } else {
        nodes.vitalWrap.hidden = true;
      }
      shownVital = text;
    }

    const { dropped } = stats();
    if (dropped !== shownDropped) {
      if (dropped > 0) {
        nodes.droppedText.nodeValue = `${dropped} dropped`;
        nodes.dropped.hidden = false;
      } else {
        nodes.dropped.hidden = true;
      }
      shownDropped = dropped;
    }
  }

  /**
   * A 500 ms coalescing clock rather than an update per entry: the alternative is work in the
   * observer callback, which is the one place work must not go. It runs only while the document is
   * visible, and a tick that finds nothing changed writes no DOM.
   *
   * **A self-rescheduling background task, not `setInterval`.** `schedule.ts` opens by saying
   * deferred work is background priority and never a timer, and this file was the one place that
   * did not follow it: `setInterval` runs at normal priority, so its tick competed with the host
   * page and could land inside an interaction's presentation window — a repaint there is real INP,
   * charged to the page d0bar is measuring. `delayed()` uses `scheduler.postTask` at background
   * priority, which yields to input by construction.
   *
   * Six CI runs of the A/B sign test produced 7 decisive INP pairs, every one of them worse with
   * the toolbar running and none better (pooled one-sided p = 0.0078, while no single run reached
   * significance). This clock was the leading suspect named in `add-perturbation-budget`'s task 7.7,
   * and it is the only periodic main-thread work stage 1 owns.
   */
  function startClock(): void {
    if (cancelTick !== undefined || document.visibilityState !== "visible") return;
    /* Marked so a long frame this tick lands in is attributable to d0bar rather than to the
       host. It is the only periodic main-thread work stage 1 owns, so it is the one thing a
       self-cost figure of zero has to be able to rule out. */
    const tick = marked({
      "d0bar:pill-tick"(): void {
        cancelTick = undefined;
        if (destroyed) return;
        refresh();
        startClock();
      },
    });
    cancelTick = delayed(tick, REFRESH_MS);
  }

  function stopClock(): void {
    if (cancelTick === undefined) return;
    cancelTick();
    cancelTick = undefined;
  }

  /* Pauses the refresh clock in a background tab. Driven by the `visibility-state` entry
     type rather than a `visibilitychange` listener, so the pill adds nothing to the host
     document's event surface — see `phase.ts`. */
  function onVisible(visible: boolean): void {
    if (visible) {
      refresh();
      startClock();
    } else {
      stopClock();
    }
  }

  let offVisibility: (() => void) | undefined;

  whenSettled(() => {
    if (destroyed) return;
    /* The toolbar's only write into the host document, and the moratorium's headline case.
       Guarded rather than trusted to its caller: a future path that mounts the pill without
       going through `whenSettled` is exactly the regression this is here to catch. */
    if (__DEV__) assertSettled("mounting the pill");
    host = document.createElement(TAG);
    const root = host.attachShadow({ mode: "closed" });
    shadow = root;
    /* A second guard, deliberately. Adopting a stylesheet is style-recalculation work on the
       host's own document, and a refactor that moved it out of this callback would otherwise
       be silent. */
    if (__DEV__) assertSettled("adopting the pill stylesheet");
    root.adoptedStyleSheets = [styleSheet()];
    nodes = build(root, onActivate);
    button = root.querySelector("button") ?? undefined;
    document.body.appendChild(host);
    refresh();
    startClock();
    offVisibility = onVisibility(onVisible);
  });

  return {
    refreshNow: refresh,
    root: () => shadow,
    focus: () => button?.focus(),
    setPending(pending: boolean) {
      if (!button) return;
      button.classList.toggle("pending", pending);
      /* The pill stays operable — a second click while stage 2 is in flight is ignored by
         the caller, not by a disabled control the user cannot focus. `aria-busy` says so
         without removing it from the tab order. */
      button.setAttribute("aria-busy", pending ? "true" : "false");
    },
    destroy() {
      destroyed = true;
      stopClock();
      offVisibility?.();
      offVisibility = undefined;
      host?.remove();
      host = undefined;
      shadow = undefined;
      button = undefined;
      nodes = undefined;
    },
  };
}

/**
 * Defines the custom element. Separate from mounting so the gate can decline to define
 * anything at all, and so a host that already defined the tag is not clobbered.
 */
export function definePill(): void {
  if (customElements.get(TAG)) return;
  customElements.define(TAG, class extends HTMLElement {});
}
