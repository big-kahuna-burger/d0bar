# Tasks — untraced view

## 1. Cause classification
- [ ] 1.1 `src/collector/coverage.ts` — classify each untraced request into a cause enum
- [ ] 1.2 `TRANSPORT_XHR` — `initiatorType === 'xmlhttprequest'`, i.e. outside the SDK's fetch-only instrumentation
- [ ] 1.3 `PROPAGATOR_EXCLUDED` — a fetch with no `traceparent` whose URL fails the configured propagator match
- [ ] 1.4 `THIRD_PARTY` — cross-origin and outside any configured match list
- [ ] 1.5 `UNKNOWN` — no cause can be established; rendered as unknown, never guessed
- [ ] 1.6 Propagator match list read from configuration; absent config downgrades `PROPAGATOR_EXCLUDED` to `UNKNOWN`
- [ ] 1.7 Unit tests per cause, including the downgrade path

## 2. Tab body
- [ ] 2.1 Headline: `N of M` in 20px mono warning colour plus the sans explanation
- [ ] 2.2 One card per gap: `18px 1fr` grid, 6px warning dot, URL in mono, cause below in subtle
- [ ] 2.3 Cause copy per class, distinguishing transport from deliberate exclusion
- [ ] 2.4 Closing note explaining that only the worker can see these
- [ ] 2.5 Empty state: zero gaps → state that every request on the page produced a span; badge hidden, tab retained
- [ ] 2.6 Degraded state: tier 2 off → explain that coverage cannot be determined, rather than showing zero gaps

## 3. Wiring
- [ ] 3.1 Untraced count feeds the tab badge and the pill badge from one source
- [ ] 3.2 Counts update live as requests stream in
- [ ] 3.3 Tab hover tooltip: `N of M requests on this page produced no span.`
