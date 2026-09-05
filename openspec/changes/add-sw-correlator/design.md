# Design — request correlation

## Observation without interception
The `fetch` handler reads `event.request.headers`, posts a record, and returns without calling
`respondWith`. The browser then services the request as if no worker existed: no added latency,
no changed caching semantics, no altered response.

Where a pass-through is ever unavoidable, `PerformanceResourceTiming.workerStart` measures the
worker's own overhead and the toolbar discloses it rather than hiding it.

## The join
Two sources, each authoritative for different fields:

| Source | Authoritative for | Key |
| --- | --- | --- |
| Tier 1 `resource` entry | timings, `transferSize`, `responseStatus` | URL + `startTime` |
| Tier 2 `FetchEvent` | `traceparent`, request headers, existence of never-instrumented requests | URL + issue order |

Naive matching is O(n·m) per flush. Instead: intern the URL to a `u32`, keep a per-URL FIFO of
unjoined Tier 2 records, and pop in issue order. Amortized O(1) per entry. The interning table
from `observation-core` is what makes this cheap — the URL is already a `u32` by the time the
join runs.

Ambiguity is possible: identical URLs issued concurrently can join in the wrong order. The
record carries a `joinConfidence` flag, and the UI does not present a low-confidence trace id
as certain.

## Worker lifecycle
The worker is not reliably alive, and it does not control the first load until claimed. Both
gaps are covered by Tier 1's `buffered: true`. The worker is a correlator and a durable log —
never the store of record.

The request log lives in the worker's IndexedDB so it survives reloads: the request that caused
the error is still there after a refresh. Bounded by count and age, pruned on activation.

## Scope contention
One worker controls a scope. Three outcomes, in order:
1. No worker registered → d0bar registers its own.
2. Host has a worker and imports d0bar's module → full Tier 2.
3. Host has a worker and will not import → **Tier 3 fallback**: Tier 1 only, panel labelled
   degraded, trace jump off. No silent monkey-patching as a consolation prize.

## Rejected
- **Patching `fetch`** — changes the call it observes, misses everything issued before mount,
  and fights every other library patching the same global.
- **`respondWith` pass-through for richer data** — adds latency and changes caching to the
  request it is measuring. Disqualifying.
