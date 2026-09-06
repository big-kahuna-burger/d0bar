import { bindAttr, bindClass, bindHidden, bindText, on } from "spark-signals/bind";
import { effect, scope } from "spark-signals/signal";
import panelCss from "./panel.css?inline";
import { flushCorrelation } from "../collector/correlate";
import { resolveTiers } from "./tier";
import { requestsView } from "./views/requests";
import { traceView } from "./views/trace";
import { connectView } from "./views/connect";
import { connectedLine } from "./views/connect/copy";
import { untracedView } from "./views/untraced";
import { vitalsView } from "./views/vitals";
import type { OtelState, Tier1Access, Tier2State } from "../shared/stage2";
import {
  escape as shellEscape,
  open,
  perturbation,
  recallScroll,
  rememberScroll,
  selectTab,
  dismissTip,
  hoverTip,
  showUntracedBadge,
  tab,
  connection,
  tier2,
  otel,
  tip,
  unhoverTip,
  untracedCount,
  untracedTooltip,
  view,
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
  /**
   * Tier 2's state, resolved by stage 1. Passed rather than imported: the two stages are
   * separate bundles and do not share module state, so `sw.ts`'s registration outcome does
   * not cross the boundary on its own.
   */
  tier2: Tier2State;
  /** Tier 4's state, resolved by stage 1. Passed for the same reason as `tier2`. */
  otel: OtelState;
  /** The ring, owned by stage 1 — see `Tier1Access`. */
  tier1: Tier1Access;
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

/**
 * The four observation tiers, in the order the handoff lists them.
 *
 * Additive, not alternatives: each answers a question the others cannot, so a tier going dark
 * subtracts a column rather than downgrading the whole reading.
 *
 * Resolved by `tier.ts` from real capability checks rather than declared here — this file
 * only paints them. The table used to be a constant with tier 2 hardcoded to `off`, which
 * was honest only by accident: it read correctly because tier 2 did not exist yet, and would
 * have gone on reading `off` after it did.
 */

function el<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

/**
 * Attaches a hover tooltip to `trigger`, wrapping it in an anchor so the bubble positions
 * against it.
 *
 * Deliberately not the `title` attribute. A native tooltip cannot be positioned, themed or
 * kept inside the panel; it appears over the host page's own UI after an OS-controlled delay,
 * and renders a sentence of explanation as unstyled grey text. Every one of these strings
 * explains provenance — the reason a number is trustworthy — which is exactly the copy that
 * must not look like an accident.
 *
 * Only one bubble is open at a time, enforced by the shared {@link tip} signal rather than by
 * each trigger clearing its neighbours.
 */
function tooltip(
  bindings: { add(dispose: () => void): void },
  trigger: HTMLElement,
  id: string,
  side: "above" | "below",
  content: { title?: string; body: string | (() => string) },
  align?: "end",
): HTMLElement {
  const anchor = el("span", "tip-anchor");
  trigger.replaceWith(anchor);
  anchor.appendChild(trigger);

  const bubble = el("span", "tip");
  bubble.dataset.side = side;
  if (align) bubble.dataset.align = align;
  bubble.setAttribute("role", "tooltip");
  if (content.title) {
    const strong = el("b");
    strong.textContent = content.title;
    bubble.append(strong, document.createTextNode(" "));
  }
  if (typeof content.body === "string") {
    bubble.appendChild(document.createTextNode(content.body));
  } else {
    /* Bound rather than set, for copy that is a reading: the untraced tab's number changes as
       requests stream in, and a bubble showing the count from the moment the panel opened
       would be a stale measurement presented as a current one. */
    const text = document.createTextNode("");
    bubble.appendChild(text);
    bindings.add(bindText(text, content.body));
  }
  anchor.appendChild(bubble);

  bindings.add(bindHidden(bubble, () => tip() !== id));
  bindings.add(on(anchor, "pointerenter", () => hoverTip(id)));
  bindings.add(on(anchor, "pointerleave", () => unhoverTip()));
  /* Keyboard reaches the same copy: a tooltip only a mouse can open is one a keyboard user
     is simply not told. */
  bindings.add(on(anchor, "focusin", () => hoverTip(id)));
  bindings.add(on(anchor, "focusout", () => unhoverTip()));
  return anchor;
}

/** The half of the untraced tab's tooltip that does not change — what the tab is for. */
const UNTRACED_TAB_NOTE =
  "Requests that left this page with no trace context, which is usually why a trace has a hole in it. Detecting one needs tier 2 or 4; with neither, this counts nothing rather than claiming zero.";

export function openPanel(options: PanelOptions): PanelHandle {
  const { root, onClose } = options;
  /**
   * Ring indices the service worker produced a record for, filled by the correlation flush.
   *
   * Empty until then, and empty forever when tier 2 is off — which is why the untraced view
   * asks whether coverage is determinable before it reads this at all. A `Set` rather than a
   * flag on the record: this is stage 2's knowledge about stage 1's ring, and writing it back
   * into the ring would spend a bit on something only one tab reads.
   */
  let workerSaw: ReadonlySet<number> = new Set();
  /* Before anything renders: the footer must never paint a stale `off` and then correct
     itself, because the corrected state is the one the user is least likely to be looking
     at when it changes. */
  tier2.set(options.tier2);
  otel.set(options.otel);
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

  const hint = el("span", "hint");
  hint.textContent = "⌘⇧0";

  /* The connect affordance. A dot rather than a word, because it is a status first — the
     panel works without a token, and only the trace jump needs one. Its tooltip carries the
     whole state, including where the token is kept, which is the part a developer needs to be
     able to check without hunting for it. */
  const conn = el("button", "conn-chip");
  conn.type = "button";
  const connDot = el("i", "conn-dot");
  const connText = document.createTextNode("Connect");
  conn.append(connDot, connText);
  bindings.add(
    bindText(connText, () => (connection().connected ? `…${connection().hint}` : "Connect")),
  );
  bindings.add(bindAttr(conn, "data-on", () => connection().connected));
  bindings.add(
    on(conn, "click", () => {
      dismissTip();
      view.set("connect");
    }),
  );
  tooltip(bindings, conn, "conn", "below", { body: () => connectedLine(connection()) });

  const close = el("button", "close");
  close.type = "button";
  close.setAttribute("aria-label", "Close d0bar");
  close.textContent = "✕";
  bindings.add(
    on(close, "click", () => {
      /* A bubble left open would outlive the panel it explains. */
      dismissTip();
      open.set(false);
    }),
  );

  head.append(title, url, hint, conn, close);
  /* The header clips the URL from the left, so the origin is the part that goes missing —
     and on a staging host the origin is often the only thing distinguishing two identical
     pages. The bubble carries the whole thing. */
  tooltip(bindings, url, "url", "below", { body: location.href });

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

    if (item.id === "untraced") {
      /* Attached after the badge and after the tab is in the DOM, so the anchor wraps the
         whole tab including its count.

         One tooltip, not two. The merge left this tab with a `tooltip()` call for the live
         reading and a second for the static explanation, and the first one was silently dead:
         it ran before `tabs.appendChild(button)`, so `trigger.replaceWith(anchor)` had no
         parent to replace into and did nothing. The anchor adopted the button, the append then
         moved the button straight back out, and the anchor — with its bubble and two live
         bindings still writing the count into it — was left detached from the document. The
         copy existed, updated correctly and could not be reached by any pointer.

         That is why the ordering here is load-bearing rather than incidental: `tooltip()`
         assumes its trigger is already parented. Verified against the browser (the probe that
         settled it found one anchor, not the two the first explanation of this bug predicted)
         and guarded by `tests/perf/untraced-view.spec.ts`.

         The reading leads and the explanation follows, because the number is what the reader
         hovered for. Bound rather than set, so it is the current count and not the one from
         when the panel opened. */
      tooltip(bindings, button, "untraced", "below", {
        body: () => `${untracedTooltip()} ${UNTRACED_TAB_NOTE}`,
      });
    }
  }

  const buffered = el("span", "buffered");
  buffered.textContent = "buffered: true";
  tabs.appendChild(buffered);
  tooltip(
    bindings,
    buffered,
    "buffered",
    "below",
    {
      title: "buffered: true.",
      body: "Every observer is registered this way, so the toolbar receives entries from page start even though it mounted later — which is what lets it stay out of the load phase for free.",
    },
    "end",
  );

  /* ── body ── */
  const body = el("div", "body");

  /* The requests view is mounted once and hidden, not created on tab entry: it holds the
     virtualizer's row pool and its scroll offset, and rebuilding both on every tab switch
     would trade a hidden subtree for a burst of DOM work in front of the user. */
  const requests = requestsView({ tier1: options.tier1 });
  const showRequests = () => tab() === "requests" && view() === "list";
  bindings.add(bindHidden(requests.el, () => !showRequests()));

  /* Mounted once and hidden, like the requests view. Cheaper than rebuilding four cards on
     every tab switch, and it keeps the view subscribed so a return to the tab paints the
     current reading rather than the one it was left on. */
  const vitals = vitalsView({ tier1: options.tier1 });
  const showVitals = () => tab() === "vitals" && view() === "list";
  bindings.add(bindHidden(vitals.el, () => !showVitals()));

  /**
   * The trace surface, mounted alongside the list rather than swapped for it.
   *
   * No `query` is passed. The credential is no longer what is missing — `add-pasted-token`
   * shipped it — but a `TraceQuery` has to return a laid-out summary, and turning a response
   * body into one is `add-trace-layout-worker`'s job and is not built. Parsing it here instead
   * would land the parse on the main thread being measured. So the boundary stays declared,
   * injected and driven by a fake in tests, and the machine renders it as `unqueryable`: a
   * statement about d0bar rather than a fourth way of saying "not found". With tier 2 off,
   * which is the default, no request carries a traceparent at all and the surface never gets
   * that far — every selection resolves to the no-span state.
   */
  /* Mounted once and hidden, like the other two. It also owns the untraced badge, which has
     to be right before anyone opens the tab — so this view exists and counts from the moment
     the panel does, whether or not it is ever looked at. */
  const untraced = untracedView({
    tier1: options.tier1,
    origin: location.origin,
    seen: () => workerSaw,
  });
  const showUntraced = () => tab() === "untraced" && view() === "list";
  bindings.add(bindHidden(untraced.el, () => !showUntraced()));

  /* Same `seen` set as the untraced tab, and deliberately the same source rather than a second
     one: the two surfaces classify the same request and must not be able to disagree. */
  const trace = traceView({
    tier1: options.tier1,
    tier2: () => tier2(),
    seen: () => workerSaw,
  });
  bindings.add(bindHidden(trace.el, () => view() !== "trace"));

  /* The connect surface, pushed like the trace one. A fourth tab for something a developer
     does once would sit permanently beside three that are read constantly. */
  const connectSurface = connectView();
  bindings.add(bindHidden(connectSurface.el, () => view() !== "connect"));

  /* Focus follows the pushed surface. Without this Escape stops working the moment the
     surface opens — see the note on `TraceView.focus`. Ordered after the `hidden` binding
     above, because a `focus()` on a hidden element is a no-op and the effect graph runs
     these in registration order. */
  bindings.add(
    effect(() => {
      if (view() === "trace") trace.focus();
      if (view() === "connect") connectSurface.focus();
    }),
  );

  const empty = el("div", "empty");
  const emptyText = document.createTextNode("");
  empty.appendChild(emptyText);
  bindings.add(
    bindHidden(
      empty,
      () =>
        showRequests() || showVitals() || showUntraced() || view() === "trace" || view() === "connect",
    ),
  );
  /* Every tab is built now, so there is nothing left for this node to say. Kept rather than
     deleted: it is the slot a future tab lands in, and an empty body with no element at all
     is a layout that has never been rendered. */
  bindings.add(bindText(emptyText, () => ""));
  body.append(requests.el, vitals.el, untraced.el, trace.el, connectSurface.el, empty);

  /* Repaint on the way back in. While hidden the view drops every batch on the floor by
     design, so returning from another tab has to catch up in one go — the next request
     might never arrive. */
  bindings.add(
    effect(() => {
      if (showRequests()) requests.refresh();
      if (showVitals()) vitals.refresh();
      if (showUntraced()) untraced.refresh();
    }),
  );

  /**
   * Scroll memory, per tab.
   *
   * Tracked continuously rather than captured at the moment of leaving: by the time a tab
   * switch or a trace push has been observed, the list it is leaving may already have been
   * torn down, and `scrollTop` on a detached or re-populated node reads zero. Keeping the map
   * current means the value is already right when it is needed.
   *
   * Passive, because the handler never calls `preventDefault` and a non-passive scroll
   * listener on a scroller blocks the compositor from scrolling until script has run — the
   * exact class of cost this toolbar exists not to impose.
   */
  bindings.add(
    on(body, "scroll", () => rememberScroll(tab.peek(), body.scrollTop), { passive: true }),
  );

  /* Restoring on the way back in. `view()` is read so returning from a trace restores too,
     not only a tab switch — Escape from the trace surface must land where the user left. */
  let lastKey = "";
  bindings.add(
    effect(() => {
      const key = `${view()}:${tab()}`;
      if (view() !== "list") return;
      if (key === lastKey) return;
      lastKey = key;
      /* Assigned unconditionally, including zero: arriving at a tab never scrolled must
         reset the shared scroller, or the new tab inherits the previous one's offset. */
      body.scrollTop = recallScroll(tab());
    }),
  );

  /* ── footer observer strip ── */
  const foot = el("div", "foot");
  /* Resolved once per tier, then bound: `tier2Live` is a signal because the scope can be
     lost or gained after the panel has mounted — a host worker that claims the scope, or a
     registration that has not finished when the panel is opened early. */
  const tiers = () => resolveTiers(tier2(), otel());

  for (let i = 0; i < 4; i += 1) {
    const at = () => tiers()[i] as ReturnType<typeof resolveTiers>[number];
    const item = el("span", "tier");
    const dot = el("i", "tdot");
    const text = el("span");
    const label = document.createTextNode(at().label);
    text.appendChild(label);
    item.append(dot, text);

    bindings.add(bindAttr(item, "data-state", () => at().state));
    /* The handoff spells the degraded tier `2 SW off`, not `2 SW` — the strip states the
       capability in the label as well as the dot, so a screenshot, a monochrome display or
       a colour-blind reader still carries the reading. `tier.ts` supplies both spellings. */
    bindings.add(bindText(label, () => at().label));
    /* Every tier explains itself, including the planned ones — "not built yet" is the whole
       content of that state and must not be left to the reader to infer from a hollow dot. */
    tooltip(bindings, text, `tier${i}`, "above", { body: at().detail });

    foot.appendChild(item);
  }

  /* The right-hand reading. Which of the three it shows is derived in `shell.ts`, so the
     ladder — degraded outranks measured, and unmeasured is never rendered as zero — is
     stated once and testable without a browser. This file only paints it. */
  const perturb = el("span", "perturb");
  const perturbText = document.createTextNode("");
  perturb.appendChild(perturbText);
  bindings.add(bindText(perturbText, () => perturbation().text));
  bindings.add(bindAttr(perturb, "data-state", () => perturbation().state));
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
        if (isOpen) {
          /* Set before the animation starts, so the promotion is in place for the first
             frame rather than one frame late. */
          panel.style.willChange = "transform, opacity";
          panel.showPopover();
        } else {
          panel.hidePopover();
        }
      } catch {
        /* `showPopover` throws if the element is already in that state, which can happen
           if the host page moved it. The signal remains the source of truth. */
      }
      if (isOpen) close.focus();
      else onClose();
    }),
  );

  /**
   * Focus trap.
   *
   * The panel is a top-layer popover over a page that is still fully interactive, so without
   * this a Tab off the last control lands somewhere in the customer's own UI with the panel
   * still open — and the way back is not discoverable. `manual` popover mode means the
   * browser does not do this for us, unlike `<dialog>`'s modal mode, which we cannot use
   * because it would make the host page inert.
   *
   * Queried per keypress rather than cached: the tab row's contents change with state, and a
   * stale list would trap focus on a node that is no longer there.
   */
  const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

  function focusable(): HTMLElement[] {
    return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (node) => !node.hidden && node.offsetParent !== null,
    );
  }

  bindings.add(
    on(panel, "keydown", (event) => {
      if (event.key !== "Tab") return;
      const nodes = focusable();
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      /* `getRootNode()` rather than `document.activeElement`, which reports the shadow host
         from outside and would make every comparison below false. */
      const active = (panel.getRootNode() as ShadowRoot).activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }),
  );

  /**
   * `will-change` promotes the panel to its own layer for the entry animation, and is removed
   * the moment it ends. Left on permanently it is a standing instruction to the compositor to
   * keep a layer for an element that is no longer animating — memory the host page pays for,
   * on a page whose memory is not ours to spend.
   */
  bindings.add(
    on(panel, "animationend", () => {
      panel.style.willChange = "";
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

  /**
   * The correlation flush.
   *
   * Deliberately here and not in stage 1. Registration has to happen whether or not the
   * panel is ever opened — the worker writes the log either way — but nothing *reads* that
   * log until someone is looking at it, so the join, the interning of leftovers and the ring
   * write-back all live in stage 2 and cost a page that never opens the panel nothing.
   *
   * Not awaited: the panel renders immediately with tier 1's data and fills in tier 2's when
   * it arrives. A panel that waited on IndexedDB before painting would make the toolbar feel
   * slow in exchange for a field that is meaningless on most rows anyway.
   */
  void flushCorrelation({
    tier2: options.tier2,
    since: performance.timeOrigin,
    tier1: options.tier1,
  })
    .then((result) => {
      tier2.set(result.tier2);
      /* Which ring records the worker produced a record for. The untraced view needs it to
         tell a request the worker watched go out bare from one it never saw at all — two
         different findings that would otherwise both read as "no trace id". */
      workerSaw = result.seen;
      /* Repaint, because the flush wrote into the ring behind the list's back.
     
         The rows were painted from records that had no trace id yet — the join is
         deliberately post-settle and asynchronous — and nothing else will repaint them: the
         list refreshes on a resource batch, and on a page that has gone quiet the next batch
         may never come. Tier 2's chips had the same latent bug and it was invisible because
         a busy fixture always produced another batch. */
      requests.refresh();
      /* The same repaint, for the same reason: the flush wrote trace ids into the ring, and
         a coverage count taken before it would report every request as a gap. This also
         updates the badge while the tab is not showing. */
      untraced.refresh();
    })
    .catch(() => {
      /* `flushCorrelation` is written not to reject; this is the belt to that braces. A
         failed join leaves the panel showing tier 1 only, which is exactly the degraded
         state it already knows how to render. */
    });

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
      requests.destroy();
      vitals.destroy();
      untraced.destroy();
      trace.destroy();
      connectSurface.destroy();
      panel.remove();
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
    },
  };
}
