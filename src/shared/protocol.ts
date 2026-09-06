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
export const LAYOUT_PROTOCOL_VERSION = 1;

/**
 * Row cap. Not memory (8192 rows is 216 kB) but readability: past this the waterfall is unreadable
 * and saying so is the honest move — beyond it sets {@link LayoutSummary.truncated}, which the UI
 * must surface. Above the 4000-span budget case on purpose, so the benchmark measures a whole trace
 * rather than the cap; truncation is unit-tested with an injected cap.
 */
export const SPAN_CAP = 8192;

/* ── row flags ──
   One `u8` rather than five booleans (five bytes). Each is a statement the UI must render; none of
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
  /** {@link F_ROOT} | {@link F_ERROR} | {@link F_ORPHAN} | {@link F_CYCLE} | {@link F_DEGENERATE} */
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
  /** The single most severe correlated log, for the footer. Absent when there are none. */
  log?: { level: string; message: string };
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
