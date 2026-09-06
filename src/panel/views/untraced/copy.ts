import type { Cause, Coverage } from "../../../collector/coverage";

/**
 * What the untraced tab says.
 *
 * Separated from the DOM for the same reason `format.ts` is in the other two views: the
 * decisions worth arguing about are all here, and a node test settles them without a browser.
 *
 * The distinction the whole tab exists to make is between causes with **different fixes**.
 * "3 requests are missing spans" is not a finding; "one is an XHR your instrumentation does
 * not cover, one is a third-party CDN you do not control, and one your worker watched go out
 * bare" is three findings with three different next steps.
 */

/**
 * One sentence per cause, stating the observation and stopping there.
 *
 * **Also the trace surface's cause line.** `views/trace/index.ts` prints these for its no-span
 * state, so the sentences are worded for the cause and not for this tab — "counted here for
 * completeness" was dropped from the subresource line for exactly that reason. The alternative
 * was a second set of sentences about the same six causes, which is a second thing to keep true.
 *
 * None of these names a configuration file, a match list or a likely mistake. d0bar does not
 * read the host's SDK config and cannot see why a request went out without a `traceparent`;
 * it can only report that it did. The spec originally asked for a `PROPAGATOR_EXCLUDED` cause
 * worded as "outside your propagator match list", and that copy is the reason the spec was
 * corrected rather than implemented.
 */
export const CAUSE_COPY: Record<Cause, string> = {
  subresource:
    "Fetched by the browser itself — a script, stylesheet, image or font referenced by the markup. No application code issued it, so there was nothing to attach trace context to. Not a gap to close.",
  "transport-xhr":
    "Sent with XMLHttpRequest. A fetch-only instrumentation does not see this transport at all, so no span was ever started for it.",
  "third-party":
    "A different origin. Trace context is not propagated cross-origin unless that origin is configured to accept it, and the response is not d0bar's to read.",
  "not-propagated":
    "The service worker read this request's headers and there was no traceparent on it. Why there was none is a question about this page's instrumentation — d0bar can only report that the header was absent.",
  unseen:
    "No worker record exists for this request. It was issued before the service worker took control of the page, which is where the first few requests of a first load normally land.",
  unknown:
    "The cause cannot be established. This URL has no origin to compare and carried no trace context.",
};

/** Short label on the card's cause line, ahead of the sentence. */
export const CAUSE_LABEL: Record<Cause, string> = {
  subresource: "subresource",
  "transport-xhr": "wrong transport",
  "third-party": "third party",
  "not-propagated": "no traceparent",
  unseen: "before the worker",
  unknown: "unknown",
};

export type Headline =
  | { kind: "gaps"; text: string; detail: string }
  | { kind: "clean"; text: string; detail: string }
  | { kind: "undeterminable"; text: string; detail: string };

/**
 * The headline, down the honest-degradation ladder.
 *
 * Three states that must never be confused, in the order they degrade:
 *
 *   gaps            a real count, from a real comparison
 *   clean           zero gaps out of a real total — a finding, not an empty screen
 *   undeterminable  tier 2 is off, so nothing here can be compared at all
 *
 * The third is the one that would otherwise be rendered as the second. With no worker, no
 * request carries a trace id d0bar can see, so a naive count reads `11 of 11` on a page that
 * may be perfectly instrumented — the most damaging number this panel could print, because it
 * looks like a finding and is an artefact.
 */
export function headline(reading: Coverage): Headline {
  if (!reading.determinable) {
    return {
      kind: "undeterminable",
      text: "coverage unknown",
      detail:
        "Tier 2 is off, so d0bar cannot see which requests carried trace context. This is not a report of zero gaps — it is the absence of the measurement.",
    };
  }
  if (reading.untraced === 0) {
    return {
      kind: "clean",
      text: `0 of ${reading.total}`,
      detail:
        reading.total === 0
          ? "No requests have been recorded on this page yet."
          : "Every request on this page produced a span.",
    };
  }
  return {
    kind: "gaps",
    text: `${reading.untraced} of ${reading.total}`,
    detail: "requests on this page produced no span.",
  };
}

/** The tab's hover tooltip. Same number as the headline, from the same reading. */
export function tabTooltip(reading: Coverage): string {
  if (!reading.determinable) {
    return "Coverage cannot be determined while tier 2 is off.";
  }
  return `${reading.untraced} of ${reading.total} requests on this page produced no span.`;
}

/**
 * The closing note.
 *
 * The argument for tier 2, stated where the evidence for it is. Deliberately not phrased as a
 * feature pitch: it is the reason this tab can exist at all, and a reader who does not know
 * that will assume Dash0's backend could have told them the same thing.
 */
export const CLOSING_NOTE =
  "Only the service worker can see these. An un-instrumented request produces no span, so it never reaches a backend — no amount of querying would surface it, and the page itself cannot read its own request headers to check.";

/** Shown when the cap is hit, so a truncated list is never read as a complete one. */
export function truncationNote(reading: Coverage, listed: number): string {
  if (reading.untraced <= listed) return "";
  return `${reading.untraced - listed} more not listed.`;
}
