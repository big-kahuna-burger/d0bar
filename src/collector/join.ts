import { intern, ABSENT, OVERFLOW } from "../shared/intern";
import type { FetchRecord } from "../sw/protocol";

/**
 * The tier 1 ↔ tier 2 join. Two sources, each authoritative for different fields, neither allowed to
 * overwrite the other's:
 *
 *   tier 1 · resource entry   timings, transferSize, responseStatus
 *   tier 2 · fetch event      traceparent, method, requests tier 1 never saw
 *
 * Naive matching is O(n·m): 500 requests against 500 worker records is a quarter-million string
 * comparisons on the main thread. Instead the URL is already interned to a `u32` and unjoined tier 2
 * records sit in a per-URL FIFO — one map lookup and one shift, amortised O(1) per entry.
 *
 * Ambiguity is real and not hidden: two identical concurrent URLs reach the worker in issue order
 * and the ring in completion order. The FIFO pops in issue order, right on average and sometimes
 * wrong, so a record with a same-URL sibling in flight is flagged low confidence and the UI must not
 * present its trace id as certain.
 */

/**
 * A record from a tier that keys on URL: tier 2's fetch observations and tier 4's spans are
 * the same shape of input to the same matching problem, so they share the queue-building
 * below rather than each growing their own copy of it.
 */
export interface UrlKeyed {
  url: string;
  /** Issue order within the flush. The only ordering both sides of a join agree on. */
  order: number;
}

/**
 * Builds the per-URL FIFOs, shared by {@link join} and {@link joinSpans}. `overflowed` is separated
 * rather than dropped: past the intern table's capacity every URL collapses onto one id, so matching
 * them would attach one request's identity to another's timings.
 */
function queuesByUrl<T extends UrlKeyed>(
  records: readonly T[],
): { queues: Map<number, T[]>; overflowed: T[]; ambiguous: Set<number> } {
  const queues = new Map<number, T[]>();
  const overflowed: T[] = [];

  for (const record of records) {
    const id = intern(record.url);
    if (id === ABSENT) continue;
    if (id === OVERFLOW) {
      overflowed.push(record);
      continue;
    }
    let queue = queues.get(id);
    if (!queue) {
      queue = [];
      queues.set(id, queue);
    }
    queue.push(record);
  }

  /* A URL with more than one record in the same flush cannot be ordered with confidence:
     issue order and completion order diverge exactly when requests overlap. Computed once
     per URL rather than per pop. */
  const ambiguous = new Set<number>();
  for (const [id, queue] of queues) if (queue.length > 1) ambiguous.add(id);

  return { queues, overflowed, ambiguous };
}

/** One adopted span, reduced to what the tier 4 join needs. */
export interface SpanEntry extends UrlKeyed {
  traceId: string;
  spanId: string;
}

/** A span matched to a tier 1 entry. Identity only — tier 4 supplies nothing else. */
export interface SpanCorrelation {
  traceId: string;
  spanId: string;
  /** False when an identical URL had a sibling span in the same flush. */
  confident: boolean;
}

export interface SpanJoinResult {
  matched: Map<number, SpanCorrelation>;
  /**
   * Spans with no tier 1 counterpart. Retained and counted for the same reason tier 2's
   * leftovers are: a span the page's resource timeline never saw is a real observation, and
   * discarding it here would make tier 4 look like it found less than it did.
   */
  unjoined: SpanEntry[];
}

/**
 * Correlates adopted spans against the ring. Separate from {@link join} rather than one generic
 * function with a `kind`: tier 2 supplies a method and a sampling decision, tier 4 supplies identity
 * and nothing else, and the return type enforces it — no field for a timing, status or size.
 */
export function joinSpans(
  entries: readonly Tier1Entry[],
  spans: readonly SpanEntry[],
): SpanJoinResult {
  const matched = new Map<number, SpanCorrelation>();
  const { queues, overflowed, ambiguous } = queuesByUrl(spans);

  const ordered = [...entries].sort((a, b) => a.startTime - b.startTime);
  for (const entry of ordered) {
    const id = intern(entry.url);
    const queue = queues.get(id);
    if (!queue || queue.length === 0) continue;
    const span = queue.shift() as SpanEntry;
    matched.set(entry.index, {
      traceId: span.traceId,
      spanId: span.spanId,
      confident: !ambiguous.has(id),
    });
  }

  const unjoined: SpanEntry[] = [...overflowed];
  for (const queue of queues.values()) for (const left of queue) unjoined.push(left);
  unjoined.sort((a, b) => a.order - b.order);

  return { matched, unjoined };
}

/** A tier 2 record matched to a tier 1 entry, or left over. */
export interface Correlation {
  traceId: string;
  spanId: string;
  sampled: boolean;
  method: string;
  /** False when an identical URL was in flight concurrently and order could be wrong. */
  confident: boolean;
}

export interface JoinResult {
  /** Ring index → correlation, for the entries that matched. */
  matched: Map<number, Correlation>;
  /**
   * Tier 2 records with no tier 1 counterpart. These are the un-instrumented requests the
   * Untraced tab exists to show: the page cannot see them at all, so dropping them here
   * would silently discard the one diagnostic tier 2 uniquely provides.
   */
  unjoined: FetchRecord[];
}

/** One tier 1 entry, reduced to what the join needs. */
export interface Tier1Entry {
  /** Index into the ring, carried through so the caller can write the result back. */
  index: number;
  url: string;
  startTime: number;
}

/**
 * Correlates one flush. Pure — two arrays in, a result out; the caller owns the ring writes, which
 * makes this testable from a recorded pair of dumps with no browser in sight.
 */
export function join(
  entries: readonly Tier1Entry[],
  records: readonly FetchRecord[],
): JoinResult {
  const matched = new Map<number, Correlation>();

  /* Per-URL FIFOs, keyed on the interned id — see `queuesByUrl`, which tier 4's join
     shares. */
  const { queues, overflowed, ambiguous } = queuesByUrl(records);

  /* Tier 1 entries in start order, so the FIFO pops line up with issue order as closely as
     the two sources allow. The ring is already in completion order, which is not the same. */
  const ordered = [...entries].sort((a, b) => a.startTime - b.startTime);

  for (const entry of ordered) {
    const id = intern(entry.url);
    const queue = queues.get(id);
    if (!queue || queue.length === 0) continue;
    const record = queue.shift() as FetchRecord;

    matched.set(entry.index, {
      traceId: record.traceId,
      spanId: record.spanId,
      sampled: record.sampled,
      method: record.method,
      confident: !ambiguous.has(id),
    });
  }

  const unjoined: FetchRecord[] = [...overflowed];
  for (const queue of queues.values()) for (const left of queue) unjoined.push(left);
  /* Stable, and meaningful: issue order is the only ordering both sides agree on. */
  unjoined.sort((a, b) => a.order - b.order);

  return { matched, unjoined };
}
