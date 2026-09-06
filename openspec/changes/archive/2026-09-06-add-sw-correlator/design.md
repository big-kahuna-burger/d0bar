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

## The worker's cost, isolated

Two different questions were being answered by one number, and separating them changed what
could honestly be claimed.

`tier2.spec.ts` bounds `fetchStart - workerStart` — p50 0.5ms, p95 3.4ms, max 3.6ms over 250
requests. That is service-worker **dispatch**, and it is a cost any registered worker imposes.
It says nothing about whether d0bar's handler is responsible for it, because there is no arm in
that test without a worker at all.

`worker-perturbation.spec.ts` answers the other question by holding everything else still.
`?d0bar=on` and `?d0bar=on&sw=off` load the identical bundle, start the identical toolbar and
run the identical fixture; only the worker path differs, so the toolbar's own cost is present in
both arms and cancels:

```
worker ON    n=1458   p50 496.1ms   p95 931.9ms
worker OFF   n=1458   p50 496.1ms   p95 930.3ms
delta p95    +1.6ms                 (budget 12ms)
```

**Registering the worker does not move request latency.** p50 is identical to a tenth of a
millisecond and p95 differs by 1.6ms against a 12ms budget.

Three things about the method, because they are what make the number mean anything:

- **Interleaved arms**, not one after the other. A machine that gets busy halfway through would
  otherwise load the whole penalty onto whichever arm ran second, and the result would measure
  scheduling rather than the worker.
- **Only the fixture's own API traffic.** The worker script is fetched in one arm and not the
  other, so including static assets would measure the arm rather than the effect.
- **One-sided comparison.** A negative delta means the worker arm was faster, which is noise
  rather than a finding; failing on it would make the suite flaky in the only direction that
  cannot indicate a regression.

`?d0bar=on&sw=off` is the right control here for the same reason `gated` is the right control in
`ab.spec.ts`: it loads what the other arm loads and starts what the other arm starts, so the
comparison isolates one variable instead of measuring a script download.
