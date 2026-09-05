# Tasks — modernize observation APIs

## 1. Load signal from the navigation entry
- [x] 1.1 `phase.ts` — remove the `load` listener; `onLoaded()` is called from the `navigation` observer in `observe.ts`
- [x] 1.2 Guard on `loadEventEnd > 0`; the first delivery carries zeros and must be ignored
- [x] 1.3 Idempotent — the entry may be delivered more than twice; only the first non-zero delivery counts
- [ ] 1.4 Unit test with a synthetic two-delivery sequence, asserting the zero delivery does not settle the phase

## 2. Visibility from the entry type
- [x] 2.1 Observe `visibility-state` with `buffered: true`; the buffered `{ name: "visible", startTime: 0 }` establishes the initial state
- [x] 2.2 Remove the `visibilitychange` listener; `name === "hidden"` finalizes LCP as before
- [x] 2.3 Where the type is unsupported, read `document.visibilityState` once at start and record the state as unknown thereafter — do not fall back to a listener
- [x] 2.4 Update the `phase.ts` doc comment, which currently claims one host listener is registered

## 3. Assert the property
- [x] 3.1 `non-perturbation.spec.ts` — count listeners via CDP `DOMDebugger.getEventListeners` on `window` and `document`, snapshot before start and after, assert no delta
- [x] 3.2 Assert the same after teardown, so a removed listener is not merely balanced by an added one

## 4. deliveryType
- [x] 4.1 Add `deliveryType` to `ResourceTimingExtras`
- [x] 4.2 Feature-detect once on `PerformanceResourceTiming.prototype`, as `statusSupported` already does
- [x] 4.3 `F_CACHED` set from `deliveryType === "cache"`; add `F_CACHE_INFERRED` for the heuristic path
- [ ] 4.4 Requests view distinguishes inferred from reported cache status
- [x] 4.5 Unit tests for both paths against synthetic entries

## 5. Fixture
- [x] 5.1 `bench/fixtures/server.mjs` — serve one asset with `Cache-Control: max-age=300`
- [x] 5.2 Fixture requests it twice, the second after load so it does not perturb the load-phase burst
- [x] 5.3 Browser test asserting the second request yields a non-network `deliveryType`
- [ ] 5.4 Re-measure the heuristic against `deliveryType` now that a real cache hit exists; record the agreement rate in `bench/README.md`

## 6. Version skew
- [ ] 6.1 `bench/README.md` — record that the bundled Chromium (148), CI Chromium (151) and stable Chrome (152) have different `supportedEntryTypes`, and that capability-dependent behaviour must be tested on both sides of each gap
