import { bindAttr, bindClass, bindHidden, bindText, on } from "spark-signals/bind";
import { effect, scope } from "spark-signals/signal";
import panelCss from "./panel.css?inline";
import { flushCorrelation } from "../collector/correlate";
import { query as brokerQuery } from "./broker";
import { layoutClient } from "./layout-client";
import { createTraceQuery } from "../trace/query";
import { resolveTiers } from "./tier";
import { requestsView } from "./views/requests";
import { traceView } from "./views/trace";
import { connectView } from "./views/connect";
import { logView } from "./views/log";
import { connectedLine } from "./views/connect/copy";
import { untracedView } from "./views/untraced";
import { vitalsView } from "./views/vitals";
import type { OtelState, Tier1Access, Tier2State } from "../shared/stage2";
import {
  inpDelta,
  inpDeltaMode,
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
 * Stage 2: the panel. Loaded on first open (or a post-settle prefetch), so nothing here is on the
 * critical path — which is why it can afford a stylesheet and a few dozen nodes. Mounted into the
 * closed shadow root stage 1 already owns: no second host element, unreachable from the page.
 */

export interface PanelOptions {
  root: ShadowRoot;
  onClose(): void;
  /** Tier 2's state, resolved by stage 1. Passed, not imported — see the duplication rule in
   * `shared/stage2.ts`. */
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
 * The four tiers are additive, not alternatives: a dark tier subtracts a column rather than
 * downgrading the reading. Resolved by `tier.ts` from real capability checks; this file only paints
 * them. It used to be a constant with tier 2 hardcoded `off` — honest only by accident, and it
 * would have kept reading `off` after tier 2 shipped.
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
 * Hover tooltip, wrapping `trigger` in an anchor so the bubble positions against it. Not `title`:
 * a native tooltip cannot be positioned or themed, appears over the host's UI after an OS delay,
 * and renders as unstyled grey text — and every one of these strings explains provenance, the copy
 * that must not look like an accident. One bubble at a time, via the shared {@link tip} signal.
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
   * Ring indices the worker produced a record for; filled by the correlation flush. Empty until
   * then, and forever with tier 2 off — hence the untraced view asking whether coverage is
   * determinable first. A `Set`, not a record flag: this is stage 2's knowledge about stage 1's
   * ring, and a flag would spend a bit for one tab.
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

  /* A dot, not a word: status first, since the panel works without a token and only the trace jump
     needs one. Its tooltip carries the whole state, including where the token is kept. */
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
      /* ORDERING IS LOAD-BEARING: `tooltip()` assumes its trigger is already parented. A second,
         earlier `tooltip()` call here ran before `tabs.appendChild(button)`, so
         `trigger.replaceWith(anchor)` had no parent and did nothing — the anchor adopted the
         button, the append moved it back out, and the anchor was left detached with two live
         bindings still writing the count into it. Copy that existed, updated, and no pointer could
         reach. Verified in-browser (one anchor, not the two the first explanation predicted) and
         guarded by `tests/perf/untraced-view.spec.ts`.

         Reading first, explanation second — the number is what the reader hovered for. Bound, not
         set, so it is current rather than from when the panel opened. */
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

  /**
   * The footer's own-cost reading, pushed from the same vitals batch the cards render from.
   *
   * Read here rather than inside the vitals view because the footer is the shell's, not a tab's —
   * and it must be current whichever tab is open. `selfcost.ts` accrues on every long animation
   * frame, so the figure moves while the panel is open, which is the point: a developer who drives
   * the panel hard should watch d0bar's own number climb.
   */
  const pushSelfCost = (): void => {
    const { self } = options.tier1.vitals();
    inpDeltaMode.set(self.mode);
    inpDelta.set(self.mode === "unavailable" ? null : self.totalMs);
  };
  pushSelfCost();
  bindings.add(options.tier1.onVitals(pushSelfCost));
  const showVitals = () => tab() === "vitals" && view() === "list";
  bindings.add(bindHidden(vitals.el, () => !showVitals()));

  /**
   * The layout worker's client and the trace query on it. The worker is **not** started here:
   * `layoutClient` creates one lazily on the first trace and terminates it after an idle period, so
   * opening the panel costs a panel and a developer who never opens a trace never pays for a
   * thread. `unqueryable` stays reachable — what a selection means with no token connected, which
   * is fixable rather than a claim about the trace.
   */
  const layout = layoutClient();
  const trace0Query = createTraceQuery({
    send: brokerQuery,
    layout,
    /* Read at call time, not captured: the developer can reconnect to a different region with
       the panel open, and a captured origin would query the previous one and fail as an
       authorization error. */
    apiOrigin: () => connection().apiOrigin,
    /* Same reasoning, and the failure is quieter: a dataset carried over from a previous
       connection returns 404 rather than an authorization error, which reads as a trace that
       does not exist. Resolved by the worker, so this is never `""`. */
    dataset: () => connection().dataset,
  });

  /**
   * The trace surface, mounted alongside the list rather than swapped for it. With tier 2 off (the
   * default) nothing carries a traceparent, so every selection resolves to the no-span state
   * without reaching the query.
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
    query: trace0Query,
  });
  bindings.add(bindHidden(trace.el, () => view() !== "trace"));

  /* The connect surface, pushed like the trace one. A fourth tab for something a developer
     does once would sit permanently beside three that are read constantly. */
  const connectSurface = connectView();
  bindings.add(bindHidden(connectSurface.el, () => view() !== "connect"));

  /* One log record in full, pushed over the trace. Reads the live summary through the machine
     rather than being handed the array: a re-layout replaces the summary, and a captured array
     would leave this rendering a record the trace no longer contains. */
  const logSurface = logView({
    logs: () => {
      const at = trace.machine.state();
      return at.name === "found" ? at.summary.logs : [];
    },
  });
  bindings.add(bindHidden(logSurface.el, () => view() !== "log"));

  /* Focus follows the pushed surface, or Escape stops working the moment it opens. After the
     `hidden` binding: `focus()` on a hidden element is a no-op and effects run in registration
     order. */
  bindings.add(
    effect(() => {
      if (view() === "trace") trace.focus();
      if (view() === "connect") connectSurface.focus();
      if (view() === "log") logSurface.focus();
    }),
  );

  const empty = el("div", "empty");
  const emptyText = document.createTextNode("");
  empty.appendChild(emptyText);
  bindings.add(
    bindHidden(
      empty,
      () =>
        showRequests() ||
        showVitals() ||
        showUntraced() ||
        view() === "trace" ||
        view() === "connect" ||
        view() === "log",
    ),
  );
  /* Every tab is built now, so there is nothing left for this node to say. Kept rather than
     deleted: it is the slot a future tab lands in, and an empty body with no element at all
     is a layout that has never been rendered. */
  bindings.add(bindText(emptyText, () => ""));
  body.append(
    requests.el,
    vitals.el,
    untraced.el,
    trace.el,
    connectSurface.el,
    logSurface.el,
    empty,
  );

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
   * Per-tab scroll memory, tracked continuously rather than captured on leave: by the time a switch
   * is observed the old list may be torn down, and `scrollTop` on a detached node reads zero.
   * Passive — a non-passive scroll listener blocks the compositor until script runs, the exact cost
   * this toolbar exists not to impose.
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
   * Focus trap. The panel is a top-layer popover over a still-interactive page, so a Tab off the
   * last control otherwise lands in the customer's UI with no discoverable way back. `manual`
   * popover mode does not trap for us, and `<dialog>`'s modal mode would make the host inert.
   * Queried per keypress: the tab row changes with state, and a cached list traps focus on a node
   * that is gone.
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
   * `will-change` promotes the panel to its own layer for the entry animation and is removed the
   * moment it ends. Left on, it is a standing instruction to keep a layer for a static element —
   * memory the host pays for, which is not ours to spend.
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
   * The correlation flush, in stage 2 by design: the worker writes its log whether or not the panel
   * opens, but nothing *reads* it until someone looks, so the join, the interning and the ring
   * write-back cost a page that never opens the panel nothing. Not awaited — the panel paints from
   * tier 1 and fills tier 2 in on arrival, rather than waiting on IndexedDB for a field most rows
   * do not have.
   */
  /**
   * Coalesced, and re-entrant by design.
   *
   * One flush at a time: a batch arriving mid-flush sets `flushQueued` instead of starting a
   * second `readAll()` over the same store, and one more pass runs when the first settles. Without
   * the guard a burst of resource batches would put N concurrent full log reads on the page the
   * toolbar is supposed to be free on.
   *
   * The trailing pass is not optional. Dropping the batch that arrived during a flush would lose
   * exactly the records that batch was reporting, and on a page that then goes quiet nothing would
   * ever ask again — which is the bug this whole function is fixing, one flush later.
   */
  let flushing = false;
  let flushQueued = false;
  /* A flush in flight outlives `destroy()`: `stopFlush()` unsubscribes but cannot cancel the
     IndexedDB read already issued, and its `then` would repaint views that have been torn down. */
  let flushStopped = false;

  function runFlush(): void {
    if (flushStopped) return;
    if (flushing) {
      flushQueued = true;
      return;
    }
    flushing = true;
    /* Not awaited — the panel paints from tier 1 and fills tier 2 in on arrival, rather than
       waiting on IndexedDB for a field most rows do not have. */
    void flushCorrelation({
      tier2: options.tier2,
      since: performance.timeOrigin,
      tier1: options.tier1,
    })
      .then((result) => {
        if (flushStopped) return;
        tier2.set(result.tier2);
        /* Which ring records the worker produced a record for. The untraced view needs it to
           tell a request the worker watched go out bare from one it never saw at all — two
           different findings that would otherwise both read as "no trace id". */
        workerSaw = result.seen;
        /* Repaint: the flush wrote into the ring behind the list's back. Rows were painted from
           records with no trace id yet, and nothing else will repaint them — the list refreshes on
           a resource batch, and a quiet page may never produce another. Tier 2's chips had the
           same latent bug, invisible only because a busy fixture kept producing batches. */
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
      })
      .finally(() => {
        flushing = false;
        if (flushQueued) {
          flushQueued = false;
          runFlush();
        }
      });
  }

  runFlush();

  /**
   * And again on every resource batch, which is the actual fix.
   *
   * The worker logs every request whether or not anyone reads the log; the panel used to read it
   * exactly once, at open. So a request issued after that — every button click, every navigation
   * on an SPA — was recorded by the worker and never joined, and its row read untraced for the
   * life of the panel. Counted from page script: 28 records written, 1 read, 6 of them seen.
   *
   * `onBatch` is the right edge because it is the same signal the list already repaints on: a
   * resource entry for the request exists by then, so there is a ring slot for the join to land
   * in. Flushing off a worker message instead would arrive before the entry and find nothing.
   */
  const stopFlush = options.tier1.onBatch(runFlush);

  open.set(true);

  return {
    show() {
      open.set(true);
    },
    close() {
      open.set(false);
    },
    destroy() {
      /* Before the views, so neither a new batch nor a flush already in flight can reach a
         destroyed list. */
      flushStopped = true;
      stopFlush();
      bindings.dispose();
      requests.destroy();
      vitals.destroy();
      untraced.destroy();
      trace.destroy();
      /* Terminates the layout worker if one is still alive. A panel that closed while a trace
         was in flight must not leave a thread parsing something nobody will look at. */
      layout.destroy();
      connectSurface.destroy();
      logSurface.destroy();
      panel.remove();
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
    },
  };
}
