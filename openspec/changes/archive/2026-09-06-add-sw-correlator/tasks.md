# Tasks — service worker correlator

Checkbox state was stale: the change was built across several sessions and never ticked. Each
box below was re-verified against the code and a passing test before being marked, and two
genuine gaps were found by doing so — 2.6 and 5.5, both of which were unbuilt and are now done.

## 1. Worker registration
- [x] 1.1 `src/sw/d0bar-sw.ts` built as a separate entry (`vite.config.ts`, `D0BAR_STAGE=sw`);
      host serves it same-origin at the scope root. Verified in `tier2.spec.ts` — "claims the
      whole origin, not the directory the file sits in", asserting scope `http://127.0.0.1:8732/`
- [x] 1.2 `src/collector/sw.ts` calls `getRegistration()` first and returns `scope-owned` for
      someone else's worker. Nothing in the file unregisters anything
- [x] 1.3 `src/sw/module.ts` — importable variant, both `importScripts` and ESM, documented in
      the readme
- [x] 1.4 Registration failure is non-fatal: `safe()` swallows and resolves `registration-failed`,
      which is a tier state the panel renders rather than an error
- [x] 1.5 Registration happens after settle. Verified in `tier2.spec.ts` — "does not register
      during the load phase", asserting the registration timestamp against `loadEventEnd`.
      Timed from inside the page: the worker script is fetched by the browser's service-worker
      machinery, not the document, so `page.on("request")` never fires for it
- [x] 1.6 `self.isSecureContext` checked and reported as its own `insecure-context` state, kept
      separate from a generic failure — on a plain-http staging host that is the whole
      explanation, and "registration failed" would send someone hunting a bug that is not there

## 2. Observation without interception
- [x] 2.1 `src/sw/observe.ts` reads `event.request.headers` and returns
- [x] 2.2 Banned two ways, because one is not enough: an ESLint `no-restricted-syntax` selector
      over `src/sw/**`, and `tests/unit/sw-observes.test.ts` grepping the **built** artifacts —
      lint cannot see a `respondWith` that arrives through an alias
- [x] 2.3 `traceparent` extracted and parsed, malformed values tolerated. 21 unit cases in
      `tests/unit/traceparent.test.ts`; end-to-end in `tier2.spec.ts` — "logs the traceparent
      the page cannot see"
- [x] 2.4 Method, URL, initiator and issue order recorded. `tier2.spec.ts` — "records the
      method, which tier 1 never reports"
- [x] 2.5 **The task as written was wrong and the spec was corrected rather than the code.**
      "Assert `workerStart` is 0" was written as though the field were zero for a pass-through
      worker. It is not: it marks when service-worker handling *began*, and it is stamped
      whether or not the handler responds, so a zero assertion could only ever pass on a page
      with no worker — which proves nothing about one that has a worker. What is claimable is
      that the overhead is bounded and disclosed. Measured over 250 requests: p50 0.5ms,
      p95 3.4ms, max 3.6ms; asserted at p95 against a 5ms threshold
- [x] 2.6 `tests/perf/worker-perturbation.spec.ts` — `?d0bar=on` against `?d0bar=on&sw=off`.
      The identical bundle, toolbar and fixture with and without a registration, so the
      toolbar's own cost is in both arms and cancels; what is left is the worker. **1458
      requests per arm: p50 identical to 0.1ms, p95 +1.6ms against a 12ms budget.** Arms are
      interleaved rather than sequential, or a machine that got busy halfway through would load
      the whole penalty onto whichever ran second. This is the comparison `tier2.spec.ts` could
      not make: that test bounds service-worker *dispatch*, which any registered worker imposes,
      and cannot attribute it to d0bar's handler because it has no worker-free arm

## 3. Durable log
- [x] 3.1 `src/sw/log.ts` + `src/sw/protocol.ts` — IndexedDB store, records keyed by interned
      URL plus issue order
- [x] 3.2 Bounded by both count and age (`MAX_RECORDS` 2000, `MAX_AGE_MS` 30 min), pruned on
      `activate` rather than per write — pruning on every write would put a cursor walk in the
      path of a request
- [x] 3.3 Survives reload. `tier2.spec.ts` — "survives a reload"
- [x] 3.4 Quota failure latches `degraded` and stops logging; nothing throws into a fetch
      handler. Two independent ways to be degraded are folded into one reading: the database
      failing to open at all, and a write hitting quota

## 4. The join
- [x] 4.1 `src/collector/join.ts` — per-URL FIFO of unjoined tier 2 records, popped in issue
      order
- [x] 4.2 Amortized O(1) per entry; keys are interned `u32`
- [x] 4.3 `joinConfidence` lowered for concurrent identical URLs
- [x] 4.4 Tier 1 authoritative for timings and status, tier 2 for headers; neither overwrites
      the other's fields
- [x] 4.5 Unjoined tier 2 records retained and surfaced — they are what `coverage.ts`
      distinguishes as `not-propagated` (the worker saw it go out bare) from `unseen`
- [x] 4.6 `flushCorrelation` runs once after settle at background priority, never in a `fetch`
      handler or a PerformanceObserver callback
- [x] 4.7 15 unit cases in `tests/unit/join.test.ts`: ordering, duplicates, concurrent identical
      URLs, and a missing counterpart on either side

## 5. Tier state
- [x] 5.1 `src/panel/tier.ts` — `resolveTiers()` from real capability checks, not from a flag
- [x] 5.2 Scope contention mapped to the three documented outcomes in `src/collector/sw.ts`.
      Outcome 2 is resolved by **observation**, not by asking: whether a host's worker imported
      d0bar's module is not knowable from the page, and it is under no obligation to answer, so
      `noteWorkerRecords()` upgrades the tier on records actually arriving
- [x] 5.3 Degraded state drives the footer dot, the `2 SW off` label, its tooltip copy and the
      perturbation label. The label carries the reading as well as the dot — a screenshot, a
      monochrome display and a colour-blind reader all lose the dot
- [x] 5.4 Degraded forces every request into the no-span trace state; `traceJumpAvailable()`
      gates the jump
- [x] 5.5 `tier2.spec.ts` — "the host owns the scope", against a real contended origin.
      `bench/fixtures/host/host-sw.js` is a worker belonging to the host page that knows nothing
      about d0bar and has no `fetch` handler at all, registered under `?hostsw=1` before the
      bundle loads and claiming the page on activate. Two tests: the footer renders `2 SW off`
      carrying the **`scope-owned`** sentence specifically — asserted not to be the
      `not-registered` copy, since those two states are one dot apart in the footer and
      completely different situations for the developer reading it — and every request resolves
      to the no-span state with `fetch` and `XMLHttpRequest.prototype.open` still pristine and
      native. The second is the rejected alternative asserted absent: patching `fetch` is what
      every other toolbar does when the scope is unavailable, and the degraded state is the
      answer here rather than a problem to route around

## 6. Documentation
- [x] 6.1 `readme.md` §"Tier 2 — the service worker": the same-origin worker file, the scope-root
      constraint, and `worker-src 'self'` (with `child-src 'self'` for older policies)
- [x] 6.2 The importable-module path documented for both `importScripts` and ESM
- [x] 6.3 `readme.md` §"What tier 2 adds, and what is lost without it" — a with/without table,
      plus the three scope outcomes as a diagram
