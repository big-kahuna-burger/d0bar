import { bindAttr, bindHidden, bindText, on } from "spark-signals/bind";
import { effect, scope, signal } from "spark-signals/signal";
import { classify } from "../../../collector/coverage";
import { traceContext, type TraceContext } from "../../../collector/correlate";
import { scratch, type RequestRecord } from "../../../shared/record";
import type { Tier1Access, Tier2State } from "../../../shared/stage2";
import { connection, open, popToList, selected, view } from "../../shell";
import { traceJumpAvailable } from "../../tier";
import { virtualList, type VirtualList } from "../../virtual";
import { displayPath, formatDuration } from "../requests/format";
import { CAUSE_COPY } from "../untraced/copy";
import {
  CEILING,
  createTraceMachine,
  inputFor,
  RANGE_MS,
  TIER2_OFF_COPY,
  UNQUERYABLE_COPY,
  type SpanRow,
  type TraceMachine,
  type TraceMachineOptions,
  type TraceQuery,
  type TraceState,
} from "../../../trace/traceMachine";

/**
 * The trace surface, pushed over the request list.
 *
 * Its whole job is to keep three readings apart — the trace was found, the trace is not
 * queryable *yet*, and no span exists at all — and to make the third impossible to mistake
 * for the second. Everything that decides which one applies is in
 * `src/trace/traceMachine.ts` and is a node test; this file paints the result and owns no
 * policy of its own.
 *
 * **The query is not built, and the reason changed.** It was the credential; `add-pasted-token`
 * shipped that, and the worker will now issue an authenticated call for anyone who connects a
 * token. What is still missing is the other end: a `TraceQuery` must return a laid-out
 * {@link TraceSummary}, and producing one from a response body means parsing OTLP JSON —
 * thousands of spans — which `add-trace-layout-worker` exists to do off-thread and has not been
 * built. Doing it here instead would put a multi-millisecond parse on the main thread of the
 * page whose INP this toolbar is reporting, which is the one trade this project refuses.
 *
 * So `options.query` is left undefined in `panel/index.ts` and the machine's `unqueryable`
 * state is what a real deployment sees for an instrumented request today. That is a fourth
 * reading, not a fudged version of one of the three: it says the span exists and that *d0bar*
 * cannot ask about it. With a token connected it now says so in those words — see
 * `UNQUERYABLE_COPY`.
 *
 * With tier 2 off — the default on any origin that has not been given a worker path — no
 * request carries a traceparent at all, so every selection resolves to the no-span state
 * through {@link inputFor}, and no query is ever attempted.
 */

/** Row height for the span list. Matches the handoff's 6px-padded rows. */
const SPAN_ROW_HEIGHT = 22;

/** How often the ingest countdown redraws. One decimal place needs nothing finer. */
const TICK_MS = 100;

/** Shared, because the default is read on every selection and a fresh `Set` each time is litter. */
const EMPTY_SEEN: ReadonlySet<number> = new Set<number>();

export interface TraceViewOptions {
  tier1: Tier1Access;
  /** Tier 2's live state, read reactively — registration can complete after the panel opens. */
  tier2(): Tier2State;
  origin?: string;
  /**
   * Ring indices the service worker produced a record for — the same set the untraced tab
   * classifies against, read at selection time rather than captured.
   *
   * It is what separates a request the worker watched go out bare from one it never saw, and
   * without it this surface cannot use the coverage classifier at all. Defaults to empty, which
   * classifies every same-origin application request as `unseen` — the honest answer for a
   * caller that has no worker knowledge to give.
   */
  seen?: () => ReadonlySet<number>;
  /**
   * The backend query. Absent in every shipped path today — see the note above. Injected so
   * that the machine, the backoff and the cancellation guarantee are driven by a fake in
   * tests rather than by a network.
   */
  query?: TraceQuery;
  /** Injected for tests. Wall clock, and the document's `timeOrigin`. */
  now?: () => number;
  timeOrigin?: number;
  /**
   * Resolves a ring record's `contextId` to the trace context tier 2 observed.
   *
   * Defaults to `correlate.ts`'s side table, which `flushCorrelation` populates in this same
   * bundle. Injectable so a test can drive the found and waiting surfaces without standing
   * up IndexedDB, a service worker and a join.
   */
  context?: (id: number) => TraceContext | undefined;
  /**
   * Machine tuning, passed straight through.
   *
   * Nothing in shipped code sets this. It exists so a test can drive the backoff, the ceiling
   * and the countdown against a fake clock instead of waiting out four real doublings — the
   * alternative is a six-second test, which is a test nobody runs.
   */
  machine?: Omit<TraceMachineOptions, "query" | "now">;
}

export interface TraceView {
  readonly el: HTMLElement;
  /** The machine, exposed for tests and for teardown. */
  readonly machine: TraceMachine;
  /**
   * Moves focus onto the back button.
   *
   * Not cosmetic, and not only an accessibility nicety. Escape is bound on the panel element
   * rather than on the document, because a listener on the host's document is the one thing
   * this project will not add — so Escape only works while focus is inside the panel. A row
   * click pushes this surface and hides the row that had focus, at which point the browser
   * moves focus to `<body>`, outside the shadow root, and Escape silently stops popping the
   * surface. Observed in Chromium against the fixture, not reasoned about.
   */
  focus(): void;
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

function text(parent: HTMLElement, value = ""): Text {
  const node = document.createTextNode(value);
  parent.appendChild(node);
  return node;
}

function setText(node: Text, value: string): void {
  if (node.data !== value) node.data = value;
}

interface SpanParts {
  swatch: HTMLElement;
  name: HTMLElement;
  label: Text;
  service: Text;
  fill: HTMLElement;
  duration: Text;
}

export function traceView(options: TraceViewOptions): TraceView {
  const tier1 = options.tier1;
  const origin = options.origin ?? location.origin;
  const now = options.now ?? (() => Date.now());
  const timeOrigin = options.timeOrigin ?? performance.timeOrigin;
  const contextOf = options.context ?? traceContext;
  const seenByWorker = options.seen ?? (() => EMPTY_SEEN);
  const record: RequestRecord = scratch();
  const bindings = scope();

  const machine = createTraceMachine({
    ...options.machine,
    ...(options.query ? { query: options.query } : {}),
    /* Custody decides which absence this is, and the shell already holds it. Read through a
       callback so a token connected while the panel is open changes the next reading. */
    unqueryable: () => (connection().connected ? "not-wired" : "not-connected"),
    now,
  });

  /* The machine's state, mirrored into a signal so the bindings below are the only thing
     that ever touches the DOM. The machine itself knows nothing about rendering. */
  const state = signal<TraceState>(machine.state());
  const stopMachine = machine.subscribe((next) => state.set(next));

  /* Redrawn while a backoff is counting down, and only then. */
  const tick = signal(now());

  /** The selected request, re-read on demand. Never retained — the ring may move under us. */
  function readSelected(): RequestRecord | null {
    const index = selected();
    if (index < 0) return null;
    return tier1.read(index, record) ? record : null;
  }

  const root = el("div", "trace");

  /* ── sub-header ── */
  const head = el("div", "trace-head");
  const back = el("button", "trace-back");
  back.type = "button";
  back.textContent = "← requests";
  bindings.add(on(back, "click", () => popToList()));

  const request = el("span", "trace-req");
  const requestText = text(request);

  const traceId = el("span", "trace-id");
  const traceIdText = text(traceId);
  head.append(back, request, traceId);

  bindings.add(
    bindText(requestText, () => {
      const found = readSelected();
      if (!found) return "";
      const method = found.method ? `${found.method} ` : "";
      return method + displayPath(found.url, origin);
    }),
  );

  bindings.add(
    bindText(traceIdText, () => {
      const at = state();
      if ("traceId" in at && at.traceId) return at.traceId;
      return "no traceparent";
    }),
  );
  /* A join that had a same-URL sibling in flight is flagged low confidence by `join.ts`, and
     the id it produced may belong to the sibling. Marked here rather than presented as
     certain — an id the panel is not sure of is worse than no id, because it is actionable. */
  bindings.add(
    bindAttr(traceId, "data-uncertain", () => {
      const found = readSelected();
      const context = found ? contextOf(found.contextId) : undefined;
      return context !== undefined && !context.confident;
    }),
  );

  /* ── 7a · trace found ── */
  const foundEl = el("div", "trace-found");

  const meta = el("div", "trace-meta");
  const metaCounts = el("span");
  const metaCountsText = text(metaCounts);
  const metaRange = el("span");
  metaRange.textContent = `timeRange ±${(RANGE_MS / 1000).toFixed(0)}s`;
  const metaCost = el("span", "trace-cost");
  const metaCostText = text(metaCost);
  meta.append(metaCounts, metaRange, metaCost);

  bindings.add(
    bindText(metaCountsText, () => {
      const at = state();
      if (at.name !== "found") return "";
      const s = at.summary;
      return `${s.spanCount} spans · ${s.serviceCount} services · ${s.logCount} logs`;
    }),
  );
  /* The handoff prints `flattened in worker · 0 ms on main thread`. A zero nobody measured
     is the most flattering number this panel could print about itself, so it is printed only
     from a value the layout actually reported. */
  bindings.add(
    bindText(metaCostText, () => {
      const at = state();
      if (at.name !== "found" || at.summary.mainThreadMs === null) return "";
      return `flattened in worker · ${at.summary.mainThreadMs.toFixed(1)} ms on main thread`;
    }),
  );
  bindings.add(
    bindHidden(metaCost, () => {
      const at = state();
      return at.name !== "found" || at.summary.mainThreadMs === null;
    }),
  );

  const truncated = el("div", "trace-trunc");
  truncated.textContent =
    "The backend returned more spans than it sent. This waterfall is incomplete.";
  bindings.add(
    bindHidden(
      truncated,
      () => !(state().name === "found" && spans().length > 0 && isTruncated()),
    ),
  );

  function currentSummary() {
    const at = state();
    return at.name === "found" ? at.summary : null;
  }
  function spans(): SpanRow[] {
    return currentSummary()?.spans ?? [];
  }
  function isTruncated(): boolean {
    return currentSummary()?.truncated ?? false;
  }

  /* ── span rows ──
     The same virtualizer as the request list, for the same reason: a four-thousand-span
     trace must cost a viewport's worth of nodes, not four thousand. */
  const parts = new WeakMap<HTMLElement, SpanParts>();

  const list: VirtualList = virtualList({
    rowHeight: SPAN_ROW_HEIGHT,
    create: createSpanRow,
    update: updateSpanRow,
    /* Requirement: nothing paints while the panel is closed, while another surface is
       showing, or while the document is hidden. Read, not subscribed. */
    enabled: () => open.peek() && view.peek() === "trace" && tier1.visible(),
  });
  list.el.classList.add("spans");
  list.el.setAttribute("role", "rowgroup");
  list.el.setAttribute("aria-label", "Spans");

  function createSpanRow(): HTMLElement {
    const row = el("div", "span-row");
    row.setAttribute("role", "row");

    const name = el("span", "span-name");
    const swatch = el("i", "span-swatch");
    const label = el("span", "span-label");
    const labelText = text(label);
    const service = el("span", "span-service");
    const serviceText = text(service);
    name.append(swatch, label, service);

    const bar = el("span", "span-bar");
    const fill = el("i", "span-fill");
    bar.appendChild(fill);

    const duration = el("span", "span-dur");
    const durationText = text(duration);

    row.append(name, bar, duration);
    parts.set(row, {
      swatch,
      name,
      label: labelText,
      service: serviceText,
      fill,
      duration: durationText,
    });
    return row;
  }

  function updateSpanRow(row: HTMLElement, index: number): void {
    const found = parts.get(row);
    const span = spans()[index];
    if (!found || !span) {
      row.hidden = true;
      return;
    }
    setText(found.label, span.name);
    setText(found.service, span.service);
    setText(found.duration, formatDuration(span.durationMs));
    /* Indent as a custom property rather than an inline `padding-left`, so the row's own
       rule owns the geometry and a depth change is one property write. */
    found.name.style.setProperty("--depth", String(span.depth));
    /* Wrapped into the nine-slot palette rather than trusted: a summary claiming service
       index 40 would otherwise write a `var()` that resolves to nothing and paint an
       invisible bar. */
    const colour = `var(--d0-series-${((span.colorIndex % 9) + 9) % 9})`;
    found.swatch.style.background = colour;
    found.fill.style.background = colour;
    row.style.setProperty("--l", String(span.left));
    row.style.setProperty("--w", String(span.width));
    /* The root span carries the intense colour; everything below it does not. */
    row.dataset["root"] = String(span.depth === 0);
    row.dataset["orphan"] = String(span.orphan);
    row.dataset["error"] = String(span.error);
  }

  /* ── correlated-log footer ── */
  const logFoot = el("div", "trace-log");
  const logLevel = el("span", "trace-log-level");
  const logLevelText = text(logLevel);
  const logMessage = el("span", "trace-log-msg");
  const logMessageText = text(logMessage);
  const logLink = el("span", "trace-log-link");
  const logLinkText = text(logLink);
  logFoot.append(logLevel, logMessage, logLink);

  bindings.add(bindText(logLevelText, () => currentSummary()?.log?.level ?? ""));
  bindings.add(bindText(logMessageText, () => currentSummary()?.log?.message ?? ""));
  bindings.add(
    bindText(logLinkText, () => {
      const count = currentSummary()?.logCount ?? 0;
      return count === 1 ? "1 correlated log" : `${count} correlated logs`;
    }),
  );
  /* Hidden when the trace has no correlated logs. An empty footer reading "0 correlated
     logs" would occupy the row the reader scans for a warning. */
  bindings.add(bindHidden(logFoot, () => (currentSummary()?.logCount ?? 0) === 0));

  foundEl.append(meta, truncated, list.el, logFoot);
  bindings.add(bindHidden(foundEl, () => state().name !== "found"));

  /* ── 7b · no span exists ── */
  const noneEl = el("div", "trace-none");
  const ring = el("span", "trace-ring");
  const noneTitle = el("div", "trace-none-title");
  const noneTitleText = text(noneTitle);
  const noneWhy = el("div", "trace-none-why");
  const noneWhyText = text(noneWhy);
  const noneSw = el("div", "trace-none-sw");
  noneSw.textContent = "seen by the SW · never reached the backend";
  noneEl.append(ring, noneTitle, noneWhy, noneSw);

  bindings.add(
    bindText(noneTitleText, () => {
      const at = state();
      /* The headline names which of the two it is. "No trace query is configured" was the old
         single headline and it described d0bar's plumbing — true, and not the thing a developer
         looking at a missing span needs to read first. */
      if (at.name === "unqueryable") {
        return at.why === "not-connected"
          ? "Connect a token to fetch this span."
          : "This panel does not query spans yet.";
      }
      return "No span exists for this request.";
    }),
  );
  bindings.add(
    bindText(noneWhyText, () => {
      const at = state();
      if (at.name === "unqueryable") return UNQUERYABLE_COPY[at.why];
      /* The cause sentence is the untraced tab's, from the untraced tab's classifier. The two
         surfaces answer the same question about the same request, and a reader who checks one
         against the other has to find the same answer — which they would not have before, when
         this file derived its own coarser three-way version. */
      if (at.name === "none") {
        return at.why === "tier-2-off" ? TIER2_OFF_COPY : CAUSE_COPY[at.why];
      }
      return "";
    }),
  );
  /**
   * The `seen by the SW` line is a claim about an observation, so it appears only where the
   * observation happened — and the classifier now says exactly where that is.
   *
   * `not-propagated` is *defined* as "the worker held a record for this request and there was
   * no traceparent on it", so it is the one cause that entails the observation. `unseen` is its
   * complement and previously printed this line anyway, telling the reader the worker saw a
   * request it explicitly did not; the other four are decided before the worker is consulted at
   * all, so for them the claim is simply unknown.
   */
  bindings.add(
    bindHidden(noneSw, () => {
      const at = state();
      return !(at.name === "none" && at.why === "not-propagated");
    }),
  );
  bindings.add(
    bindHidden(noneEl, () => {
      const name = state().name;
      return name !== "none" && name !== "unqueryable";
    }),
  );

  /* ── 7c · waiting for ingest ── */
  const waitEl = el("div", "trace-wait");
  const dots = el("div", "lag-dots");
  for (let i = 0; i < 3; i += 1) dots.appendChild(el("span", "lag-dot"));
  const waitTitle = el("div", "trace-wait-title");
  const waitTitleText = text(waitTitle);
  const waitRetry = el("div", "trace-wait-retry");
  const waitRetryText = text(waitRetry);
  const waitWhy = el("div", "trace-wait-why");
  const waitWhyText = text(waitWhy);
  const retryButton = el("button", "trace-retry");
  retryButton.type = "button";
  retryButton.textContent = "Retry now";
  bindings.add(on(retryButton, "click", () => machine.retry()));
  waitEl.append(dots, waitTitle, waitRetry, waitWhy, retryButton);

  bindings.add(
    bindText(waitTitleText, () => {
      const at = state();
      if (at.name === "exhausted") return "The trace did not become queryable.";
      if (at.name === "failed") return "The trace query failed.";
      return "Trace not queryable yet — waiting for ingest.";
    }),
  );

  bindings.add(
    bindText(waitRetryText, () => {
      const at = state();
      if (at.name === "fetching") return `querying · attempt ${at.attempt} of ${CEILING}`;
      if (at.name === "waiting") {
        /* Read so the countdown re-derives on every tick, and on nothing else. */
        const seconds = Math.max(0, at.nextAt - tick()) / 1000;
        return `retry ${at.attempt} of ${CEILING} · next in ${seconds.toFixed(1)}s · backoff`;
      }
      if (at.name === "exhausted") return `${at.attempts} attempts · no more automatic retries`;
      if (at.name === "failed") return at.message;
      return "";
    }),
  );

  bindings.add(
    bindText(waitWhyText, () => {
      const at = state();
      if (at.name === "failed") {
        return "This is not a statement about the trace — the query itself did not complete.";
      }
      const found = readSelected();
      const ago = found
        ? Math.max(0, now() - (timeOrigin + found.startTime + found.duration))
        : 0;
      const when = found ? `The request finished ${formatDuration(ago)} ago. ` : "";
      if (at.name === "exhausted") {
        return `${when}d0bar stopped retrying rather than polling indefinitely.`;
      }
      return `${when}d0bar retries on a backoff and cancels in flight if you click another request.`;
    }),
  );

  /* Dots mean "something is on its way", which is true while querying or backing off and
     false once the machine has stopped. Hiding them at that point is the difference between
     a state that is waiting and one that has finished waiting. */
  bindings.add(
    bindHidden(dots, () => {
      const name = state().name;
      return name !== "fetching" && name !== "waiting";
    }),
  );
  bindings.add(
    bindHidden(retryButton, () => {
      const name = state().name;
      return name !== "exhausted" && name !== "failed";
    }),
  );
  bindings.add(
    bindHidden(waitEl, () => {
      const name = state().name;
      return (
        name !== "fetching" && name !== "waiting" && name !== "exhausted" && name !== "failed"
      );
    }),
  );

  root.append(head, foundEl, noneEl, waitEl);

  /* ── the countdown ──
     One interval, alive only while a backoff is actually running. A timer that keeps ticking
     behind a closed panel is a cost the host page pays for a number nobody is reading. */
  let ticker: ReturnType<typeof setInterval> | undefined;
  bindings.add(
    effect(() => {
      const running = state().name === "waiting" && open() && view() === "trace";
      if (running && ticker === undefined) {
        ticker = setInterval(() => tick.set(now()), TICK_MS);
      } else if (!running && ticker !== undefined) {
        clearInterval(ticker);
        ticker = undefined;
      }
    }),
  );

  /* ── selection → machine ──
     The one place a query is ever started. Closing the panel or leaving the surface selects
     null, which exits whatever state was live and aborts anything in flight. */
  bindings.add(
    effect(() => {
      const live = open() && view() === "trace";
      const index = selected();
      const tier2 = options.tier2();
      if (!live || index < 0) {
        machine.select(null);
        return;
      }
      if (!tier1.read(index, record)) {
        machine.select(null);
        return;
      }
      const context = contextOf(record.contextId);
      machine.select(
        inputFor({
          tier2Live: traceJumpAvailable(tier2),
          hasSpan: context !== undefined,
          /* `index` and `record` are both live here, so the classification is made against the
             same row the surface is about. Deferred: `inputFor` calls it only when there is no
             span to show, which is the minority of selections. */
          cause: () => classify(record, origin, seenByWorker().has(index)),
          traceId: context?.traceId ?? "",
          confident: context?.confident ?? true,
          at: timeOrigin + record.startTime + record.duration,
        }),
      );
    }),
  );

  /* Repaint the span list whenever the summary changes. */
  bindings.add(
    effect(() => {
      const summary = currentSummary();
      list.setCount(summary ? summary.spans.length : 0);
      list.invalidate();
    }),
  );

  return {
    el: root,
    machine,
    focus() {
      back.focus();
    },
    destroy() {
      if (ticker !== undefined) clearInterval(ticker);
      ticker = undefined;
      machine.stop();
      stopMachine();
      bindings.dispose();
      list.destroy();
      root.remove();
    },
  };
}
