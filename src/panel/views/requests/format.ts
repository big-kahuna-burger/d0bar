import { F_HAS_SPAN, F_STATUS_UNKNOWN, F_XHR } from "../../../shared/flags";
import type { RequestRecord } from "../../../shared/record";

/**
 * What a row is allowed to say.
 *
 * Every function here is pure and takes a record, so the decisions the row makes — whether a
 * status is knowable, whether a request carried trace context, what a URL is called — are
 * settled by node tests rather than by reading pixels. The row module only paints them.
 */

/**
 * `412ms` under a second, `1.24s` above it.
 *
 * Two decimal places above the switch, not three: the third digit of a second-scale
 * measurement is below the noise of the thing being measured, and a column of numbers that
 * changes in its last digit for no reason reads as instability.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export type StatusTone = "unknown" | "healthy" | "subtle" | "warn" | "error";

export interface StatusView {
  /** Empty when the browser did not expose the status. Never a guess, never a dash. */
  text: string;
  tone: StatusTone;
}

/**
 * The response status, or the explicit absence of one.
 *
 * `responseStatus` is not on every browser's `PerformanceResourceTiming`, and where it is
 * missing the ring sets `F_STATUS_UNKNOWN` rather than storing a zero that would later read
 * as a status. This renders that as an empty cell: a `—` or a `200` here would both be
 * claims, and the toolbar has nothing to base either on.
 */
export function statusFor(record: RequestRecord): StatusView {
  if (record.flags & F_STATUS_UNKNOWN || record.status === 0) {
    return { text: "", tone: "unknown" };
  }
  const status = record.status;
  if (status === 304) return { text: "304", tone: "subtle" };
  if (status >= 500) return { text: String(status), tone: "error" };
  /* 4xx is the host's own bug or the user's, not the network's, and it is not a 5xx — it
     gets its own tone rather than being folded into either neighbour. */
  if (status >= 400) return { text: String(status), tone: "warn" };
  return { text: String(status), tone: "healthy" };
}

/**
 * The request's display name: path and query for same-origin, host and path for anything
 * else. The origin is dropped only where it is the page's own — on a third-party URL the
 * host *is* the identifying part, and eliding it would make two CDNs look like one.
 */
export function displayPath(url: string, origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    /* Something the parser rejects outright. Shown as it stands and truncated by CSS,
       because the raw string is still the most identifying thing we have. */
    return url;
  }
  /* `data:`, `blob:` and `about:` parse successfully and have no host, so the host-plus-path
     form below silently eats the scheme and turns `data:text/plain,hi` into
     `text/plain,hi` — a string that no longer says what kind of thing it names. Anything
     that is not an HTTP URL is shown whole. */
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
  if (parsed.origin === origin) return parsed.pathname + parsed.search;
  return parsed.host + parsed.pathname + parsed.search;
}

/**
 * The method, or empty.
 *
 * The browser reports no method on a resource entry — the field arrives from tier 2, and
 * `pushResource` deliberately leaves it absent rather than assuming GET. With the worker off,
 * every row's method cell is empty, which is the honest reading of a page where the toolbar
 * genuinely does not know.
 */
export function methodFor(record: RequestRecord): string {
  return record.method;
}

/** The `xhr` marker, per the handoff: shown for `XMLHttpRequest` and for nothing else. */
export function isXhr(record: RequestRecord): boolean {
  return (record.flags & F_XHR) !== 0;
}

/**
 * `TRACE` / `NONE` — whether this request carried trace context d0bar actually saw.
 *
 * `NONE` is not "untraced": it is "no traceparent was observed on this request". With tier 2
 * off, no request has one, which is why the footer's degraded state and the untraced tab both
 * say so rather than letting a column of `NONE` chips imply the host instrumented nothing.
 */
export function hasTrace(record: RequestRecord): boolean {
  return (record.flags & F_HAS_SPAN) !== 0;
}

/**
 * The row's accessible name. Read aloud in place of five separate cells, so it has to carry
 * the same reading a sighted user gets from scanning them — including the absences.
 */
export function accessibleName(record: RequestRecord, origin: string): string {
  const status = statusFor(record);
  const parts = [
    methodFor(record) || "method unknown",
    displayPath(record.url, origin),
    status.text ? `status ${status.text}` : "status unknown",
    formatDuration(record.duration),
    hasTrace(record) ? "traced" : "no trace context",
  ];
  return parts.join(", ");
}
