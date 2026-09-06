import { ABSENT, intern, str } from "../shared/intern";
import { scratch, type RequestRecord } from "../shared/record";
import {
  F_CACHED,
  F_CACHE_INFERRED,
  F_HAS_SPAN,
  F_NO_PHASES,
  F_RENDER_BLOCKING,
  F_STATUS_UNKNOWN,
  F_TRACE_CONFLICT,
  F_XHR,
} from "../shared/flags";

/**
 * The request ring: struct-of-arrays over one preallocated buffer.
 *
 * `PerformanceObserver` callbacks run on the main thread, in bursts, during load — exactly
 * when the host page's TBT and LCP are being measured. Allocating an object per entry would
 * put the toolbar's GC pressure in direct correlation with the numbers it reports. So a
 * captured request is a fixed stride of numbers, no object is created, and the browser's
 * own entry is not retained.
 *
 * Fixed capacity. On overflow the oldest record is overwritten and `dropped` increments —
 * the UI reports that loss rather than presenting a truncated list as complete.
 */

export const CAPACITY = 512;
const MASK = CAPACITY - 1;

/* Eight f64 fields, five u32, two u16 — 88 bytes per record, 45,056 for the whole ring. */
const F64_COUNT = 8;
const U32_COUNT = 5;
const U16_COUNT = 2;

const F64_BYTES = F64_COUNT * CAPACITY * 8;
const U32_BYTES = U32_COUNT * CAPACITY * 4;
const U16_BYTES = U16_COUNT * CAPACITY * 2;

let buffer = new ArrayBuffer(F64_BYTES + U32_BYTES + U16_BYTES);

function views(buf: ArrayBuffer) {
  const f = (n: number) => new Float64Array(buf, n * CAPACITY * 8, CAPACITY);
  const u32 = (n: number) => new Uint32Array(buf, F64_BYTES + n * CAPACITY * 4, CAPACITY);
  const u16 = (n: number) =>
    new Uint16Array(buf, F64_BYTES + U32_BYTES + n * CAPACITY * 2, CAPACITY);
  return {
    startTime: f(0),
    duration: f(1),
    connectStart: f(2),
    requestStart: f(3),
    responseStart: f(4),
    responseEnd: f(5),
    transferSize: f(6),
    encodedBodySize: f(7),
    urlId: u32(0),
    initiatorId: u32(1),
    methodId: u32(2),
    epochId: u32(3),
    contextId: u32(4),
    status: u16(0),
    flags: u16(1),
  };
}

let col = views(buffer);

/** Total records ever written, including those since overwritten. */
let written = 0;
/** Records lost to overflow. */
let dropped = 0;
/**
 * Whether this browser exposes `responseStatus`. Feature-detected once per process, not
 * per entry — the property is either on the interface or it is not.
 */
let statusSupported =
  typeof PerformanceResourceTiming !== "undefined" &&
  "responseStatus" in PerformanceResourceTiming.prototype;
/**
 * Whether this browser reports `deliveryType`. When it does, cache status is quoted from the
 * browser; when it does not, it is inferred from transfer sizes and flagged as such.
 */
let deliverySupported =
  typeof PerformanceResourceTiming !== "undefined" &&
  "deliveryType" in PerformanceResourceTiming.prototype;

/**
 * Fields the platform ships but `lib.dom` does not yet declare. Declared here rather than
 * cast away at the use site, so a TypeScript upgrade that adds them surfaces as a conflict.
 */
interface ResourceTimingExtras {
  renderBlockingStatus?: "blocking" | "non-blocking";
  /**
   * The browser's own epoch id, stamped on every entry. Present wherever soft navigations
   * are supported, including on entries buffered from before the toolbar mounted — which is
   * why the epoch is read from the entry rather than derived from its `startTime`.
   */
  navigationId?: number;
  /** `""` for a network fetch, `"cache"` for a hit, `"navigational-prefetch"` for a prefetch. */
  deliveryType?: "" | "cache" | "navigational-prefetch";
}

/* `RequestRecord` and `scratch()` moved to `shared/record.ts`: stage 2 reads records across
   the bundle boundary and cannot import this module, whose typed arrays are stage 1's. */
export { scratch, type RequestRecord };

/**
 * The epoch and trace context subsequent records are written into.
 *
 * Held as two plain integers set between bursts by the epoch and trace layers, so the hot
 * path reads them without a call. A trace context is 24 bytes of ids and cannot live in a
 * `u32`, so `contextId` is a handle into a side table — the same indirection the URL strings
 * already use.
 */
let currentEpochId = 0;
let currentContextId = ABSENT;

export function setRecordContext(epochId: number, contextId: number): void {
  currentEpochId = epochId;
  currentContextId = contextId;
}

/**
 * Records one resource entry. Straight-line typed-array writes plus interning lookups; no
 * object literal, no closure, no retained reference to `entry`.
 */
export function pushResource(entry: PerformanceResourceTiming): void {
  const slot = written & MASK;
  if (written >= CAPACITY) dropped++;

  col.startTime[slot] = entry.startTime;
  col.duration[slot] = entry.duration;
  col.connectStart[slot] = entry.connectStart;
  col.requestStart[slot] = entry.requestStart;
  col.responseStart[slot] = entry.responseStart;
  col.responseEnd[slot] = entry.responseEnd;
  col.transferSize[slot] = entry.transferSize;
  col.encodedBodySize[slot] = entry.encodedBodySize;

  col.urlId[slot] = intern(entry.name);
  col.initiatorId[slot] = intern(entry.initiatorType);
  /* The browser does not report a method on resource entries. Tier 2 supplies it later;
     until then the field is deliberately absent rather than assumed to be GET. */
  col.methodId[slot] = ABSENT;

  const extras = entry as PerformanceResourceTiming & ResourceTimingExtras;

  let flags = 0;
  if (entry.initiatorType === "xmlhttprequest") flags |= F_XHR;
  if (extras.renderBlockingStatus === "blocking") flags |= F_RENDER_BLOCKING;

  if (deliverySupported) {
    if (extras.deliveryType === "cache") flags |= F_CACHED;
  } else {
    /* Fallback only: a cached response reports zero transfer with a non-zero body. So does a
       304, and so does an opaque cross-origin response, which is why this is marked inferred
       rather than presented as the browser's own answer. */
    if (entry.transferSize === 0 && entry.encodedBodySize > 0) flags |= F_CACHED;
    flags |= F_CACHE_INFERRED;
  }
  /* Cross-origin without Timing-Allow-Origin: the phase timestamps are all zero. */
  if (entry.requestStart === 0 && entry.responseStart === 0) flags |= F_NO_PHASES;

  let status = 0;
  if (statusSupported) status = entry.responseStatus;
  else flags |= F_STATUS_UNKNOWN;
  col.status[slot] = status;
  col.flags[slot] = flags;

  /* The browser's id wins where it exists: it is correct for buffered entries the toolbar
     never saw arrive, which no locally-tracked epoch could be. */
  col.epochId[slot] = extras.navigationId ?? currentEpochId;
  col.contextId[slot] = currentContextId;

  written++;
}

/** Records currently retained. */
export function size(): number {
  return written < CAPACITY ? written : CAPACITY;
}

export function stats(): { written: number; dropped: number; capacity: number } {
  return { written, dropped, capacity: CAPACITY };
}

/**
 * Fills `out` with the record at `index`, counting from the oldest retained record.
 * Returns `out`, or `undefined` when the index is out of range.
 */
export function read(index: number, out: RequestRecord): RequestRecord | undefined {
  const count = size();
  if (index < 0 || index >= count) return undefined;
  const base = written < CAPACITY ? 0 : written - CAPACITY;
  const slot = (base + index) & MASK;

  out.startTime = col.startTime[slot] as number;
  out.duration = col.duration[slot] as number;
  out.connectStart = col.connectStart[slot] as number;
  out.requestStart = col.requestStart[slot] as number;
  out.responseStart = col.responseStart[slot] as number;
  out.responseEnd = col.responseEnd[slot] as number;
  out.transferSize = col.transferSize[slot] as number;
  out.encodedBodySize = col.encodedBodySize[slot] as number;
  out.url = str(col.urlId[slot] as number);
  out.initiator = str(col.initiatorId[slot] as number);
  out.method = str(col.methodId[slot] as number);
  out.status = col.status[slot] as number;
  out.flags = col.flags[slot] as number;
  out.epochId = col.epochId[slot] as number;
  out.contextId = col.contextId[slot] as number;
  return out;
}

/**
 * Attaches tier 2's findings to a record tier 1 already wrote.
 *
 * The join cannot happen at push time: the worker's records are read from IndexedDB once,
 * after settle, long after the resource entries were observed. So correlation is a write
 * back into existing slots rather than a field set on the way in.
 *
 * Only the fields tier 2 owns are touched. Timings and status are tier 1's and are not
 * passed here at all — the type is the enforcement, so a future caller cannot overwrite a
 * measured duration with a worker's guess at one.
 *
 * `method` is the interesting case: the browser reports no method on a resource entry, so
 * `pushResource` deliberately leaves it {@link ABSENT} rather than assuming GET. This is
 * where it stops being absent.
 */
export function correlate(
  index: number,
  fields: { method: string; contextId: number; hasSpan: boolean },
): boolean {
  const count = size();
  if (index < 0 || index >= count) return false;
  const base = written < CAPACITY ? 0 : written - CAPACITY;
  const slot = (base + index) & MASK;

  if (fields.method) col.methodId[slot] = intern(fields.method);
  col.contextId[slot] = fields.contextId;
  if (fields.hasSpan) col.flags[slot] = (col.flags[slot] as number) | F_HAS_SPAN;
  return true;
}

/**
 * Writes tier 4's identity onto a record.
 *
 * Deliberately narrower than {@link correlate}: a `contextId` and the `F_HAS_SPAN` bit, and
 * no parameter for anything else. Tier 4 knows a request's identity and nothing about its
 * timing, size or status — every one of those is tier 1's, measured by the browser — so the
 * signature is where that is enforced rather than a comment asking future callers not to.
 */
export function adoptSpan(index: number, contextId: number): boolean {
  const count = size();
  if (index < 0 || index >= count) return false;
  const base = written < CAPACITY ? 0 : written - CAPACITY;
  const slot = (base + index) & MASK;
  col.contextId[slot] = contextId;
  col.flags[slot] = (col.flags[slot] as number) | F_HAS_SPAN;
  return true;
}

/** Sets `F_TRACE_CONFLICT`. See the flag's own note for why this is not a resolution. */
export function flagConflict(index: number): boolean {
  const count = size();
  if (index < 0 || index >= count) return false;
  const base = written < CAPACITY ? 0 : written - CAPACITY;
  const slot = (base + index) & MASK;
  col.flags[slot] = (col.flags[slot] as number) | F_TRACE_CONFLICT;
  return true;
}

/** Called by `destroy()`, so a later `init()` measures the page rather than two pages. */
export function resetRing(options?: {
  statusSupported?: boolean;
  deliverySupported?: boolean;
}): void {
  buffer = new ArrayBuffer(F64_BYTES + U32_BYTES + U16_BYTES);
  col = views(buffer);
  written = 0;
  dropped = 0;
  currentEpochId = 0;
  currentContextId = ABSENT;
  if (options && options.statusSupported !== undefined) {
    statusSupported = options.statusSupported;
  }
  if (options && options.deliverySupported !== undefined) {
    deliverySupported = options.deliverySupported;
  }
}
