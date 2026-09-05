import { HEALTHY, WARNING, worstVital } from "./vitals";
import { size, stats } from "./ring";
import { PRELUDE, V } from "./tokens.gen";
import pillCss from "./pill.css?inline";
import { onVisibility, whenSettled } from "./phase";

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
 * Restarting a running animation rather than toggling a class: `currentTime = 0` needs no
 * style recalculation and cannot force a layout, and a fresh batch arriving mid-settle should
 * restart the blink rather than be swallowed by it or stack a second animation on top.
 *
 * Reduced motion is handled in CSS, which makes this a loop over an empty list rather than a
 * media query read on every tick.
 */
function fire(pulse: HTMLElement): void {
  pulse.classList.add("firing");
  const running = pulse.getAnimations();
  for (let i = 0; i < running.length; i += 1) {
    const animation = running[i] as Animation;
    animation.currentTime = 0;
    animation.play();
  }
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
  let clock: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;

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
      if (shownCount >= 0) fire(nodes.pulse);
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
   * A 500ms coalescing clock rather than an update per entry: the alternative is work in
   * the observer callback, which is the one place work must not go. It runs only while the
   * document is visible, and a tick that finds nothing changed writes no DOM.
   */
  function startClock(): void {
    if (clock !== undefined || document.visibilityState !== "visible") return;
    clock = setInterval(refresh, REFRESH_MS);
  }

  function stopClock(): void {
    if (clock === undefined) return;
    clearInterval(clock);
    clock = undefined;
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
    host = document.createElement(TAG);
    const root = host.attachShadow({ mode: "closed" });
    shadow = root;
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
