/**
 * The page ↔ layout-worker contract. In `src/shared/` because the two realms compile against
 * different libs (`lib.dom` / `lib.webworker`) and this is the only file both can import.
 *
 * **The shape is the guarantee:** the response carries rows already positioned, in typed arrays
 * over one buffer, strings interned to `u32`. No tree, nothing to sort, no percentage left to
 * compute — the main thread cannot accidentally do the worker's work because that work is not
 * expressible on what it is handed. The buffer is **transferred**, not cloned (108 kB of rows),
 * asserted in `tests/unit/layout-protocol.test.ts`.
 */

/**
 * Bumped on any change to byte layout, field set or message shape; checked on both sides. The two
 * are separate artifacts and a host may cache them differently — a worker one version behind reads
 * the right bytes at the wrong offsets and draws a plausible, wrong waterfall.
 */
export const LAYOUT_PROTOCOL_VERSION = 2;

/**
 * Row cap. Not memory (8192 rows is 216 kB) but readability: past this the waterfall is unreadable
 * and saying so is the honest move — beyond it sets {@link LayoutSummary.truncated}, which the UI
 * must surface. Above the 4000-span budget case on purpose, so the benchmark measures a whole trace
 * rather than the cap; truncation is unit-tested with an injected cap.
 */
export const SPAN_CAP = 8192;

/**
 * Log record cap. Readability again, not memory: a trace with more than this many correlated logs is
 * not read by scrolling, and `logsSeen` past it is the honest answer. Records are selected for the
 * cap **by severity**, so the severest can never be the one dropped — see `readLogs`.
 */
export const LOG_CAP = 200;

/**
 * Attributes surfaced per log record. OTLP puts no bound on the list, so an unbounded list is an
 * unbounded reply; a record whose attributes were truncated reports `attrsSeen`.
 */
export const ATTR_CAP = 64;

/* ── row flags ──
   One `u8` rather than six booleans (six bytes). Each is a statement the UI must render; none of
   these conditions is repaired silently. */

/** The row has no parent inside this trace *and* was not made an orphan — the real root. */
export const F_ROOT = 1 << 0;
/** The span's own status is `STATUS_CODE_ERROR`. */
export const F_ERROR = 1 << 1;
/** The span named a parent that is absent from the response. Rendered at depth 0, never hidden. */
export const F_ORPHAN = 1 << 2;
/** The span's parent chain reached itself. The link was cut deterministically — see `layout.ts`. */
export const F_CYCLE = 1 << 3;
/** Zero or negative duration, widened to a minimum visible width so the row is still clickable. */
export const F_DEGENERATE = 1 << 4;
/** A correlated log record names this span. Set by the worker, which is the only side that can. */
export const F_HAS_LOG = 1 << 5;

/**
 * Bytes per row. Fields are grouped widest-first so every view lands on its natural alignment
 * without padding — a `Float64Array` at a non-multiple-of-8 offset throws outright. Consumed by
 * {@link layoutViews} so neither realm computes an offset of its own.
 */
export const ROW_BYTES = 8 + 4 + 4 + 4 + 4 + 1 + 1 + 1;

/** The typed-array views over one row buffer. Built identically in both realms. */
export interface LayoutViews {
  /** Wall duration, nanoseconds. `f64` because a nanosecond count exceeds `f32`'s precision. */
  durationNs: Float64Array;
  /** Index into the response's string table. */
  nameId: Uint32Array;
  serviceId: Uint32Array;
  /** Fractions of the trace's total extent, in `[0, 1]` — not pixels and not percentages. */
  left: Float32Array;
  width: Float32Array;
  depth: Uint8Array;
  paletteIndex: Uint8Array;
  /**
   * {@link F_ROOT} | {@link F_ERROR} | {@link F_ORPHAN} | {@link F_CYCLE} | {@link F_DEGENERATE} |
   * {@link F_HAS_LOG}
   */
  flags: Uint8Array;
}

/**
 * Views for `count` rows over `buffer`. **The single source of truth for the byte layout** — the
 * worker writes through it, the panel reads through it. Two functions computing the same offsets is
 * the bug this makes impossible, and no type test can catch a wrong offset.
 */
export function layoutViews(buffer: ArrayBuffer, count: number): LayoutViews {
  let at = 0;
  const take = (bytes: number): number => {
    const offset = at;
    at += bytes * count;
    return offset;
  };
  return {
    durationNs: new Float64Array(buffer, take(8), count),
    nameId: new Uint32Array(buffer, take(4), count),
    serviceId: new Uint32Array(buffer, take(4), count),
    left: new Float32Array(buffer, take(4), count),
    width: new Float32Array(buffer, take(4), count),
    depth: new Uint8Array(buffer, take(1), count),
    paletteIndex: new Uint8Array(buffer, take(1), count),
    flags: new Uint8Array(buffer, take(1), count),
  };
}

/** Allocates a buffer sized for `count` rows. */
export function layoutBuffer(count: number): ArrayBuffer {
  return new ArrayBuffer(count * ROW_BYTES);
}

/** Counts and totals, computed where the spans already are. */
export interface LayoutSummary {
  /** Rows emitted. Equal to {@link spansSeen} unless the cap was hit. */
  spanCount: number;
  /** Spans present in the response, before the cap. */
  spansSeen: number;
  serviceCount: number;
  logCount: number;
  /** The response held more spans than were emitted. The UI is required to say so. */
  truncated: boolean;
  /** The trace's whole extent, nanoseconds — the denominator `left` and `width` are fractions of. */
  totalDurationNs: number;
}

/**
 * How an OTLP `AnyValue` was read.
 *
 * `"string"` is the only kind rendered as text. Every other variant is **named** rather than
 * blanked: the previous reader was `typeof body?.stringValue === "string" ? … : ""`, so a record
 * whose body was a `kvlistValue` rendered as a level, a time and nothing — which reads as an empty
 * log line rather than as a body this panel does not render. `"absent"` is no value at all.
 */
export type LogValueKind =
  "string" | "int" | "double" | "bool" | "array" | "kvlist" | "bytes" | "absent";

/**
 * Why a log record has no waterfall row.
 *
 * Three, not one, and the third is the reason this is an enum at all: only the worker knows whether
 * {@link SPAN_CAP} dropped the span a record names, and reporting *"the cap dropped it"* as *"no
 * such span in this trace"* is a confident claim about the reader's own data that happens to be
 * false. The UI renders distinct copy per value.
 */
export type LogUnattached = "no-span-id" | "span-not-in-trace" | "span-capped";

/** One attribute of a log record, its value read through the same kind logic as a body. */
export interface LogAttr {
  key: string;
  /** Empty unless `kind` is `"string"`. */
  value: string;
  kind: LogValueKind;
}

/** One correlated log record, as the panel receives it. */
export interface LogRecord {
  /** OTLP `severityNumber`, 0 when absent. The cap and the footer's worst-of both order on it. */
  severity: number;
  /** OTLP `severityText`, or `"LOG"`. */
  level: string;
  /** Empty unless `bodyKind` is `"string"`. */
  body: string;
  bodyKind: LogValueKind;
  /** Nanoseconds since the trace's start, clamped at 0 — see `readLogs` on clock skew. */
  offsetNs: number;
  /** Absolute timestamp, nanoseconds. The detail view shows it; `offsetNs` cannot be un-subtracted. */
  timeNs: number;
  /**
   * Index into the row buffer, or `-1`. Not optional: an absent field and a deliberate "no owner"
   * are the same shape in JSON, and the panel would have to guess which it received.
   */
  row: number;
  /** `0` exactly when `row >= 0`. */
  unattached: LogUnattached | 0;
  attrs: LogAttr[];
  /** Attributes the record held, before {@link ATTR_CAP}. */
  attrsSeen: number;
}

export interface LayoutRequest {
  kind: "layout";
  version: number;
  /**
   * Correlates a reply with its request. The worker is reused, so a trace opened, abandoned and
   * reopened has two replies that can arrive in either order. The generation counter refuses a
   * stale write but cannot say *which*; this drops an unawaited reply before it gets there.
   */
  id: number;
  /** The response body, **as text**. Never parsed on the main thread — that is the whole point. */
  body: string;
  /**
   * The query window, ms. **Not the denominator** — `left`/`width` are fractions of the *trace's*
   * extent, since a trace against a ±2s window is a two-pixel smudge. Carried as the only fallback
   * scale when the spans supply none: a single instantaneous span, or spans all sharing one
   * timestamp, has zero extent and no denominator.
   */
  from: number;
  to: number;
}

/**
 * Why a layout produced nothing. Named, not collapsed: "the API sent something unreadable" and
 * "this worker has a bug" are different problems, and one sentence for both misdirects the reader.
 */
export type LayoutFailure =
  /** The body is not JSON at all. */
  | "malformed-json"
  /** Valid JSON with no `resourceSpans` — an error envelope, or an API shape change. */
  | "not-otlp"
  /** Valid OTLP that contained no spans. Distinct from a parse failure: the query succeeded. */
  | "empty"
  /** The worker threw. A bug here, and it says so rather than blaming the payload. */
  | "internal"
  /** The two realms disagree about {@link LAYOUT_PROTOCOL_VERSION}. */
  | "version-mismatch";

export type LayoutResponse =
  | {
      kind: "layout-ok";
      version: number;
      id: number;
      /** Transferred. After posting, the worker's own view of it is detached. */
      buffer: ArrayBuffer;
      count: number;
      /** Interned names and services; `nameId` / `serviceId` index into this. */
      strings: string[];
      /**
       * The correlated logs, capped. Plain objects beside the transfer rather than packed into the
       * buffer: they are bounded two orders of magnitude below the rows, are read only when the
       * reader opens the disclosure, and are mostly *strings*, which a typed array cannot hold
       * without interning them. `strings` already establishes that structured data crosses here.
       */
      logs: LogRecord[];
      /** Records the response held, before {@link LOG_CAP}. Equals `summary.logCount`. */
      logsSeen: number;
      summary: LayoutSummary;
      /** Milliseconds the worker spent parsing and laying out. Measured, never assumed. */
      workerMs: number;
    }
  | {
      kind: "layout-error";
      version: number;
      id: number;
      reason: LayoutFailure;
      /** Safe to display. Never contains the response body or any part of it. */
      message: string;
    };

/**
 * The one failure sentence the *panel* raises itself — the two realms disagreeing. Split out of
 * {@link LAYOUT_FAILURE_COPY} rather than read from it: every other reason is decided in the
 * worker, and importing the record to reach one entry shipped all five sentences (0.4 kB of prose)
 * in stage 2.
 */
export const VERSION_MISMATCH_COPY =
  "d0bar's panel and its layout worker are different versions. Reload the page.";

/** Human copy per failure. Here rather than in the view so the worker's tests can assert it. */
export const LAYOUT_FAILURE_COPY: Record<LayoutFailure, string> = {
  "malformed-json": "The trace response was not valid JSON, so there is nothing to lay out.",
  "not-otlp":
    "The trace response parsed, but carried no resourceSpans. d0bar does not know how to read it.",
  empty: "The query succeeded and the trace held no spans.",
  internal:
    "d0bar failed to lay this trace out. This is a bug in the toolbar, not in the trace.",
  "version-mismatch": VERSION_MISMATCH_COPY,
};
