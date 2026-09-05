# Tasks — untraced view

## 1. Cause classification
- [x] 1.1 `src/collector/coverage.ts` — classify each untraced request into a cause enum
- [x] 1.2 `transport-xhr` — `F_XHR`, i.e. outside the SDK's fetch-only instrumentation
- [x] 1.3 ~~`PROPAGATOR_EXCLUDED`~~ → `not-propagated`. **Spec corrected, not implemented.**
      The original wording — "whose URL fails the configured propagator match" — names a cause
      d0bar cannot observe. It does not read the host's SDK configuration, so the match list is
      not available to it at any tier. What is observed is that the worker read the request's
      headers and found no `traceparent`; why there was none is the host's answer to give.
      Same copy was already rejected once in `add-trace-view`.
- [x] 1.4 `third-party` — cross-origin. An opaque origin (`blob:`, `data:`, which `URL` reports
      as the *string* `"null"`) is `unknown`, not third-party: opaque is not foreign.
- [x] 1.5 `unknown` — no cause can be established; rendered as unknown, never guessed
- [x] 1.6 **Replaced.** 1.6 was the downgrade path for the config read in 1.3, which does not
      exist. Two causes were added instead, both from what the browser already reports:
      `unseen` (no worker record at all — issued before the worker took control, which is where
      the first requests of a first load land) and `subresource` (`initiatorType` is script,
      css, img, link, font…: the parser issued it, so no SDK could have attached context).
      `subresource` came out of looking at the rendered tab — `/app.css`, `/app.js` and
      `/metrics.js` were the first three cards, each of them true and none of them actionable,
      burying the API calls the tab exists to surface.
- [x] 1.7 Unit tests per cause — `tests/unit/coverage.test.ts`, 16 tests, including the
      transport-before-origin and subresource-before-origin orderings and the opaque-URL case.

## 2. Tab body
- [x] 2.1 Headline: `N of M` in 20px mono warning colour plus the sans explanation
- [x] 2.2 One card per gap: `18px 1fr` grid, 6px warning dot, URL in mono, cause below in subtle
- [x] 2.3 Cause copy per class — `src/panel/views/untraced/copy.ts`, one sentence each, each
      stating an observation and stopping there
- [x] 2.4 Closing note explaining that only the worker can see these
- [x] 2.5 Empty state: zero gaps → every request on the page produced a span; badge hidden, tab
      retained
- [x] 2.6 Degraded state: tier 2 off → coverage cannot be determined, rather than zero gaps.
      This is the failure the whole view is one line away from: with no worker nothing carries
      a trace id d0bar can see, so a naive count reads `M of M` on a page that may be perfectly
      instrumented.

## 3. Wiring
- [x] 3.1 Untraced count feeds the tab badge and the pill badge from one `publish()` call, so
      the badge and the headline cannot disagree
- [x] 3.2 Counts update live as requests stream in — `onBatch`, plus `refresh()` after the
      correlation flush, which is when trace ids actually land in the ring
- [x] 3.3 Tab hover tooltip: `N of M requests on this page produced no span.`, and the
      undeterminable sentence in its place when tier 2 is off

## 4. Verification
- [x] 4.1 `tests/unit/coverage.test.ts` (16) and `tests/unit/untraced-view.test.ts` (10) pass
- [x] 4.2 Rendered against the fixture in Chromium: headline `186 of 308`, 50 cards,
      `136 more not listed.`, causes `subresource` / `transport-xhr` / `not-propagated` /
      `third-party`, badge `186`, no horizontal overflow
- [ ] 4.3 **Not done.** No Playwright spec for this view. What is browser-verified above was
      verified by hand and is not guarded against regression; the two states most worth a spec
      are the undeterminable headline with `?sw=off` and the badge-before-first-open path.

## 5. Naming
- [x] 5.1 The view's root class is `coverage`, not `untraced`. `pill.css:101` already defines
      `.untraced` (the pill's badge: `height: 22px; display: flex`) and both stylesheets are
      adopted on the same closed shadow root, so the pill's rule was flattening every card.
      Found by rendering it, not by reading the CSS.
