import { bindAttr, bindClass, bindHidden, bindText, on } from "spark-signals/bind";
import { effect, scope } from "spark-signals/signal";
import panelCss from "./panel.css?inline";
import {
  escape as shellEscape,
  open,
  selectTab,
  showUntracedBadge,
  tab,
  untracedCount,
  type Tab,
} from "./shell";

/**
 * Stage 2: the panel.
 *
 * Loaded on first open, or by a background prefetch after the load phase settles. Nothing in
 * this file is on a host page's critical path, which is why it can afford a stylesheet and a
 * few dozen nodes where stage 1 could not.
 *
 * Mounted into the closed shadow root stage 1 already owns, so the panel adds no second host
 * element and remains unreachable from the customer's page.
 */

export interface PanelOptions {
  root: ShadowRoot;
  onClose(): void;
}

export interface PanelHandle {
  show(): void;
  close(): void;
  destroy(): void;
}

let sheet: CSSStyleSheet | undefined;

function styleSheet(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(panelCss);
  }
  return sheet;
}

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "requests", label: "Requests" },
  { id: "vitals", label: "Vitals" },
  { id: "untraced", label: "Untraced" },
];

/** The four observation tiers, in the order the handoff lists them. */
const TIERS: ReadonlyArray<{ label: string; state: "live" | "off" | "planned" }> = [
  { label: "1 PerformanceObserver", state: "live" },
  { label: "2 SW", state: "off" },
  /* Tiers 3 and 4 are not wired to anything and must not imply that they are. */
  { label: "3 Server-Timing", state: "planned" },
  { label: "4 OTel SDK", state: "planned" },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

export function openPanel(options: PanelOptions): PanelHandle {
  const { root, onClose } = options;
  const bindings = scope();

  /* Adopted alongside the pill's sheet rather than replacing it — the token prelude lives
     there, and both sheets are constructed, so neither reaches the host document. */
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, styleSheet()];

  const panel = el("div", "panel");
  /* Manual popover: the browser's top layer, so no host stacking context can cover the
     panel and none has to be fought. Manual rather than auto because light-dismiss would
     close it on any click in the host page, including one the user meant for the page. */
  panel.popover = "manual";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "d0bar");

  /* ── header ── */
  const head = el("div", "head");
  const title = el("span", "title");
  title.textContent = "d0bar";

  const url = el("span", "url");
  /* Read once. A route change updates it through the epoch model, not by polling. */
  url.textContent = location.pathname + location.search;
  url.title = location.href;

  const hint = el("span", "hint");
  hint.textContent = "⌘⇧0";

  const close = el("button", "close");
  close.type = "button";
  close.setAttribute("aria-label", "Close d0bar");
  close.textContent = "✕";
  bindings.add(on(close, "click", () => open.set(false)));

  head.append(title, url, hint, close);

  /* ── tab row ── */
  const tabs = el("div", "tabs");
  tabs.setAttribute("role", "tablist");

  for (const item of TABS) {
    const button = el("button", "tab");
    button.type = "button";
    button.setAttribute("role", "tab");
    const label = document.createTextNode(item.label);
    button.appendChild(label);

    if (item.id === "untraced") {
      const badge = el("span", "badge");
      const count = document.createTextNode("0");
      badge.appendChild(count);
      button.appendChild(badge);
      bindings.add(bindText(count, () => String(untracedCount())));
      /* Hidden at zero, but the tab itself is retained — its absence would read as the
         page having no untraced requests rather than none being detected yet. */
      bindings.add(bindHidden(badge, () => !showUntracedBadge()));
    }

    bindings.add(bindAttr(button, "aria-selected", () => tab() === item.id));
    bindings.add(bindClass(button, "on", () => tab() === item.id));
    bindings.add(on(button, "click", () => selectTab(item.id)));
    tabs.appendChild(button);
  }

  const buffered = el("span", "buffered");
  buffered.textContent = "buffered: true";
  buffered.title =
    "Every observer is registered with buffered: true, so the toolbar receives entries from page start even though it mounted later.";
  tabs.appendChild(buffered);

  /* ── body ── */
  const body = el("div", "body");
  const empty = el("div", "empty");
  const emptyText = document.createTextNode("");
  empty.appendChild(emptyText);
  bindings.add(
    bindText(emptyText, () => {
      const which = tab();
      if (which === "requests") return "The requests view lands with add-requests-view.";
      if (which === "vitals") return "The vitals view lands with add-vitals-view.";
      return "The untraced view lands with add-untraced-view.";
    }),
  );
  body.appendChild(empty);

  /* ── footer observer strip ── */
  const foot = el("div", "foot");
  for (const tier of TIERS) {
    const item = el("span", "tier");
    item.dataset.state = tier.state;
    const dot = el("i", "tdot");
    const text = el("span");
    text.textContent = tier.label;
    item.append(dot, text);
    foot.appendChild(item);
  }

  const perturb = el("span", "perturb");
  /* A measured zero until add-self-attribution supplies a real figure. It is not a claim
     about this session — it is the slot the claim will occupy. */
  perturb.textContent = "Δ INP 0.0ms";
  foot.appendChild(perturb);

  panel.append(head, tabs, body, foot);
  root.appendChild(panel);

  /* Show and hide follow the signal, so every route into the panel — click, shortcut,
     Escape, the close button — goes through one place. */
  let wasOpen = false;
  bindings.add(
    effect(() => {
      const isOpen = open();
      if (isOpen === wasOpen) return;
      wasOpen = isOpen;
      try {
        if (isOpen) panel.showPopover();
        else panel.hidePopover();
      } catch {
        /* `showPopover` throws if the element is already in that state, which can happen
           if the host page moved it. The signal remains the source of truth. */
      }
      if (isOpen) close.focus();
      else onClose();
    }),
  );

  bindings.add(
    on(panel, "keydown", (event) => {
      if (event.key !== "Escape") return;
      /* Stopped here so Escape never reaches the host page's own handlers while the panel
         has focus — a customer's modal must not close because we were open. */
      event.preventDefault();
      event.stopPropagation();
      shellEscape();
    }),
  );

  open.set(true);

  return {
    show() {
      open.set(true);
    },
    close() {
      open.set(false);
    },
    destroy() {
      bindings.dispose();
      panel.remove();
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
    },
  };
}
