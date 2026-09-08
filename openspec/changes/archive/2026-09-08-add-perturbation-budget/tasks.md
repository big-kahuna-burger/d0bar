# Tasks — perturbation budget

## 1. Hostile fixture page
- [x] 1.1 `bench/fixtures/host/index.html` — static shell that scores poorly on its own
- [x] 1.2 300 requests: ~60% `fetch`, ~20% `XMLHttpRequest`, ~20% subresources; staggered over 3 s
- [x] 1.3 Cross-origin subset, to exercise Timing-Allow-Origin-restricted entries
- [x] 1.4 A deliberately slow LCP image (~1.9 s TTFB) via a throttled local route
- [x] 1.5 An induced layout shift after load (the "rate table" case from the handoff)
- [x] 1.6 A ~84 ms long animation frame on a button click, for INP and LoAF
- [x] 1.7 Deterministic mode: fixed seed, fixed delays, no wall-clock dependence

## 2. Recorded data fixtures
- [ ] 2.1 `bench/fixtures/entries.json` — a captured `resource`/vitals entry dump from the host fixture
- [x] 2.2 `bench/fixtures/trace-4000.json` — corrected while implementing: a deterministic,
      synthetic OTLP trace, 4000 spans, 40 services, depth ≥ 12. Capturing a real tenant's trace
      would commit customer service names, URLs and timings; the generator and fixture document
      the substitution and preserve the protojson shape the worker measures.
- [x] 2.3 `bench/fixtures/trace-small.json` — the handoff's 7-span mock, for visual parity
- [x] 2.4 A loader that replays an entry dump into the ring, so ring/join/layout benchmarks need no browser

## 3. A/B measurement harness
- [x] 3.1 `tests/perf/ab.spec.ts` — same fixture, gate off vs. gate on, n ≥ 20 alternating runs
- [x] 3.2 Collect INP, LCP, CLS, TBT, and long-task count per run via CDP + `PerformanceObserver`
- [x] 3.3 Compare **p95 deltas**, never means; report the full distribution in CI output
- [x] 3.4 Fail on: Δp95 INP > 2 ms, Δ CLS > 0.001, Δp95 TBT > 5 ms, any new long task > 50 ms attributable to d0bar
- [x] 3.5 Warm-up run discarded; CPU throttling 4× applied identically to both arms

## 4. Non-perturbation assertions
- [x] 4.1 `fetch` identity: compare against a pristine same-origin iframe's `fetch`, including `Function.prototype.toString`
- [x] 4.2 Same for `XMLHttpRequest.prototype.open` / `send`
- [x] 4.3 Host style isolation: `document.styleSheets` length and rule count unchanged; zero `<style>`/`<link>` added to host `<head>`
- [ ] 4.4 Host layout isolation: assert d0bar interaction produces zero host-element layout invalidation (CDP layout counters)
- [ ] 4.5 Heap: `measureUserAgentSpecificMemory()` when cross-origin isolated, else `performance.memory`; bound steady-state growth over 60 s idle
- [x] 4.6 Zero registered service worker and zero network request when gated off

## 5. Budget file and CI
- [x] 5.1 `bench/budget.json` — one row per metric per change, with the committed threshold and last-measured value
- [x] 5.2 CI job on every PR; failure prints which row regressed and by how much
- [x] 5.3 Baseline artifact uploaded per run so drift is reviewable over time
- [x] 5.4 `bench/README.md` — how to run locally, and how to update a threshold deliberately (requires reviewer sign-off in the PR body)
