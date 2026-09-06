/**
 * The trace query's state machine.
 *
 * ## Why this is not XState
 *
 * `add-trace-view`'s proposal names XState v5 as this change's dependency, and `shell.ts`
 * records that XState was kept back from the shell specifically so it could earn its cost
 * here, where the transitions are genuinely hard. It does not fit, and the number is not
 * close:
 *
 * ```
 *   xstate v5, minimal surface used by this machine        13.10 kB gzipped
 *   (setup / createMachine / createActor / assign
 *    / fromPromise / after)
 *   stage-2 panel bundle, before this change                9.85 kB gzipped
 *   stage-2 panel budget (.size-limit.json)                10.50 kB gzipped
 *   ────────────────────────────────────────────────────────────────────────
 *   headroom                                                0.65 kB
 * ```
 *
 * Measured with `size-limit` against a probe module importing exactly the surface below —
 * not estimated from the published package size. XState is twenty times the headroom, and
 * would take the panel to roughly 23 kB: more than doubling the bundle a user waits for on
 * first open, to express seven states and eleven transitions that fit in this file. Raising
 * the limit to absorb it would be lowering a gate to make a decision pass, which is the one
 * move this repo's working agreements name outright.
 *
 * The property XState was wanted for — *an in-flight query is cancelled on state exit, so a
 * stale response can never overwrite the panel* — is not delegated. It is enforced here by a
 * generation counter that every asynchronous continuation checks before it may write, and by
 * {@link exit} being the single place a state is left. `tests/unit/trace-machine.test.ts`
 * drives a query that resolves after the selection has moved and asserts the panel never
 * sees it.
 *
 * ## What is not built
 *
 * {@link TraceQuery} is a boundary with **no default implementation**. Issuing the query
 * needs a credential, and `add-credential-broker` — which this change blocks — supplies it.
 * A machine constructed without a query does not pretend: it resolves to
 * {@link TraceState `unqueryable`}, which is a statement about d0bar's own backlog in the
 * same sense as `tier.ts`'s `planned`, and is deliberately distinct from all three of the
 * outcomes the spec forbids conflating.
 */

import type { Cause } from "../collector/coverage";

/** Half-width of the query's time range, in milliseconds. The handoff's `timeRange ±2s`. */
export const RANGE_MS = 2000;

/** Attempts before the machine gives up and offers a manual retry. */
export const CEILING = 5;

/** First backoff delay. Doubles per attempt, clamped to {@link MAX_DELAY_MS}. */
export const BASE_DELAY_MS = 400;

/**
 * Backoff ceiling.
 *
 * Not because a longer wait would be expensive — because a countdown reading "next in 24s"
 * has stopped being a progress indication and become a reason to close the panel. Reached at
 * attempt 5 with the defaults, so the last two attempts are evenly spaced.
 */
export const MAX_DELAY_MS = 6400;

/** Exponential, clamped. `attempt` is 1-based: the delay *after* attempt n. */
export function backoffFor(attempt: number, base = BASE_DELAY_MS, max = MAX_DELAY_MS): number {
  if (attempt < 1) return base;
  return Math.min(base * 2 ** (attempt - 1), max);
}

/**
 * Why a request has no span at all. Never a synonym for "not found yet".
 *
 * The six coverage causes plus one this surface owns. `tier-2-off` is not a classification —
 * it is the statement that no classification was possible, which is why `coverage.ts` carries
 * it as `determinable: false` rather than as a seventh {@link Cause}.
 */
export type NoneCause = "tier-2-off" | Cause;

export interface TimeRange {
  from: number;
  to: number;
}

export interface TraceQueryRequest {
  traceId: string;
  /**
   * Never omitted. The backend falls back to a full table scan without it, and the toolbar
   * is the one client that knows the request's own timestamp to the millisecond.
   */
  timeRange: TimeRange;
}

/**
 * One span row, already laid out.
 *
 * `left` and `width` are fractions of the trace's own duration, not pixels — the row's CSS
 * turns them into geometry, exactly as the request list's bars do, so a resize is style
 * recalculation inside a contained row rather than a JavaScript layout pass.
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
   * The span had no measurable duration and its bar was widened to stay clickable.
   *
   * The width is then a rendering decision rather than a measurement, and the row has to say so
   * — otherwise a zero-duration span is indistinguishable from a 2 ms one.
   */
  degenerate: boolean;
}

/**
 * The laid-out spans, read one at a time into a caller-owned record.
 *
 * **Not an array**, and that is the point of the whole layout worker. The rows arrive as typed
 * arrays over a transferred buffer; materialising them into four thousand objects on arrival
 * would put back most of the allocation cost the worker exists to move off this thread, on the
 * thread whose INP the toolbar is reporting. The virtualizer holds a viewport's worth of rows,
 * so only a viewport's worth is ever built — the same `read(index, out)` shape the request ring
 * uses, for the same reason.
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
   * Main-thread milliseconds this trace's flattening actually cost, measured by whatever
   * produced the summary, or `null` when nothing measured it.
   *
   * Null is not zero. The handoff prints `flattened in worker · 0 ms on main thread`, which
   * is the single most self-serving number this panel could show; unmeasured, it is not
   * shown at all.
   */
  mainThreadMs: number | null;
  /**
   * Milliseconds the worker spent parsing and laying this trace out, as the worker measured it,
   * or `null` when nothing measured it.
   *
   * The other half of the same claim. "Flattened in worker" is only worth printing beside a
   * main-thread number if the work it names actually happened somewhere, and this is where.
   */
  workerMs: number | null;
}

export type TraceQueryOutcome =
  | { kind: "found"; summary: TraceSummary }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

/**
 * The query boundary. **No implementation ships with this change.**
 *
 * An implementation must hand the response body to the layout worker as *text* and return
 * the worker's summary — parsing a four-thousand-span trace with `JSON.parse` on the main
 * thread is the exact perturbation this toolbar exists to avoid, and it would happen while
 * the panel is open over a page still being measured. The type is written so that the whole
 * of that work sits behind this one function and the machine never touches a response body.
 *
 * `signal` is aborted on every state exit. An implementation that ignores it leaks a fetch;
 * one that honours it lets the machine's cancellation guarantee extend to the network.
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
   * Why there is no query, when there is no query. Defaults to `not-wired`.
   *
   * A callback rather than a value because custody changes while the panel is open: the
   * developer connects a token, and the next selection must say the true thing.
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
   * The cancellation guarantee, in one variable.
   *
   * Every state exit bumps this, and every asynchronous continuation — a settled query, a
   * backoff timer — captures the value it was created under and refuses to write if it no
   * longer matches. A response that arrives after the user clicked another request finds a
   * generation that has moved on and is dropped on the floor.
   *
   * The `AbortController` is the polite half of the same thing: it lets the query stop doing
   * work. This counter is the half that does not depend on the query cooperating.
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
      /* Read at the moment the state is set, not captured at construction: a developer can
         connect a token with the panel open, and the sentence has to be right for the token
         they have now rather than the one they had when the view mounted. */
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
    /* Not-found on a request that carried a trace id. The span exists — the toolbar watched
       the header leave the browser — so this is ingest lag and nothing else. Rendering it as
       "trace missing" would blame the host for our own impatience. */
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
 * Resolves a selected request to the machine's input, before any query exists.
 *
 * Pure, and the whole of the three-outcomes rule lives here: with tier 2 off there is no
 * traceparent on anything, so *every* request resolves to `none` — not to "not found", which
 * would be a claim about the backend nobody asked, and not to a spinner, which would imply
 * something is on its way.
 */
export function inputFor(args: {
  tier2Live: boolean;
  hasSpan: boolean;
  /**
   * The coverage classification for this request, from `classify()`.
   *
   * A thunk because classifying costs a URL parse and a set lookup, and the overwhelmingly
   * common path — the request has a span — needs neither. Nothing here re-derives a cause of
   * its own: this surface and the untraced tab now answer "why is there no span" from the
   * same function, so they can no longer disagree about the same request.
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
 * The one cause line this module still owns.
 *
 * **The other six moved.** This file used to carry its own three-way `NONE_COPY`, written
 * before `add-untraced-view` existed and reasoning independently about the same question the
 * coverage classifier now answers — with a coarser answer: everything that was not an XHR came
 * out as "no traceparent", including subresources the browser issued itself and third-party
 * URLs nobody could have propagated into. Two surfaces deriving the same cause twice is two
 * chances to disagree in front of the same user, so the derivation is `classify()`'s and the
 * sentences are `CAUSE_COPY`'s. See `views/trace/index.ts` for the composition.
 *
 * This one stays because it is not a classification. With tier 2 off nothing was observed at
 * all, so there is no cause to name — only the absence of the measurement, which is what the
 * sentence says.
 */
export const TIER2_OFF_COPY =
  "Tier 2 is unavailable on this origin, so d0bar never saw a traceparent. It says so rather than guessing.";

/**
 * Why a trace id d0bar can see cannot be asked about.
 *
 * Two reasons, and they are not interchangeable: one the developer can act on in the next ten
 * seconds, one they cannot act on at all. Collapsing them was the original mistake — see the
 * note on `UNQUERYABLE_COPY`.
 */
export type UnqueryableCause = "not-connected" | "not-wired";

/**
 * The copy for a trace id d0bar can see but cannot ask about.
 *
 * **Corrected.** This was a single sentence reading "d0bar has no credentialed backend to query
 * yet", which was true when it was written and stopped being true the day `add-pasted-token`
 * landed: there is a credentialed backend now, the connect surface obtains the credential and
 * the worker holds it. A panel whose entire purpose is being trustworthy about absences was
 * telling the user a capability did not exist while it sat two clicks away in the header.
 *
 * Split rather than reworded, because the two states differ in the only way that matters to
 * whoever is reading: `not-connected` is a thing the developer can fix right now, and the copy
 * has to say so. `not-wired` is d0bar's own gap, and saying "connect a token" there would send
 * someone to do something that changes nothing.
 *
 * Both keep the last clause verbatim. "The span exists — nothing here says otherwise" is the
 * honest-degradation sentence: d0bar not being able to fetch a span is a fact about d0bar, and
 * must never read as a finding about the host's instrumentation.
 */
export const UNQUERYABLE_COPY: Record<UnqueryableCause, string> = {
  "not-connected":
    "This request carried a trace id. Connect a Dash0 token and d0bar can fetch the span for you. The span exists — nothing here says otherwise.",
  "not-wired":
    "This request carried a trace id and a token is connected, but this panel does not issue the span query yet. The span exists — nothing here says otherwise.",
};
