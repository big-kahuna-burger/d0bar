import type { QueryOutcome } from "../shared/broker";
import type { LayoutClient } from "../panel/layout-client";
import type { TraceQuery, TraceQueryOutcome, TraceQueryRequest } from "./traceMachine";

/**
 * The trace query, end to end — and the one place the response body exists on this thread.
 *
 * It exists here as a `string` for exactly as long as it takes to `postMessage` it to the
 * layout worker. It is never parsed, never inspected, never measured and never stored. That is
 * not a convention: `flatten()` takes a string and returns rows, so there is no shape on this
 * side that a body could be turned into.
 *
 * ```
 *   panel ──POST──▶ service worker ──Bearer──▶ Dash0 API
 *     │                                            │
 *     │◀────────── body, as text ───────────────────┘
 *     │
 *     └──postMessage──▶ layout worker ──transfer──▶ positioned rows
 * ```
 *
 * Two workers, because they answer two different questions. The service worker holds the
 * credential and is the only thing that may attach it; the layout worker holds the CPU cost and
 * is the only thing that may pay it. Neither knows about the other, and the main thread is a
 * courier between them.
 */

/**
 * The endpoint.
 *
 * A path, joined onto the origin the *worker* resolved from the connected region — never a URL
 * built here. The page names an endpoint; it does not name a host. See `src/shared/regions.ts`.
 */
export const TRACE_DETAILS_PATH = "/api/trace/details";

export interface TraceQueryOptions {
  /** The broker's `query`. Injected so tests drive this without a service worker. */
  send(url: string, init: { method: string; body: string }): Promise<QueryOutcome>;
  /** The layout worker's client. Injected for the same reason. */
  layout: LayoutClient;
  /**
   * The API origin the token is connected to, read at call time.
   *
   * A callback, not a value: the developer can connect, disconnect and reconnect to a different
   * region with the panel open, and a captured origin would send the next trace query to the
   * previous region — which fails as an authorization error and reads as a bad token.
   */
  apiOrigin(): string;
  /**
   * The dataset to query, read at call time for the same reason as {@link apiOrigin} — and with
   * a sharper failure behind it.
   *
   * A stale origin fails as an authorization error, which at least looks like a connection
   * problem. A stale *dataset* does not fail at all: Dash0 answers 404, the machine treats 404 as
   * the ingest-lag signal, and five retries later the panel says the trace did not become
   * queryable. This was previously `dataset?: string`, snapshotted in the factory and passed by
   * nobody, so every query in the shipped product went to `default` and any token belonging to
   * another dataset could not resolve a single trace.
   */
  dataset(): string;
}

/**
 * Copy for the failures the query itself can produce.
 *
 * Every one of these is a statement about d0bar or about the connection — never about the
 * trace. A query that could not be issued must not render as a trace that does not exist,
 * which is the conflation the whole surface is built to prevent.
 */
const SEND_FAILURE_COPY: Record<QueryFailureReason, string> = {
  "not-connected": "No token is connected, so d0bar cannot ask about this trace.",
  "refused-origin":
    "d0bar refused to send the token to that endpoint. This is a bug in the toolbar.",
  rejected:
    "Dash0 rejected the connected token. It may have been revoked, or be for another region.",
  unreachable: "d0bar could not reach the Dash0 API. This says nothing about the trace.",
};

type QueryFailureReason = "not-connected" | "refused-origin" | "rejected" | "unreachable";

/**
 * Builds the request body.
 *
 * `timeRange` is never omitted — the backend falls back to a full table scan without it, and
 * the toolbar is the one client that knows the request's own timestamp to the millisecond. It
 * is a required field of {@link TraceQueryRequest}, so an implementation cannot leave it out
 * and still typecheck; this converts it to the ISO-8601 pair the API takes.
 */
export function traceDetailsBody(request: TraceQueryRequest, dataset: string): string {
  return JSON.stringify({
    traceId: request.traceId,
    dataset,
    timeRange: {
      from: new Date(request.timeRange.from).toISOString(),
      to: new Date(request.timeRange.to).toISOString(),
    },
  });
}

export function createTraceQuery(options: TraceQueryOptions): TraceQuery {
  return async (request, signal): Promise<TraceQueryOutcome> => {
    const origin = options.apiOrigin();
    const dataset = options.dataset();
    if (origin === "") {
      return { kind: "error", message: SEND_FAILURE_COPY["not-connected"] };
    }

    const outcome = await options.send(origin + TRACE_DETAILS_PATH, {
      method: "POST",
      body: traceDetailsBody(request, dataset),
    });

    /* The selection may have moved while the request was in flight. The machine's generation
       counter would refuse the write anyway, but returning here means the layout worker is
       never asked to flatten a trace nobody is looking at. */
    if (signal.aborted) return { kind: "error", message: "The trace query was cancelled." };

    if (!outcome.ok) return { kind: "error", message: SEND_FAILURE_COPY[outcome.reason] };

    /* 404 is the ingest-lag signal, and the only status the machine retries on. Distinguished
       here rather than folded into an error, because "not yet" and "no" are the two readings
       this surface exists to keep apart. */
    if (outcome.status === 404) return { kind: "not-found" };
    if (outcome.status >= 400) {
      return {
        kind: "error",
        message: `Dash0 answered ${outcome.status} for this trace query. This is not a statement about the trace.`,
      };
    }

    /* The body reaches the layout worker without being touched. The `performance.now()` pair
       around it is the *only* main-thread cost this path has, and it is measured rather than
       claimed — the header prints it, and prints nothing if it was not measured. */
    const started = performance.now();
    let flattened;
    try {
      flattened = await options.layout.flatten(
        outcome.body,
        request.timeRange.from,
        request.timeRange.to,
        signal,
      );
    } catch (error) {
      return {
        kind: "error",
        message: error instanceof Error ? error.message : "The trace could not be laid out.",
      };
    }
    /* Excludes the worker's own time: this measures what *this* thread spent, which is the
       message post, the reply handling, and the typed-array views. The wait in between belongs
       to the worker and is reported separately. */
    const mainThreadMs = performance.now() - started - flattened.workerMs;

    /* An empty trace is not a found trace. The API answered and had nothing, which is the same
       reading as a 404 and is retried the same way. */
    if (flattened.rows.count === 0) return { kind: "not-found" };

    return {
      kind: "found",
      summary: {
        spanCount: flattened.summary.spanCount,
        serviceCount: flattened.summary.serviceCount,
        logCount: flattened.summary.logCount,
        truncated: flattened.summary.truncated,
        rows: flattened.rows,
        logs: flattened.logs,
        mainThreadMs: Math.max(0, mainThreadMs),
        workerMs: flattened.workerMs,
      },
    };
  };
}
