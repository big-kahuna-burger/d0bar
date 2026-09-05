# Tasks — service worker correlator

## 1. Worker registration
- [ ] 1.1 `src/sw/d0bar-sw.ts` built as a separate entry; host serves it same-origin at a documented path
- [ ] 1.2 Detect existing registration before registering; never unregister a host's worker
- [ ] 1.3 `src/sw/module.ts` — importable variant for hosts that already own the scope
- [ ] 1.4 Registration failure is non-fatal; resolve tier state to degraded
- [ ] 1.5 Registration happens **after** settle, never during the load phase
- [ ] 1.6 HTTPS/localhost precondition detected and reported, not assumed

## 2. Observation without interception
- [ ] 2.1 `fetch` handler reads `event.request.headers` and returns — assert `respondWith` is never called
- [ ] 2.2 Lint rule + unit test banning `respondWith` in `src/sw/**`
- [ ] 2.3 Extract `traceparent`; parse trace id and sampled flag; tolerate malformed values
- [ ] 2.4 Record method, URL, `initiatorType` where available, and issue order
- [ ] 2.5 Playwright: with the worker active, assert `workerStart` is 0 for observed requests
- [ ] 2.6 Perturbation harness: worker registered vs not — assert no latency delta beyond threshold

## 3. Durable log
- [ ] 3.1 IndexedDB store in the worker; records keyed by interned URL plus issue order
- [ ] 3.2 Bounded by count and age; pruned on `activate`
- [ ] 3.3 Survives reload — the request that caused an error is still present after refresh
- [ ] 3.4 Quota failure handled: stop logging, report degraded logging, never throw into a fetch handler

## 4. The join
- [ ] 4.1 `src/collector/join.ts` — per-URL FIFO of unjoined Tier 2 records, popped in issue order
- [ ] 4.2 Amortized O(1) per entry; keys are interned `u32`, never strings
- [ ] 4.3 `joinConfidence` flag lowered for concurrent identical URLs
- [ ] 4.4 Tier 1 remains authoritative for timings and status; Tier 2 for headers. Neither overwrites the other's fields
- [ ] 4.5 Unjoined Tier 2 records (requests Tier 1 never saw) retained and surfaced
- [ ] 4.6 Join runs after settle, in the background flush; never in a `fetch` handler or PO callback
- [ ] 4.7 Unit tests from a recorded pair of dumps: ordering, duplicates, concurrent identical URLs, missing counterpart on either side

## 5. Tier state
- [ ] 5.1 `src/panel/tier.ts` — resolve live / off / planned per tier, from real capability checks
- [ ] 5.2 Scope contention detected and mapped to the three documented outcomes
- [ ] 5.3 Degraded state drives the footer dot, the `2 SW off` label, its tooltip copy, and the perturbation label
- [ ] 5.4 Degraded state forces every request into the no-span trace state
- [ ] 5.5 Playwright: a fixture where the host owns the scope — assert the full degraded path renders, not a stub

## 6. Documentation
- [ ] 6.1 The CSP entries and the same-origin worker file a host must serve, modelled on the existing `vercel.live` entries
- [ ] 6.2 The importable-module path, for hosts with their own worker
- [ ] 6.3 What Tier 2 adds, and exactly what is lost without it
