# Design — observation core

## Ring buffer layout
One `ArrayBuffer`, struct-of-arrays, capacity 512 (power of two, mask indexing). Fixed stride;
no per-entry object ever exists.

| Field | Type | Source |
| --- | --- | --- |
| `startTime`, `duration` | f64 | `PerformanceResourceTiming` |
| `connectStart`, `requestStart`, `responseStart`, `responseEnd` | f64 | phase segments for the waterfall |
| `transferSize`, `encodedBodySize` | f64 | — |
| `urlId`, `initiatorId`, `methodId` | u32 | interned |
| `status` | u16 | `responseStatus`, 0 when unsupported |
| `flags` | u16 | `XHR`, `CACHED`, `RENDER_BLOCKING`, `STATUS_UNKNOWN`, `HAS_SPAN` |

`push()` is straight-line typed-array writes plus interning lookups. No allocation, so the GC
never sees load-phase traffic.

## Interning
Resource URLs repeat; strings are the only allocation source in the hot path. `Map<string,u32>`
+ `string[]`, ids from 1 (0 = absent). Capped at 4096 — past the cap `push()` records
`OVERFLOW_ID` rather than growing without bound.

## Moratorium
Phase is `collecting` → `settled`. Transition when LCP is final — the first of first input,
`visibilitychange` → hidden, or `load` — **and** one background task has since run.

While `collecting`: ring writes only. No derive, no DOM write, no `postMessage`, no pill text
update. `buffered: true` means nothing is lost by deferring, which is what makes this free.

Flush after `settled` on `scheduler.postTask({priority:'background'})` with a `TaskSignal`;
`requestIdleCallback` as fallback. Never `setTimeout`.

## Overflow
Ring full → overwrite oldest, increment `dropped`. `dropped > 0` is surfaced in the UI. A
toolbar that silently drops entries is lying about a different thing.

## Alternatives rejected
- **Objects in an array.** Allocation and GC pressure in exactly the wrong window.
- **`SharedArrayBuffer` + `Atomics`, worker owns state.** Lowest main-thread cost, but needs
  COOP/COEP cross-origin isolation, which d0bar cannot impose on a customer's app. Revisit
  behind `crossOriginIsolated` as an opportunistic upgrade only.
- **Service Worker as store of record.** It cannot see `PerformanceObserver` entries and is
  killed aggressively. It is a correlator and durable log, not the hot store.
