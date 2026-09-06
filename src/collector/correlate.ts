import { intern } from "../shared/intern";
import { join, joinSpans, type Tier1Entry } from "./join";
import type { Tier2State } from "./sw";
import type { Tier1Access } from "../shared/stage2";
import { readAll, loggingDegraded } from "../sw/log";
import type { FetchRecord } from "../sw/protocol";

/**
 * The correlation flush.
 *
 * Runs once after settle, at background priority, and never inside a `fetch` handler or a
 * `PerformanceObserver` callback. Both of those fire during load, which is the window this
 * whole toolbar exists not to disturb — a join there would put string interning and a map
 * walk directly into the host's TBT.
 *
 * Reading the worker's log from the page is deliberate. The obvious alternative is for the
 * worker to `postMessage` each record as it observes it, which would deliver them earlier —
 * and would run a message handler on the host's main thread once per request, in bursts,
 * during load. IndexedDB is per-origin rather than per-realm, so the page can simply open
 * the database the worker wrote and pay for all of it once, after the page is quiet.
 */

export interface FlushResult {
  /** Ring records that gained a trace id. */
  correlated: number;
  /** Worker records with no tier 1 counterpart — the Untraced tab's input. */
  unjoined: FetchRecord[];
  /** How many joins were flagged ambiguous. */
  lowConfidence: number;
  /**
   * Ring indices the worker produced a record for, whether or not it carried a traceparent.
   *
   * The untraced view's input: a request the worker read and found bare is a different
   * finding from one the worker never saw, and without this the two are indistinguishable.
   */
  seen: Set<number>;
  /** True when the worker stopped logging (quota) and the log is therefore incomplete. */
  logDegraded: boolean;
  tier2: Tier2State;
  /** Ring records that gained a trace id from tier 4 that tier 2 had not supplied. */
  adopted: number;
  /** Adopted spans with no tier 1 counterpart. Counted, never discarded. */
  spansUnjoined: number;
  /**
   * Records where tier 2 and tier 4 both supplied a trace id and the two disagree.
   *
   * Reported rather than resolved — see `F_TRACE_CONFLICT`. A non-zero count here means one
   * of the two joins matched the wrong pair, and the panel must say so instead of choosing.
   */
  traceConflicts: number;
}

/**
 * The trace-context side table.
 *
 * The ring stores a `u32` per record, and a trace context is far too wide for that, so
 * `contextId` is a handle into this array — the same indirection the URLs already use. Index
 * 0 is reserved as "absent", matching the interning table's convention.
 */
const contexts: TraceContext[] = [
  { traceId: "", spanId: "", sampled: false, confident: false },
];

export interface TraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
  /** False when an identical URL was in flight concurrently; the UI must not assert this id. */
  confident: boolean;
}

/** Resolves a `contextId` from a ring record. Index 0 and unknown ids resolve to absent. */
export function traceContext(id: number): TraceContext | undefined {
  const found = contexts[id];
  if (!found || !found.traceId) return undefined;
  return found;
}

function addContext(context: TraceContext): number {
  contexts.push(context);
  return contexts.length - 1;
}

/**
 * Reads the worker's log, joins it against the ring, and writes the results back.
 *
 * Never throws. Every failure mode here — no worker, no storage, an empty log — is a
 * reading, not an error, and it resolves to the same honest degraded state.
 */
export async function flushCorrelation(options: {
  /**
   * Tier 2's state, **passed in from stage 1** rather than read from `sw.ts`.
   *
   * Stage 1 and stage 2 are separate bundles, so each gets its own copy of every module and
   * its own module-level state. `sw.ts` holds the registration outcome in a module variable,
   * and the panel's copy of that variable is never written — reading it here returned `off`
   * for a worker that was demonstrably registered and controlling the page. Found by running
   * the fixture, not by a test: both bundles typecheck, both are internally consistent, and
   * the only symptom is a footer that lies.
   */
  tier2: Tier2State;
  /**
   * Only records observed during this document's lifetime take part in the join.
   *
   * The log is deliberately durable across reloads — that is the whole point of task 3.3,
   * the failed request is still there after the refresh. But a record from a *previous* load
   * has no counterpart in this load's ring, so joining against the whole log reported every
   * request of every prior page view as untraced. The badge read 614 on a page that had
   * issued 300.
   */
  since: number;
  /** The ring, owned by stage 1. See `Tier1Access` for why this is passed and not imported. */
  tier1: Tier1Access;
}): Promise<FlushResult> {
  let tier2 = options.tier2;

  let records: FetchRecord[] = [];
  try {
    records = await readAll();
  } catch {
    records = [];
  }

  /* Scoped to this document. `performance.timeOrigin` is the wall-clock instant this
     document started, and the worker stamps `Date.now()`, so the two are directly
     comparable — no clock skew, same process. */
  records = records.filter((record) => record.at >= options.since);

  /* A host-owned worker that imported d0bar's module produces records without d0bar ever
     registering anything. That is the only evidence available that the import happened, and
     it is better evidence than asking would be — so the tier is upgraded on the observation
     rather than on a claim. */
  if (records.length > 0 && tier2.kind === "off" && tier2.reason === "scope-owned") {
    tier2 = { kind: "live", owner: "host" };
  }

  const entries: Tier1Entry[] = options.tier1.entries();
  const result = join(entries, records);

  let correlated = 0;
  let lowConfidence = 0;
  /* Trace ids tier 2 supplied, by ring index — the input to the conflict check below. */
  const tier2Ids = new Map<number, string>();
  const seen = new Set<number>();
  for (const [index, correlation] of result.matched) {
    seen.add(index);
    /* A record with no traceparent still carries tier 2's method, which tier 1 never has.
       Only a real trace id earns a context handle and the `F_HAS_SPAN` flag. */
    const hasSpan = correlation.traceId !== "";
    const contextId = hasSpan
      ? addContext({
          traceId: correlation.traceId,
          spanId: correlation.spanId,
          sampled: correlation.sampled,
          confident: correlation.confident,
        })
      : 0;

    options.tier1.correlate(index, { method: correlation.method, contextId, hasSpan });
    if (hasSpan) tier2Ids.set(index, correlation.traceId);
    if (hasSpan) correlated += 1;
    if (!correlation.confident) lowConfidence += 1;
  }

  /* Tier 4, joined against the same entries and written back second.
     
     Second rather than first, and additively rather than authoritatively: tier 2 read the
     `traceparent` the browser actually put on the wire, which is the header the backend
     received. Tier 4 read the span the host's SDK built, which is what the SDK *intended* to
     send. Where both exist and agree there is nothing to do; where they disagree, the
     disagreement is the finding. */
  const spans = options.tier1.spans();
  const spanResult = joinSpans(entries, spans);

  let adopted = 0;
  let traceConflicts = 0;
  for (const [index, span] of spanResult.matched) {
    const fromTier2 = tier2Ids.get(index);
    if (fromTier2 !== undefined) {
      if (fromTier2 !== span.traceId) {
        traceConflicts += 1;
        options.tier1.flagConflict(index);
      }
      /* Tier 2 already supplied an id for this record. Not overwritten either way: the
         header is what the backend saw. */
      continue;
    }

    /* A record the worker never saw — an SDK-instrumented request issued before the worker
       took control, or one on a page where tier 2 is off entirely. Identity only: the
       write-back's type has no field for a timing, a status or a size. */
    const contextId = addContext({
      traceId: span.traceId,
      spanId: span.spanId,
      /* The SDK's own sampling decision is not on the span shape this file reads, and
         inventing one would put a `sampled` badge on a record where nothing said so. */
      sampled: false,
      confident: span.confident,
    });
    options.tier1.adoptSpan(index, contextId);
    adopted += 1;
  }

  for (const left of spanResult.unjoined) intern(left.url);

  /* Interning the leftovers here rather than in the view: they are about to be rendered as
     rows, and the table is the same one the ring keys on. */
  for (const left of result.unjoined) intern(left.url);

  return {
    correlated,
    unjoined: result.unjoined,
    lowConfidence,
    logDegraded: loggingDegraded(),
    tier2,
    seen,
    adopted,
    spansUnjoined: spanResult.unjoined.length,
    traceConflicts,
  };
}

/** Called by `destroy()`, so a later `init()` measures the page rather than two pages. */
export function resetCorrelation(): void {
  contexts.length = 1;
}
