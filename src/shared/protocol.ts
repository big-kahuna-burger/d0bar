/**
 * The page ↔ layout-worker contract.
 *
 * In `src/shared/` for the same reason `broker.ts` is: two realms need it, and they compile
 * against different libs — the panel against `lib.dom`, the worker against `lib.webworker`.
 * A shared file is the only thing both can import.
 *
 * **The shape is the guarantee here too, and the guarantee is different from `broker.ts`'s.**
 * There the types exist so a credential has nowhere to travel. Here they exist so that *work*
 * has nowhere to travel: the response carries rows that are already positioned, in typed arrays
 * over one buffer, with strings interned to `u32`. There is no tree in it, nothing to sort, and
 * no percentage left to compute. A main thread that receives this cannot accidentally do the
 * work the worker exists to do, because the work is not expressible on what it is handed.
 *
 * The buffer is **transferred**, not copied. That is the difference between handing over 108 kB
 * of rows and structured-cloning it, and it is asserted rather than assumed — see
 * `tests/unit/layout-protocol.test.ts`.
 */

/**
 * Bumped whenever the byte layout, the field set, or the message shape changes.
 *
 * Checked on both sides. The panel and the worker are separate build artifacts served from the
 * same origin with `no-store`, but a host may cache them differently, and a worker one version
 * behind would otherwise read the right bytes at the wrong offsets and produce a waterfall that
 * looks plausible and is wrong — the single worst failure this module can have.
 */
export const LAYOUT_PROTOCOL_VERSION = 1;

/**
 * The most rows the worker will emit.
 *
 * Not a memory limit — 8192 rows is 216 kB — but a rendering one: past this the waterfall has
 * stopped being readable and the honest move is to say so. Anything beyond the cap sets
 * {@link LayoutSummary.truncated}, which the UI is required to surface.
 *
 * Chosen above the 4000-span budget case on purpose, so the benchmark measures a whole trace
 * rather than the cap. Truncation is exercised by unit tests with an injected cap instead.
 */
export const SPAN_CAP = 8192;

/* ── row flags ──
   One `u8` per row rather than five booleans, because five booleans is five bytes and this is
   one. Every one of them is a statement the UI is required to render: none of these conditions
   is repaired silently. */

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
 * Bytes per row, and the per-field offsets within the buffer.
 *
 * Fields are grouped by width and laid out widest-first, so every view starts on its own
 * natural alignment without padding: a `Float64Array` at a non-multiple-of-8 offset throws
 * outright, and a `Uint32Array` at an odd one does too. Derived here once and consumed by
 * {@link layoutViews}, so neither realm computes an offset of its own.
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
 * Builds the views for `count` rows over `buffer`.
 *
 * **The single source of truth for the byte layout**, called by the worker to write and by the
 * panel to read. Two functions computing the same offsets is the bug this exists to make
 * impossible; a type test cannot catch a wrong offset, and this makes one unnecessary.
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
   * Correlates a response with its request.
   *
   * A worker is reused across selections and a trace opened, abandoned and reopened produces
   * two in-flight requests whose replies can arrive in either order. The machine's generation
   * counter already refuses a stale write, but it cannot tell *which* reply it is refusing;
   * this can, and a reply for an id nobody is waiting on is dropped before it reaches it.
   */
  id: number;
  /** The response body, **as text**. Never parsed on the main thread — that is the whole point. */
  body: string;
  /**
   * The query's own time window, milliseconds — `TraceQueryRequest.timeRange`.
   *
   * **Not the denominator.** `left` and `width` are fractions of the *trace's* extent, because
   * a trace laid out against a ±2s query window would be a two-pixel smudge in the middle of an
   * empty waterfall. The spans decide the scale.
   *
   * It is carried because it is the only scale available when the spans cannot supply one: a
   * trace of a single instantaneous span, or of spans that all share one timestamp, has an
   * extent of zero and no denominator at all. Falling back to the window puts that row where it
   * actually happened rather than filling the waterfall with a bar that means nothing.
   */
  from: number;
  to: number;
}

/**
 * Why a layout produced nothing.
 *
 * Named, not collapsed, for the same reason `QueryFailure` is: "the API sent something this
 * worker could not read" and "this worker has a bug" are different problems, and a panel that
 * shows one sentence for both sends the reader to the wrong place.
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
 * The one failure sentence the *panel* produces on its own.
 *
 * Split out of {@link LAYOUT_FAILURE_COPY} rather than read from it, because that record is
 * otherwise entirely the worker's: every other reason is decided inside the worker and arrives
 * as a message. Importing the whole record to reach one entry shipped all five sentences in the
 * stage-2 bundle for the one the panel can reach without asking — 0.4 kB of prose on the path a
 * developer waits for. This is the only one the panel can raise, because it is the one about the
 * two realms disagreeing.
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
