import { append, prune } from "./log";
import { parseTraceparent, type FetchRecord } from "./protocol";

/**
 * Observation without interception.
 *
 * The single most important property in this file is a negative one: **`respondWith` is
 * never called.** The handler reads the request's headers and returns, and the browser then
 * services the request exactly as it would with no worker registered — same latency, same
 * cache semantics, same response.
 *
 * Calling `respondWith` would make the toolbar the thing serving the request it is
 * measuring. Even a perfect pass-through (`fetch(event.request)`) is disqualifying: it
 * re-issues the request from the worker, which changes `workerStart`, defeats the browser's
 * own preload and priority decisions, and makes every number downstream a measurement of
 * d0bar rather than of the page. There is no version of this that is worth the extra
 * fields, so the ban is enforced by lint and by test, not by care.
 *
 * `event.waitUntil` *is* used: it keeps the worker alive until the log write settles, which
 * is about the worker's own lifetime and does nothing to the request.
 */

/**
 * The slice of `ServiceWorkerGlobalScope` this module actually uses.
 *
 * Structural rather than the lib global, for two reasons. It states the real surface — three
 * events, `clients.claim`, `skipWaiting`, and nothing else — so the blast radius of this file
 * is readable at the top of it. And it lets the module typecheck under `lib.dom` as well as
 * `lib.webworker`, which is what makes `recordFor` unit-testable from Node instead of only
 * reachable through a real worker registration.
 */
interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
}

export interface WorkerScope {
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
  addEventListener(type: "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "install", listener: (event: ExtendableEventLike) => void): void;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
}

let order = 0;

/** Test seam — the order counter is per worker generation. */
export function resetOrder(): void {
  order = 0;
}

/**
 * Builds the record for one request. Exported for tests: the interesting behaviour is the
 * header reading, and driving it through a real `FetchEvent` proves less than calling it
 * with the awkward inputs directly.
 */
export function recordFor(request: Request, at: number = Date.now()): FetchRecord {
  /* Header reads are the whole point of tier 2 — `PerformanceResourceTiming` deliberately
     exposes none of this, which is why tier 1 can never see a traceparent on its own. */
  const parsed = parseTraceparent(safeHeader(request, "traceparent"));

  return {
    order: order++,
    url: request.url,
    method: request.method,
    at,
    traceId: parsed?.traceId ?? "",
    spanId: parsed?.spanId ?? "",
    sampled: parsed?.sampled ?? false,
    destination: request.destination,
  };
}

/**
 * Header access can throw for a request whose headers guard forbids reading — rare, but a
 * throw here would land inside a `fetch` handler and take the observation down with it.
 */
function safeHeader(request: Request, name: string): string | null {
  try {
    return request.headers.get(name);
  } catch {
    return null;
  }
}

/**
 * Whether this request is worth logging.
 *
 * The toolbar's own traffic is excluded: the panel bundle and the worker file itself would
 * otherwise appear in the list of the host's requests, which is both noise and a small lie
 * about what the page did.
 */
function observable(request: Request): boolean {
  /* Only real navigational and subresource traffic. `only-if-cached` and range requests for
     media produce events whose timing the page never sees a resource entry for. */
  if (request.method === "OPTIONS") return false;
  if (request.url.includes("/d0bar")) return false;
  return true;
}

/**
 * Installs the observer on a `ServiceWorkerGlobalScope`.
 *
 * Takes the scope as an argument rather than reaching for `self`, so the same code runs in
 * the standalone worker, in a host's own worker through `module.ts`, and in a test harness
 * that supplies a stub scope.
 */
export function observeFetches(scope: WorkerScope): void {
  scope.addEventListener("fetch", (event) => {
    /* Read synchronously: `event.request` must be touched before the handler returns, and
       the whole point is that we return immediately without responding. */
    if (!observable(event.request)) return;

    let record: FetchRecord;
    try {
      record = recordFor(event.request);
    } catch {
      /* Nothing about a failed read is worth propagating into the host's request. */
      return;
    }

    /* `waitUntil`, not `respondWith`. This extends the worker's own life until the write
       finishes; it does not touch the request, which the browser is already servicing. */
    try {
      event.waitUntil(append(record));
    } catch {
      /* `waitUntil` throws if the event has already settled. The record is simply lost. */
    }
  });

  scope.addEventListener("activate", (event) => {
    /* Claim before pruning, so the first controlled load is observed as early as the
       platform allows. Tier 1's `buffered: true` covers everything before that point. */
    event.waitUntil(
      (async () => {
        try {
          await scope.clients.claim();
        } catch {
          /* Claiming is an optimisation, not a precondition. */
        }
        await prune();
      })(),
    );
  });

  scope.addEventListener("install", () => {
    /* Skip waiting so a worker update takes effect on the next load rather than after every
       tab has closed — a stale correlator silently reporting old behaviour is precisely the
       failure mode this repo has already been bitten by once. */
    void scope.skipWaiting();
  });
}
