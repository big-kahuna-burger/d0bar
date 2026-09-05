# add-sw-correlator

## Why
`PerformanceResourceTiming` deliberately exposes no request headers, so Tier 1 can never see a
`traceparent`. A Service Worker can — and it lives outside the page's JavaScript realm, so no
global is touched and no page-thread work is added.

The critical detail is what the worker does **not** do: it never calls `event.respondWith()`.
It reads headers and returns, letting the browser service the request natively. Observation
without interception.

## What Changes
- A service worker that observes `fetch` events and never responds to them.
- `traceparent` extraction and a durable request log in the worker's own IndexedDB.
- An O(1) join between Tier 1 timing truth and Tier 2 header truth.
- Tier availability detection, and honest degradation to Tier 1 only.
- An importable module variant, for hosts that already own their scope.

## Impact
- New capability: `request-correlation`
- New: `src/sw/`, `src/collector/join.ts`, `src/panel/tier.ts`
- Blocks: `add-untraced-view`, `add-trace-view`
- Requires the host to serve a same-origin worker file and permit it in CSP — documented, not
  worked around
