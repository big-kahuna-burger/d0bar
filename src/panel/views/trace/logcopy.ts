import type { LogRecord } from "../../../shared/protocol";

/**
 * The one-word reading for a log row with no span, where the full sentence lives in the detail
 * view's `UNATTACHED_COPY`.
 *
 * Three labels rather than one greyed-out badge. They send a reader to different places: nothing to
 * look for, a trace that is still arriving, and a span that *is* in this trace and simply was not
 * rendered. Collapsing them would make the panel claim a span does not exist when it does, which is
 * the failure only the worker was positioned to prevent.
 */
export const UNATTACHED_LABEL: Record<Exclude<LogRecord["unattached"], 0>, string> = {
  "no-span-id": "trace-level",
  "span-not-in-trace": "span not returned",
  "span-capped": "span not rendered",
};

/**
 * Severity as a band, for the stylesheet.
 *
 * OTLP numbers severities 1–24 in four groups of four plus fatal. Banded rather than passed through:
 * the panel has three colours to say this with, and a 24-value data attribute would put the mapping
 * in CSS where the numbers mean nothing. `0` is a record whose emitter set no severity at all — not
 * an implicit trace, which is what treating it as 1 would claim.
 */
export function severityBand(severity: number): "none" | "debug" | "info" | "warn" | "error" {
  if (severity <= 0) return "none";
  if (severity < 9) return "debug";
  if (severity < 13) return "info";
  if (severity < 17) return "warn";
  return "error";
}

/** Nanoseconds since the trace's start, in whichever unit keeps it readable. */
export function formatLogOffset(offsetNs: number): string {
  const ms = offsetNs / 1e6;
  if (ms < 1) return `${(offsetNs / 1e3).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
