import { F_HAS_SPAN, F_XHR } from "../shared/flags";
import type { RequestRecord } from "../shared/record";

/**
 * Coverage classification: why a request produced no span. The strongest argument for tier 2 and a
 * diagnostic no backend can produce — the un-instrumented request never arrives, so no query would
 * surface it. Which makes honesty the whole value: "missing" is not an answer, and two gaps with
 * different causes have different fixes.
 *
 * **The spec's original cause list could not be built, and the spec was corrected.** It called for
 * `PROPAGATOR_EXCLUDED`, read from "the propagator match list in configuration" — d0bar does not
 * read the host's SDK configuration and must not claim to (the same copy was rejected once in
 * `add-trace-view`). What replaced it is what is observed: the worker saw the request and there was
 * no `traceparent`. Why is the host's answer, not ours to guess.
 *
 * Every cause below is a direct observation:
 *
 *   subresource      the entry's `initiatorType` is a markup subresource — script, css,
 *                    img, link, font. The browser fetched it; no application code issued it
 *   transport-xhr    the entry's `initiatorType` is `xmlhttprequest`
 *   third-party      the URL's origin is not this page's
 *   not-propagated   the worker read this request's headers; there was no traceparent
 *   unseen           no worker record for it at all — issued before the worker took control
 *   unknown          none of the above can be established
 */

export type Cause =
  "subresource" | "transport-xhr" | "third-party" | "not-propagated" | "unseen" | "unknown";

/** One untraced request, with the cause and the ring index it came from. */
export interface Gap {
  index: number;
  url: string;
  cause: Cause;
}

/**
 * The tab's whole reading. `determinable` is not a detail: with tier 2 off nothing carries a visible
 * trace id, so *every* request classifies as a gap — `11 of 11` on a page that may be fully
 * instrumented. `untraced` and `gaps` are meaningless when it is false and are returned empty, so a
 * caller ignoring the flag renders nothing rather than a lie.
 */
export interface Coverage {
  determinable: boolean;
  total: number;
  untraced: number;
  gaps: Gap[];
}

/** How many gaps are listed. Beyond this the tab reports the count and stops rendering cards. */
export const MAX_GAPS = 50;

/**
 * Classifies one untraced record. `seenByWorker` is the only input not on the record, and separates
 * a request the worker read and found bare from one it never saw — two findings that would otherwise
 * both read as "no trace id".
 */
export function classify(
  record: Pick<RequestRecord, "url" | "flags" | "initiator">,
  origin: string,
  seenByWorker: boolean,
): Cause {
  /* Transport first: an XHR is outside a fetch-only instrumentation regardless of its origin
     or what the worker saw, and that is the most actionable finding here. */
  if (record.flags & F_XHR) return "transport-xhr";

  /* Then requests no application code issued: the parser fetches a stylesheet, a script tag and an
     <img>, and no SDK could have put a `traceparent` on them, so listing them as gaps is true and
     misleading. Rendered against the fixture, the first four cards were `/metrics.js`, `/app.css`,
     `/app.js` and d0bar's own bundle — the signal buried under things nobody can act on. */
  if (SUBRESOURCE.has(record.initiator)) return "subresource";

  const other = originOf(record.url);
  if (other === "") return "unknown";
  if (other !== origin) return "third-party";

  return seenByWorker ? "not-propagated" : "unseen";
}

/**
 * `initiatorType` values meaning "the browser fetched this, not the application" — its own word for
 * it, not a guess from the extension: `/data.json?x=1` and `/style.css` say nothing reliable about
 * who asked.
 */
const SUBRESOURCE = new Set([
  "script",
  "css",
  "link",
  "img",
  "image",
  "font",
  "iframe",
  "video",
  "audio",
  "track",
  "embed",
  "object",
  "input",
  "beacon",
  "ping",
]);

function originOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  /* `blob:` and `data:` parse perfectly well and report their origin as the *string* `"null"`,
     which is not this page's origin and would therefore classify as third-party — a claim
     that the page loaded something from someone else, about a URL that has no other party in
     it at all. Opaque is not foreign; it is unknown, and it says so. */
  return parsed.origin === "null" ? "" : parsed.origin;
}

/**
 * Builds the coverage reading from the ring. `read` fills a caller-owned scratch, as everywhere that
 * walks the ring: the tab repaints per batch, and a per-record object would be an allocation per
 * request per repaint on the page being measured.
 */
export function coverage(options: {
  count: number;
  read(index: number, out: RequestRecord): boolean;
  scratch: RequestRecord;
  origin: string;
  /** Ring indices the worker produced a record for. Empty when tier 2 is off. */
  seen: ReadonlySet<number>;
  /** False when tier 2 is not live — see {@link Coverage.determinable}. */
  determinable: boolean;
}): Coverage {
  if (!options.determinable) {
    return { determinable: false, total: options.count, untraced: 0, gaps: [] };
  }

  const gaps: Gap[] = [];
  let untraced = 0;

  for (let i = 0; i < options.count; i += 1) {
    if (!options.read(i, options.scratch)) continue;
    if (options.scratch.flags & F_HAS_SPAN) continue;
    untraced += 1;
    /* Counted past the cap, listed only up to it. A page with four hundred gaps has told the
       reader what they need in the headline; four hundred cards would not add to it. */
    if (gaps.length >= MAX_GAPS) continue;
    gaps.push({
      index: i,
      url: options.scratch.url,
      cause: classify(options.scratch, options.origin, options.seen.has(i)),
    });
  }

  return { determinable: true, total: options.count, untraced, gaps };
}
