/**
 * The trace query's state machine.
 *
 * **Not XState**, though the proposal named it and `shell.ts` deferred it to here. Measured with
 * `size-limit` against a probe importing exactly the surface this machine would use — not
 * estimated from package size:
 *
 * ```
 *   xstate v5 (setup/createMachine/createActor/assign/fromPromise/after)   13.10 kB gz
 *   stage-2 panel bundle                                                    9.85 kB gz
 *   stage-2 budget (.size-limit.json)                                      10.50 kB gz
 *   headroom                                                                0.65 kB
 * ```
 *
 * Twenty times the headroom, ~23 kB panel, for seven states and eleven transitions that fit in
 * this file — and raising the limit to absorb it is lowering a gate to make a decision pass.
 *
 * The property XState was wanted for — an in-flight query cancelled on state exit, so a stale
 * response can never overwrite the panel — is enforced here instead: a generation counter every
 * async continuation checks before writing, and {@link exit} as the only way to leave a state.
 * `tests/unit/trace-machine.test.ts` resolves a query after the selection moved and asserts the
 * panel never sees it.
 *
 * {@link TraceQuery} is injected, not owned: `src/trace/query.ts` implements it over the SW broker
 * and `src/panel/index.ts` passes it in. Constructed without one, the machine resolves to
 * {@link TraceState `unqueryable`} rather than pretending — distinct from all three outcomes the
 * spec forbids conflating.
 */

import type { Cause } from "../collector/coverage";

/** Half-width of the query's time range, in milliseconds. The handoff's `timeRange ±2s`. */
export const RANGE_MS = 2000;

/** Attempts before the machine gives up and offers a manual retry. */
export const CEILING = 5;

/** First backoff delay. Doubles per attempt, clamped to {@link MAX_DELAY_MS}. */
export const BASE_DELAY_MS = 400;

/**
 * Backoff ceiling. Not about cost: a countdown reading "next in 24s" has stopped indicating
 * progress and become a reason to close the panel. Reached at attempt 5, so the last two are
 * evenly spaced.
 */
export const MAX_DELAY_MS = 6400;

/** Exponential, clamped. `attempt` is 1-based: the delay *after* attempt n. */
export function backoffFor(attempt: number, base = BASE_DELAY_MS, max = MAX_DELAY_MS): number {
  if (attempt < 1) return base;
  return Math.min(base * 2 ** (attempt - 1), max);
}

/**
 * Why a request has no span at all — never a synonym for "not found yet". The six coverage causes
 * plus one this surface owns: `tier-2-off` is not a classification but the statement that none was
 * possible, which is why `coverage.ts` carries it as `determinable: false`.
 */
export type NoneCause = "tier-2-off" | Cause;

export interface TimeRange {
  from: number;
  to: number;
}

export interface TraceQueryRequest {
  traceId: string;
  /** Never omitted: without it the backend full-scans, and only the toolbar knows this
   * request's own timestamp to the millisecond. */
  timeRange: TimeRange;
}

/**
 * One span row, already laid out. `left`/`width` are fractions of the trace's duration, not pixels;
 * CSS turns them into geometry, so a resize is style recalc inside a contained row rather than a JS
 * layout pass.
 */
export interface SpanRow {
  name: string;
  service: string;
  depth: number;
  left: number;
  width: number;
  durationMs: number;
  /** Index into the auto palette, assigned per service by whatever produced this. */
  colorIndex: number;
  /** The span's parent is not in this trace. Rendered visibly rather than silently reparented. */
  orphan: boolean;
  error: boolean;
  /**
   * Zero-duration, bar widened to stay clickable. The width is then a rendering decision, not a
   * measurement, and must say so — otherwise it is indistinguishable from a 2 ms span.
   */
  degenerate: boolean;
}

/**
 * Laid-out spans, read one at a time into a caller-owned record. **Not an array** — that is the
 * point of the layout worker. Materialising the transferred typed arrays into four thousand objects
 * would put most of the allocation cost back on the thread whose INP the toolbar reports. The
 * virtualizer builds only a viewport's worth; same `read(index, out)` shape as the request ring.
 */
export interface SpanRows {
  readonly count: number;
  read(index: number, out: SpanRow): boolean;
}

/** A blank row, for callers that need a scratch record to read into. */
export function spanScratch(): SpanRow {
  return {
    name: "",
    service: "",
    depth: 0,
    left: 0,
    width: 0,
    durationMs: 0,
    colorIndex: 0,
    orphan: false,
    error: false,
    degenerate: false,
  };
}

/** An empty row set, for the states that have none. */
export const NO_SPANS: SpanRows = { count: 0, read: () => false };

export interface TraceSummary {
  spanCount: number;
  serviceCount: number;
  logCount: number;
  /** The backend returned more spans than it sent. The UI must say so. */
  truncated: boolean;
  rows: SpanRows;
  /** The single most severe correlated log, for the footer. Absent when there are none. */
  log?: { level: string; message: string };
  /**
   * Main-thread ms this flattening cost, or `null` when nothing measured it. **Null is not zero**:
   * `flattened in worker · 0 ms on main thread` is the most self-serving number this panel can
   * print, so unmeasured it is not printed.
   */
  mainThreadMs: number | null;
  /**
   * Worker ms, as the worker measured it, or `null`. The other half of the claim: "flattened in
   * worker" is only worth printing if the work it names happened somewhere.
   */
  workerMs: number | null;
}

export type TraceQueryOutcome =
  | { kind: "found"; summary: TraceSummary }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

/**
 * The query boundary; implemented by `src/trace/query.ts`. An implementation must hand the body to
 * the layout worker as *text* and return the worker's summary — `JSON.parse` on a 4000-span trace
 * is the exact perturbation this toolbar exists to avoid, and it would land while the panel is open
 * over a page still being measured. The machine never touches a response body.
 *
 * `signal` is aborted on every state exit: honouring it extends the cancellation guarantee to the
 * network, ignoring it leaks a fetch.
 */
export type TraceQuery = (
  request: TraceQueryRequest,
  signal: AbortSignal,
) => Promise<TraceQueryOutcome>;

/** What the panel resolved the selected request to, before any query is issued. */
export type TraceInput =
  | { kind: "trace"; traceId: string; confident: boolean; at: number }
  | { kind: "none"; why: NoneCause };

export type TraceState =
  /** Nothing selected. No query has been issued and none is pending. */
  | { name: "idle" }
  /** No span exists. Terminal, and never reached by a query returning nothing. */
  | { name: "none"; why: NoneCause }
  /** A trace id exists but d0bar has no way to ask about it. A statement about d0bar. */
  | { name: "unqueryable"; traceId: string; why: UnqueryableCause }
  | { name: "fetching"; traceId: string; attempt: number; timeRange: TimeRange }
  | {
      name: "waiting";
      traceId: string;
      attempt: number;
      delay: number;
      /** Wall clock of the next attempt, for the countdown. */
      nextAt: number;
      timeRange: TimeRange;
    }
  | { name: "found"; traceId: string; summary: TraceSummary; timeRange: TimeRange }
  | { name: "failed"; traceId: string; attempt: number; message: string }
  | { name: "exhausted"; traceId: string; attempts: number };

export interface TraceMachineOptions {
  /** Omitted where no backend is reachable — see {@link TraceQuery}. */
  query?: TraceQuery;
  /**
   * Why there is no query. Defaults to `not-wired`. A callback, not a value, because custody
   * changes with the panel open: connect a token and the next selection must say the true thing.
   */
  unqueryable?: () => UnqueryableCause;
  ceiling?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  rangeMs?: number;
  /** Injected so the countdown and the backoff are testable without wall-clock time. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface TraceMachine {
  state(): TraceState;
  subscribe(fn: (state: TraceState) => void): () => void;
  /** Replaces the selection. Aborts whatever the previous one had in flight. */
  select(input: TraceInput | null): void;
  /** Manual retry from `exhausted` or `failed`. Restarts the attempt count at 1. */
  retry(): void;
  /** Aborts and returns to `idle`. Called when the panel closes. */
  stop(): void;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The trace query failed.";
}

export function createTraceMachine(options: TraceMachineOptions = {}): TraceMachine {
  const ceiling = options.ceiling ?? CEILING;
  const base = options.baseDelayMs ?? BASE_DELAY_MS;
  const max = options.maxDelayMs ?? MAX_DELAY_MS;
  const rangeMs = options.rangeMs ?? RANGE_MS;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let state: TraceState = { name: "idle" };
  const listeners = new Set<(state: TraceState) => void>();

  /**
   * The cancellation guarantee, in one variable. Every exit bumps it; every async continuation
   * captures the value it was created under and refuses to write on a mismatch. The
   * `AbortController` is the polite half — this is the half that does not need the query to
   * cooperate.
   */
  let generation = 0;
  let controller: AbortController | undefined;
  let timer: unknown;
  let current: TraceInput | null = null;

  function exit(): number {
    generation += 1;
    if (controller) {
      controller.abort();
      controller = undefined;
    }
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    return generation;
  }

  function set(next: TraceState): void {
    state = next;
    for (const listener of listeners) listener(next);
  }

  function attemptFetch(input: Extract<TraceInput, { kind: "trace" }>, attempt: number): void {
    const query = options.query;
    if (!query) {
      /* Read when the state is set, not at construction: a token can be connected with the panel
         open, and the sentence must describe the token they have now. */
      set({
        name: "unqueryable",
        traceId: input.traceId,
        why: options.unqueryable?.() ?? "not-wired",
      });
      return;
    }
    const mine = exit();
    const timeRange = { from: input.at - rangeMs, to: input.at + rangeMs };
    const ctrl = new AbortController();
    controller = ctrl;
    set({ name: "fetching", traceId: input.traceId, attempt, timeRange });

    query({ traceId: input.traceId, timeRange }, ctrl.signal).then(
      (outcome) => {
        if (mine !== generation) return;
        settle(input, attempt, timeRange, outcome);
      },
      (error: unknown) => {
        if (mine !== generation) return;
        settle(input, attempt, timeRange, { kind: "error", message: messageOf(error) });
      },
    );
  }

  function settle(
    input: Extract<TraceInput, { kind: "trace" }>,
    attempt: number,
    timeRange: TimeRange,
    outcome: TraceQueryOutcome,
  ): void {
    if (outcome.kind === "found") {
      exit();
      set({ name: "found", traceId: input.traceId, summary: outcome.summary, timeRange });
      return;
    }
    if (outcome.kind === "error") {
      exit();
      set({ name: "failed", traceId: input.traceId, attempt, message: outcome.message });
      return;
    }
    /* Not-found on a request that carried a trace id. The toolbar watched the header leave the
       browser, so this is ingest lag; "trace missing" would blame the host for our impatience. */
    if (attempt >= ceiling) {
      exit();
      set({ name: "exhausted", traceId: input.traceId, attempts: attempt });
      return;
    }
    const delay = backoffFor(attempt, base, max);
    const mine = exit();
    timer = setTimer(() => {
      if (mine !== generation) return;
      timer = undefined;
      attemptFetch(input, attempt + 1);
    }, delay);
    set({
      name: "waiting",
      traceId: input.traceId,
      attempt,
      delay,
      nextAt: now() + delay,
      timeRange,
    });
  }

  return {
    state: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    select(input) {
      exit();
      current = input;
      if (!input) {
        set({ name: "idle" });
        return;
      }
      if (input.kind === "none") {
        set({ name: "none", why: input.why });
        return;
      }
      attemptFetch(input, 1);
    },
    retry() {
      const input = current;
      if (!input || input.kind !== "trace") return;
      attemptFetch(input, 1);
    },
    stop() {
      exit();
      current = null;
      set({ name: "idle" });
    },
  };
}

/**
 * Resolves a selection to the machine's input, before any query. Pure, and the three-outcomes rule
 * lives here: with tier 2 off nothing carries a traceparent, so *every* request is `none` — not
 * "not found" (a claim about a backend nobody asked) and not a spinner (implying something is
 * coming).
 */
export function inputFor(args: {
  tier2Live: boolean;
  hasSpan: boolean;
  /**
   * From `classify()`. A thunk because it costs a URL parse and a set lookup that the common path
   * (the request has a span) needs neither of. Nothing here re-derives a cause: this surface and
   * the untraced tab answer from one function, so they cannot disagree about the same request.
   */
  cause: () => Cause;
  traceId: string;
  confident: boolean;
  /** Wall clock of the request's completion, in milliseconds. */
  at: number;
}): TraceInput {
  if (!args.tier2Live) return { kind: "none", why: "tier-2-off" };
  if (!args.hasSpan || !args.traceId) return { kind: "none", why: args.cause() };
  return { kind: "trace", traceId: args.traceId, confident: args.confident, at: args.at };
}

/**
 * The one cause line this module still owns. **The other six moved** to `classify()` /
 * `CAUSE_COPY`: the old three-way `NONE_COPY` here answered the same question more coarsely —
 * everything non-XHR came out as "no traceparent", browser-issued subresources and third-party URLs
 * included — and two surfaces deriving one cause is two chances to disagree in front of one user.
 *
 * This stays because it is not a classification: with tier 2 off nothing was observed, so there is
 * no cause to name, only the absent measurement.
 */
export const TIER2_OFF_COPY =
  "Tier 2 is unavailable on this origin, so d0bar never saw a traceparent. It says so rather than guessing.";

/**
 * Why a visible trace id cannot be asked about. Two reasons, not interchangeable: one the developer
 * can act on in ten seconds, one they cannot act on at all.
 */
export type UnqueryableCause = "not-connected" | "not-wired";

/**
 * Copy for a trace id d0bar can see but cannot ask about.
 *
 * **Corrected.** One sentence ("no credentialed backend to query yet") went stale the day
 * `add-pasted-token` landed — a panel about being trustworthy on absences was denying a capability
 * that sat two clicks away. Split rather than reworded: `not-connected` is fixable right now and
 * must say so; `not-wired` is d0bar's own gap, where "connect a token" sends someone to do nothing.
 *
 * Both keep the last clause verbatim. "The span exists — nothing here says otherwise" is the
 * honest-degradation sentence: this is a fact about d0bar, never a finding about the host.
 */
export const UNQUERYABLE_COPY: Record<UnqueryableCause, string> = {
  "not-connected":
    "This request carried a trace id. Connect a Dash0 token and d0bar can fetch the span for you. The span exists — nothing here says otherwise.",
  "not-wired":
    "This request carried a trace id and a token is connected, but this panel does not issue the span query yet. The span exists — nothing here says otherwise.",
};
