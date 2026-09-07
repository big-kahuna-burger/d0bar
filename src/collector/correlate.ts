import { intern } from "../shared/intern";
import { join, joinSpans, type Tier1Entry } from "./join";
import type { Tier2State } from "./sw";
import type { Tier1Access } from "../shared/stage2";
import { readAll, loggingDegraded } from "../sw/log";
import type { FetchRecord } from "../sw/protocol";

/**
 * The correlation flush: after settle, at background priority, never inside a `fetch` handler
 * or observer callback — both fire during load, and a join there puts string interning and a map
 * walk into the host's TBT.
 *
 * The page reads the worker's log rather than the worker `postMessage`-ing each record: that
 * delivers earlier and runs a message handler on the host's main thread once per request, in
 * bursts, during load. IndexedDB is per-origin, not per-realm, so the page opens the worker's
 * database and pays once, when the page is quiet.
 *
 * **Called repeatedly, not once.** It was once — at panel open — and that was a bug with a very
 * clean shape: the worker went on logging every request, and nothing ever read the log again, so
 * every request issued after the panel opened rendered untraced forever. Measured by counting
 * `getAll` on the `requests` store from page script:
 *
 *     before the panel opens          0 reads      6 records written
 *     at panel open                   1 read       6
 *     after a 9-request scenario      1 read      19
 *     after a second one              1 read      28
 *
 * 22 of 28 records were never read. The panel now re-flushes on each tier-1 resource batch, which
 * makes idempotence a requirement rather than a nicety: a second pass over an already-correlated
 * record would push a duplicate `TraceContext` on every batch for the life of the panel, and
 * would adopt a tier-4 span onto a record tier 2 had already resolved. Both are prevented by
 * {@link tier2ByIndex} and {@link adoptedByIndex} rather than by the caller flushing carefully.
 */

/**
 * What each ring index has already been given, and the `startTime` it was given it for.
 *
 * The `startTime` is not redundant. The ring is a ring: a busy page wraps it and a slot is reused
 * for an unrelated request. Keyed on the index alone, a wrapped slot would look already-correlated
 * and its new occupant would never get a trace id — trading the bug above for a rarer version of
 * itself. `startTime` is `DOMHighResTimeStamp` from the entry, so a reused slot compares unequal.
 */
const tier2ByIndex = new Map<number, { startTime: number; traceId: string }>();
const adoptedByIndex = new Map<number, number>();

export interface FlushResult {
  /** Ring records that gained a trace id. */
  correlated: number;
  /** Worker records with no tier 1 counterpart — the Untraced tab's input. */
  unjoined: FetchRecord[];
  /** How many joins were flagged ambiguous. */
  lowConfidence: number;
  /**
   * Ring indices the worker produced a record for, traceparent or not. The untraced view's input:
   * a request the worker read and found bare is a different finding from one it never saw.
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
   * Records where tier 2's and tier 4's trace ids disagree. Reported, not resolved
   * (`F_TRACE_CONFLICT`): a non-zero count means one join matched the wrong pair, and the panel
   * must say so rather than choose.
   */
  traceConflicts: number;
}

/**
 * The trace-context side table. The ring stores a `u32` per record and a trace context is far
 * wider, so `contextId` indexes here — the URLs' indirection. Index 0 is "absent", matching the
 * interning table.
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
 * Reads the worker's log, joins it against the ring, writes back. Never throws: no worker, no
 * storage and an empty log are readings rather than errors, and resolve to the same degraded state.
 */
export async function flushCorrelation(options: {
  /**
   * Tier 2's state, **passed in from stage 1** per the duplication rule in `shared/stage2.ts`.
   * Reading `sw.ts` here returned `off` for a worker that was registered and controlling the page.
   * Found by running the fixture, not by a test — both bundles typecheck, both are internally
   * consistent, and the only symptom is a footer that lies.
   */
  tier2: Tier2State;
  /**
   * Only this document's records join. The log is durable across reloads by design — the failed
   * request survives the refresh — but a previous load's record has no counterpart in this ring, so
   * joining the whole log reported every prior page view's requests as untraced: the badge read 614
   * on a page that had issued 300.
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

  /* Counted per flush, not cumulatively — a re-flush skips what it already wrote back, so these
     are deltas. Nothing in the panel reads them; they exist for tests and for a log line. */
  let correlated = 0;
  let lowConfidence = 0;
  /* `startTime` by ring index, so a wrapped slot can be told from the one it replaced. */
  const startTimes = new Map<number, number>();
  for (const entry of entries) startTimes.set(entry.index, entry.startTime);

  const seen = new Set<number>();
  for (const [index, correlation] of result.matched) {
    /* Accumulated over the whole log every flush, not incrementally: the join runs against all
       records each time, so this is complete on every pass. The untraced view's badge would
       shrink on a re-flush if it were a delta. */
    seen.add(index);

    const startTime = startTimes.get(index) ?? -1;
    const already = tier2ByIndex.get(index);
    /* Written back by an earlier flush and still the same request. Skipping is what keeps the
       repeated flush free of a per-batch `contexts` leak. */
    if (already && already.startTime === startTime) continue;

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
    tier2ByIndex.set(index, { startTime, traceId: correlation.traceId });
    if (hasSpan) correlated += 1;
    if (!correlation.confident) lowConfidence += 1;
  }

  /* Tier 4, second and additive rather than authoritative: tier 2 read the `traceparent` the
     browser put on the wire (what the backend received), tier 4 read the span the SDK built (what
     it intended to send). Agreement is a no-op; disagreement is the finding. */
  const spans = options.tier1.spans();
  const spanResult = joinSpans(entries, spans);

  let adopted = 0;
  let traceConflicts = 0;
  for (const [index, span] of spanResult.matched) {
    const startTime = startTimes.get(index) ?? -1;
    /* Read from the persistent map, not from this flush's writes: on a re-flush tier 2's id for
       this record was written back by an earlier pass, and a local map would have looked empty
       here and adopted a tier-4 span over the header the backend actually received. */
    const held = tier2ByIndex.get(index);
    const fromTier2 =
      held && held.startTime === startTime && held.traceId !== "" ? held.traceId : undefined;
    if (fromTier2 !== undefined) {
      if (fromTier2 !== span.traceId) {
        traceConflicts += 1;
        options.tier1.flagConflict(index);
      }
      /* Tier 2 already supplied an id for this record. Not overwritten either way: the
         header is what the backend saw. */
      continue;
    }

    /* Already adopted by an earlier flush, same slot. Same reason as tier 2's skip above. */
    const adoptedAt = adoptedByIndex.get(index);
    if (adoptedAt !== undefined && adoptedAt === startTime) continue;

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
    adoptedByIndex.set(index, startTime);
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
  /* Both write-back ledgers, or a later `init()` would treat the previous page's ring indices as
     already correlated and skip them — the same silent no-op the `startTime` check exists for. */
  tier2ByIndex.clear();
  adoptedByIndex.clear();
}
