import { bindAttr, bindHidden, bindText, on } from "@d0bar/signals/bind";
import { effect, scope, signal } from "@d0bar/signals/signal";
import { classify } from "../../../collector/coverage";
import { traceContext, type TraceContext } from "../../../collector/correlate";
import { scratch, type RequestRecord } from "../../../shared/record";
import type { Tier1Access, Tier2State } from "../../../shared/stage2";
import type { LogRecord } from "../../../shared/protocol";
import {
  connection,
  open,
  openLog,
  popToList,
  selected,
  selectedSpan,
  view,
} from "../../shell";
import { traceJumpAvailable } from "../../tier";
import { virtualList, type VirtualList } from "../../virtual";
import { displayPath, formatDuration } from "../requests/format";
import { formatLogOffset, severityBand, UNATTACHED_LABEL } from "./logcopy";
import { valueText as logValueText } from "../log";
import { CAUSE_COPY } from "../untraced/copy";
import {
  CEILING,
  createTraceMachine,
  inputFor,
  NO_SPANS,
  RANGE_MS,
  spanScratch,
  TIER2_OFF_COPY,
  TIER2_PENDING_COPY,
  UNQUERYABLE_COPY,
  type SpanRow,
  type SpanRows,
  type TraceMachine,
  type TraceMachineOptions,
  type TraceQuery,
  type TraceState,
} from "../../../trace/traceMachine";

/**
 * The trace surface, pushed over the request list. Its job is keeping four readings apart — found,
 * waiting, `unqueryable`, and no span at all — and making the last impossible to mistake for the
 * others. The decision is `src/trace/traceMachine.ts`'s and is node-tested; this file paints.
 *
 * The query is now wired: `add-pasted-token` supplied the credential and `add-trace-layout-worker`
 * the off-thread layout, so `panel/index.ts` passes a real `TraceQuery`. (Parsing OTLP here instead
 * would put a multi-millisecond parse on the main thread of the page whose INP this reports.)
 *
 * `unqueryable` remains a distinct reading rather than a fudged one: the span exists and *d0bar*
 * cannot ask about it — see `UNQUERYABLE_COPY`. And with tier 2 off (the default without a worker
 * path) nothing carries a traceparent, so every selection resolves to no-span via {@link inputFor}
 * and no query is attempted.
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
   * Ring indices the worker produced a record for — the untraced tab's set, read at selection time
   * rather than captured. Separates a request the worker watched go out bare from one it never saw.
   * Defaults empty, classifying every same-origin application request as `unseen` — the honest
   * answer for a caller with no worker knowledge to give.
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
   * Resolves a record's `contextId` to tier 2's observed trace context. Defaults to `correlate.ts`'s
   * side table; injectable so a test can drive the found and waiting surfaces without IndexedDB, a
   * service worker and a join.
   */
  context?: (id: number) => TraceContext | undefined;
  /**
   * Machine tuning, passed through. Nothing shipped sets it: it exists so a test can drive the
   * backoff, ceiling and countdown against a fake clock rather than waiting out four real
   * doublings, which is a six-second test nobody runs.
   */
  machine?: Omit<TraceMachineOptions, "query" | "now">;
}

export interface TraceView {
  readonly el: HTMLElement;
  /** The machine, exposed for tests and for teardown. */
  readonly machine: TraceMachine;
  /**
   * Moves focus onto the back button. Not cosmetic: Escape is bound on the panel element, not the
   * document (a host-document listener is the thing this project will not add), so it only works
   * while focus is inside the panel. A row click hides the row that had focus, the browser moves
   * focus to `<body>` outside the shadow root, and Escape silently stops popping the surface.
   * Observed in Chromium against the fixture.
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
      () => !(state().name === "found" && spans().count > 0 && isTruncated()),
    ),
  );

  function currentSummary() {
    const at = state();
    return at.name === "found" ? at.summary : null;
  }
  function spans(): SpanRows {
    return currentSummary()?.rows ?? NO_SPANS;
  }
  function isTruncated(): boolean {
    return currentSummary()?.truncated ?? false;
  }

  /**
   * One record, reused for every row: rows live in a transferred buffer and are read into it on
   * demand, so scrolling a 4000-span trace allocates a viewport's worth of strings and nothing else.
   * The request list's scratch pattern, and why the worker's output is an accessor, not an array.
   */
  const spanRecord: SpanRow = spanScratch();

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
    if (!found || !spans().read(index, spanRecord)) {
      row.hidden = true;
      return;
    }
    const span = spanRecord;
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
    /* A widened bar is a rendering decision, not a measurement — marked so a zero-duration
       span is not read as a short one. */
    row.dataset["degenerate"] = String(span.degenerate);
    /* Set from the shared flag the worker wrote: only it could resolve a log's `spanId` to a row,
       so this is the one place the relationship is visible from the span's side. */
    row.dataset["haslog"] = String(span.hasLog);
    row.dataset["picked"] = String(index === selectedSpan());
  }

  /* ── correlated logs ──
     Native `<details>`, not a bound `open` signal over a hidden div: focusability, Enter and Space,
     and the expanded state announced to a screen reader all come from the platform. Each of those
     is otherwise a line of stage-2 bytes and a thing to get wrong. */
  const logFoot = document.createElement("details");
  logFoot.className = "trace-log";
  const logSummary = document.createElement("summary");
  logSummary.className = "trace-log-sum";
  const logLevel = el("span", "trace-log-level");
  const logLevelText = text(logLevel);
  const logMessage = el("span", "trace-log-msg");
  const logMessageText = text(logMessage);
  const logLink = el("span", "trace-log-link");
  const logLinkText = text(logLink);
  logSummary.append(logLevel, logMessage, logLink);

  /** The severest record, derived — not a second field that can disagree with the list. */
  const worstLog = (): LogRecord | undefined => {
    const logs = currentSummary()?.logs;
    if (!logs || logs.length === 0) return undefined;
    let worst = logs[0]!;
    /* Strictly greater, so the *earliest* record at the worst severity wins — it is the one that
       explains the others. `readLogs` caps by severity, so the severest is never the record the
       cap dropped and this can never name a log absent from the list below. */
    for (const log of logs) if (log.severity > worst.severity) worst = log;
    return worst;
  };

  bindings.add(bindText(logLevelText, () => worstLog()?.level ?? ""));
  bindings.add(
    bindText(logMessageText, () => {
      const log = worstLog();
      if (!log) return "";
      return logValueText(log.body, log.bodyKind);
    }),
  );
  bindings.add(
    bindText(logLinkText, () => {
      const summary = currentSummary();
      const count = summary?.logCount ?? 0;
      const shown = summary?.logs.length ?? 0;
      /* Both numbers when the cap bit: "200 correlated logs" on a trace holding 4000 is a count of
         what this panel chose to keep, presented as a count of what the trace has. */
      if (shown < count) return `${shown} of ${count} correlated logs`;
      return count === 1 ? "1 correlated log" : `${count} correlated logs`;
    }),
  );

  const logList = el("div", "trace-log-list");

  /**
   * The log rows, rebuilt when the summary changes.
   *
   * Not virtualized, unlike the spans: bounded by `LOG_CAP`, built only once a reader has opened
   * the disclosure on an already-open panel, and two orders of magnitude smaller than the row
   * count the virtualizer exists for.
   *
   * Each row carries **two labelled targets, not one gesture resolved by position**: the row opens
   * the record, and a span badge — present only when the worker resolved a row — selects that span.
   * Sibling buttons in a grid, because nesting buttons is invalid HTML. The row action is the one
   * that works for every record, including the ones with no span; making the primary click select
   * the span would mean the same gesture doing different things depending on the row.
   *
   * Both actions arrive through **one delegated listener** on the list, registered once into
   * `bindings`. Per-button listeners here would either be added outside the binding scope — the
   * thing the rest of this file registers through `on()` precisely to avoid — or added to it on
   * every repaint, growing the scope's disposer list for nodes that no longer exist. The index
   * lives on the row's `data-log`, so the record a click resolves to is read at click time from
   * the list the effect last painted.
   */
  function paintLogs(): void {
    const logs = currentSummary()?.logs ?? [];
    logList.replaceChildren();
    for (const [index, log] of logs.entries()) {
      const row = el("div", "log-row");
      row.dataset["unattached"] = String(log.unattached !== 0);
      row.dataset["log"] = String(index);

      const openBtn = el("button", "log-open");
      openBtn.type = "button";
      const lvl = el("span", "log-lvl");
      lvl.textContent = log.level;
      lvl.dataset["sev"] = severityBand(log.severity);
      const off = el("span", "log-off");
      off.textContent = `+${formatLogOffset(log.offsetNs)}`;
      const msg = el("span", "log-msg");
      msg.textContent =
        log.bodyKind === "absent"
          ? "⟨no body⟩"
          : logValueText(log.body, log.bodyKind) || "⟨empty⟩";
      openBtn.append(lvl, off, msg);
      openBtn.title = "Open this log record";
      row.appendChild(openBtn);

      if (log.row >= 0) {
        const jump = el("button", "log-span");
        jump.type = "button";
        jump.textContent = "span";
        jump.title = "Select the span this log names";
        row.appendChild(jump);
      } else {
        /* Labelled, not omitted and not disabled-with-no-reason. Three distinct readings, and the
           `span-capped` one exists so the panel never says a span is absent from a trace that
           contains it. */
        const why = el("span", "log-nospan");
        why.textContent = UNATTACHED_LABEL[log.unattached as Exclude<typeof log.unattached, 0>];
        row.appendChild(why);
      }
      logList.appendChild(row);
    }
  }

  bindings.add(effect(paintLogs));

  bindings.add(
    on(logList, "click", (event: Event) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest<HTMLElement>(".log-open, .log-span");
      if (!button) return;
      const index = Number(button.closest<HTMLElement>(".log-row")?.dataset["log"] ?? -1);
      const log = currentSummary()?.logs[index];
      if (!log) return;
      if (button.classList.contains("log-span")) selectSpanRow(log.row);
      else openLog(index);
    }),
  );

  /**
   * Scrolls a span row into view and marks it selected.
   *
   * Centred rather than scrolled to the top: a span's meaning is its position relative to its
   * neighbours, and a row pinned to the first line of the viewport hides the parent above it.
   */
  function selectSpanRow(row: number): void {
    selectedSpan.set(row);
    const viewport = list.el.clientHeight;
    const target = row * SPAN_ROW_HEIGHT - Math.max(viewport / 2 - SPAN_ROW_HEIGHT, 0);
    list.setScrollTop(Math.max(target, 0));
    list.invalidate();
  }

  logFoot.append(logSummary, logList);
  /* Hidden when the trace has no correlated logs. An empty disclosure reading "0 correlated
     logs" would occupy the row the reader scans for a warning. */
  bindings.add(bindHidden(logFoot, () => (currentSummary()?.logs.length ?? 0) === 0));

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
        if (at.why !== "tier-2-off") return CAUSE_COPY[at.why];
        /* Two readings behind one classifier value. `tier-2-off` means "the worker saw nothing",
           which is true whether the worker cannot run here or simply is not controlling the page
           yet — and only one of those is the developer's to fix. */
        return options.tier2().kind === "pending" ? TIER2_PENDING_COPY : TIER2_OFF_COPY;
      }
      return "";
    }),
  );
  /**
   * `seen by the SW` is a claim about an observation, so it appears only where one happened.
   * `not-propagated` is *defined* as the worker holding a record with no traceparent on it — the one
   * cause that entails it. `unseen` is its complement and used to print the line anyway, telling
   * the reader the worker saw a request it explicitly did not; the other four are decided before
   * the worker is consulted at all.
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
      /* Not "the trace did not become queryable" any more. That sentence named ingest lag as the
         cause of a 404, and 404 has two — not ingested yet, and not in this dataset. It was wrong
         in the field: spans that had been in Dash0 for six minutes read as never having arrived,
         because the query went to `default` and the token's dataset was not `default`. What is
         actually known is the query and its answer, so that is what this says. */
      if (at.name === "exhausted") return "No trace with this id in the connected dataset.";
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
        /* Both causes, and the dataset that was queried — the developer is the only one who can
           tell which it is, and they cannot without knowing what was asked. The elapsed-time
           prefix stays in front of it: it is what makes ingest lag implausible when the request
           finished minutes ago, and so it is what points at the other cause. */
        return `${when}Either it has not been ingested, or it is not in “${connection().dataset}” — d0bar cannot tell which, and stopped retrying rather than polling indefinitely.`;
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
      /* `"log"` counts as live: the detail view is pushed *over* the trace and renders a record
         out of its summary, so deselecting on the view change would abort the query and discard
         the very record the reader just opened. */
      const live = open() && (view() === "trace" || view() === "log");
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
      list.setCount(summary ? summary.rows.count : 0);
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
