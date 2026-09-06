/** Per-request bits packed into the ring's `flags` field. */
export const F_XHR = 1 << 0;
export const F_CACHED = 1 << 1;
export const F_RENDER_BLOCKING = 1 << 2;
/** The browser did not expose `responseStatus`; the UI must render the status as unknown. */
export const F_STATUS_UNKNOWN = 1 << 3;
export const F_HAS_SPAN = 1 << 4;
/**
 * Phase timings are unavailable — a cross-origin response without `Timing-Allow-Origin`
 * reports zeroes rather than durations. The waterfall must draw one undifferentiated bar
 * instead of inventing proportions.
 */
export const F_NO_PHASES = 1 << 5;
/**
 * The cache status was inferred from transfer sizes rather than reported by the browser.
 * `deliveryType` states it outright; the size heuristic only guesses, and a 304 or an
 * opaque cross-origin response can produce the same shape as a cache hit. The UI must not
 * present an inferred value with the confidence of a reported one.
 */
export const F_CACHE_INFERRED = 1 << 6;
/**
 * Tier 2 and tier 4 both supplied a trace id for this request, and they disagree.
 *
 * Not resolved by preferring one: they read different things — tier 2 reads the
 * `traceparent` header the browser actually sent, tier 4 reads the span the host's SDK
 * created — and a disagreement means the join matched the wrong pair on at least one side.
 * Silently picking a winner would present a trace id that is wrong with full confidence,
 * which is the one failure this toolbar cannot have. Flagged so the UI reports it.
 */
export const F_TRACE_CONFLICT = 1 << 7;
