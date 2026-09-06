import { F_NO_PHASES } from "../../../shared/flags";
import type { RequestRecord } from "../../../shared/record";

/**
 * Waterfall geometry.
 *
 * Two properties this module exists to hold:
 *
 *   1. **One shared window.** Every bar is placed inside the same fixed 3000 ms page-relative
 *      span, so two bars of equal length mean two requests of equal duration — anywhere in
 *      the list. A per-row window would make the waterfall a picture of nothing.
 *   2. **Nothing is synthesized.** Segments come from the entry's own phase timestamps. Where
 *      the browser reports none — a cross-origin response without `Timing-Allow-Origin`, or a
 *      cache hit, both of which report zeroes — the answer is `null` and the bar is drawn
 *      undifferentiated. Splitting an unmeasured bar into plausible thirds would be the
 *      toolbar inventing the exact data it exists to report honestly.
 *
 * The output is two numbers and a small list, not DOM: the row writes them as custom
 * properties, so a bar that updates recalculates style inside its own contained row and
 * nowhere else.
 */

/** The shared comparison window, in milliseconds. One constant, referenced everywhere. */
export const WINDOW_MS = 3000;

/**
 * Floor on a bar's width, as a fraction of the window.
 *
 * A 2 ms request is 0.07% of the window and would render as nothing at all — the row would
 * carry a duration the waterfall silently disagreed with. The floor makes it a tick mark.
 * Below it the bar stops being proportional, which is why it is this small.
 */
export const MIN_WIDTH = 0.012;

export type PhaseKind = "lead" | "connect" | "wait" | "transfer";

export interface Segment {
  kind: PhaseKind;
  /** Fraction of the bar's own width, 0..1. */
  fraction: number;
}

export interface Bar {
  /** Left edge as a fraction of the window, 0..1. Written as `--l`. */
  left: number;
  /** Width as a fraction of the window, 0..1. Written as `--w`. */
  width: number;
  /**
   * Phase breakdown, or `null` when the browser exposed no phase timings. `null` is a
   * rendering instruction, not an empty list: the bar must look different from a measured
   * one, not merely lack colour.
   */
  segments: Segment[] | null;
  /** True when the request started after the window ends, so its bar is pinned at the edge. */
  clipped: boolean;
}

/**
 * Places one record in the window.
 *
 * A request that starts past 3000 ms is pinned to the right edge and flagged `clipped`
 * rather than dropped or rescaled: the row still exists and its duration column is still
 * correct, so the waterfall says "later than this window shows" instead of lying by omission
 * or by silently stretching everyone else's bars.
 */
export function barFor(record: RequestRecord, windowMs: number = WINDOW_MS): Bar {
  const start = Math.max(0, record.startTime);
  const clipped = start >= windowMs;
  const left = clipped ? 1 : start / windowMs;
  const width = clipped
    ? 0
    : Math.min(1 - left, Math.max(MIN_WIDTH, record.duration / windowMs));

  return { left, width, segments: segmentsFor(record), clipped };
}

/**
 * The three measured phases, as fractions of the bar.
 *
 * `lead` is the fourth, and it is not a phase: it is the span between the entry's
 * `startTime` and the moment the connection began — redirects, queueing, and the service
 * worker's own dispatch. The record carries no breakdown of it, so it is not given a colour
 * of its own; it is emitted so the three that *are* measured start where they really started
 * rather than being stretched to fill from zero.
 */
function segmentsFor(record: RequestRecord): Segment[] | null {
  if (record.flags & F_NO_PHASES) return null;

  const { startTime, requestStart, responseStart, responseEnd } = record;
  /* Every one of these must be a real timestamp. A zero here is the browser declining to
     report, not a measurement of zero — the difference matters, and only `null` states it. */
  if (requestStart <= 0 || responseStart <= 0 || responseEnd <= 0) return null;

  const total = responseEnd - startTime;
  if (total <= 0) return null;

  /* `connectStart` is zero on a reused connection, where no connect happened to time. The
     connect segment is then genuinely empty and drops out below, which is correct: the
     request did not connect, it inherited a connection. */
  const connectAt = record.connectStart > 0 ? record.connectStart : requestStart;

  const out: Segment[] = [];
  push(out, "lead", connectAt - startTime, total);
  push(out, "connect", requestStart - connectAt, total);
  push(out, "wait", responseStart - requestStart, total);
  push(out, "transfer", responseEnd - responseStart, total);
  /* Every phase measured as zero — possible when the whole exchange lands inside the clock's
     resolution. An empty list would render as an unstyled bar indistinguishable from the
     unmeasured case, so it is reported as unmeasured, which is the weaker and truer claim. */
  return out.length === 0 ? null : out;
}

function push(out: Segment[], kind: PhaseKind, ms: number, total: number): void {
  if (ms <= 0) return;
  out.push({ kind, fraction: Math.min(1, ms / total) });
}
