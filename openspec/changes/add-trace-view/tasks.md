# Tasks — trace view

> **Both backend dependencies have now landed, and the header that said otherwise is replaced.**
> It read: *"Two dependencies named in `proposal.md` do not exist in this repository, and they
> are the two the backend half of this change rests on."* That was true when written and stopped
> being true today.
>
> |                           |                                                                                     |
> | ------------------------- | ----------------------------------------------------------------------------------- |
> | the credential            | `add-pasted-token`, archived — the connect surface, the region table, the SW broker  |
> | `add-trace-layout-worker` | built — OTLP text in, positioned rows out, 12.2 ms off-thread for 4001 rows          |
> | `add-credential-broker`   | superseded for this change's purposes; still 4/32 for its own scope                  |
>
> So the query is no longer an injected boundary with no implementation: `src/trace/query.ts`
> issues `POST /api/trace/details` through the service worker and hands the response body to the
> layout worker as text. `panel/index.ts` passes it. The `unqueryable` state remains reachable
> and correct — it is what a selection resolves to with no token connected, which is a thing the
> developer can fix rather than a claim about the trace.
>
> **XState was measured and rejected.** Its minimal surface for this machine is 13.10 kB
> gzipped against 0.65 kB of stage-2 headroom at the time. The rationale is in the module header
> of `src/trace/traceMachine.ts`; the cancellation guarantee it was wanted for is enforced by a
> generation counter and asserted by tests instead.
>
> **The stage-2 budget was raised twice for this surface, and the second raise is what made the
> first one pay off.** The earlier note here recorded 13.73 kB against a 10.5 kB limit with the
> limit not raised; it has since gone to 23.07 kB against 23.5 kB, and `bench/budget.json`
> carries the reasoning for each step — including the admission, now discharged, that half of
> the first raise was "paying for a screen no user can currently reach".

## 1. traceMachine

- [x] 1.1 `src/trace/traceMachine.ts` — states `fetching`, `found`, `waiting`, `failed`, `exhausted`, plus `idle`, `none` and `unqueryable`
- [x] 1.2 The query is cancelled on state exit — by `exit()` aborting its `AbortController` and bumping a generation every continuation checks, not by an XState invoked actor (see 1.1's note above)
- [x] 1.3 404 → `waiting`; other errors → `failed`; success → `found`
- [x] 1.4 `waiting` → `fetching` after backoff; exponential, ceiling 5 attempts, then `exhausted`
- [x] 1.5 One machine per inspected request; selecting another aborts the previous query and cancels any scheduled retry
- [x] 1.6 Machine tests, no browser: ingest-lag path, click-away-mid-fetch, retry exhaustion, immediate success — `tests/unit/trace-machine.test.ts`, 20 tests

## 2. Query

- [x] 2.1 `POST /api/trace/details` with trace id and a tight `timeRange` — **done.** `src/trace/query.ts` issues it through the service-worker broker, which attaches the token and is the only thing that may; the broker's `query` gained an optional `method` and `body` for it. The endpoint is a *path* joined onto the origin the worker resolved from the connected region — the page never names a host. `timeRange` is converted to the ISO-8601 pair the API takes and is a required field upstream, so it cannot be dropped.
- [x] 2.2 Never omit `timeRange` — it is a required field of `TraceQueryRequest`, so an implementation cannot leave it out and still typecheck
- [x] 2.3 Request is abortable; abort on selection change and on panel close
- [x] 2.4 Response handed to the layout worker as text, never parsed on the main thread — **done**, now that `add-trace-layout-worker` has landed. The body exists on this thread only as the `string` argument to `flatten()`. Asserted negatively in `trace-query.test.ts`: a body of `<html>gateway timeout</html>` still reaches the worker and still resolves, because nothing here looks at it — a `JSON.parse` added to this path would throw and fail that test. Measured in Chromium at 0.10 ms of main-thread time for a 4001-row trace, 0 long tasks.
- [x] 2.5 Nothing is prefetched; opening the panel issues no query

## 3. State 7a — trace found

> Reachable only through an injected summary — nothing in shipped code produces one until the
> layout worker exists. Every item below is exercised against a fake in `trace-view.test.ts`.

- [x] 3.1 Sub-header: back button, `METHOD /path` ellipsized, trace id right-aligned in mono
- [x] 3.2 Meta row: span count, service count, log count, `timeRange ±2s`, and the worker-cost claim rendered **only** from a measured value — a `mainThreadMs` of `null` prints nothing
- [x] 3.3 Span rows `300px 1fr 56px`, windowed with the same virtualizer as the request list
- [x] 3.4 Indent from `depth * 14px`; 6px service swatch; root name in the intense colour
- [x] 3.5 Bars positioned from `--l` / `--w`, filled with the service colour
- [x] 3.6 Orphan, error and truncation flags rendered visibly
- [x] 3.7 Correlated-log footer: level, message ellipsized, `N correlated logs` link

## 4. State 7b — no span exists

- [x] 4.1 Centred column with a dashed warning ring, per handoff §7b — and `tests/perf/trace-view.spec.ts` now drives 4.2/4.4 in a real browser against the real ring, four rows on one fixture load resolving to four different causes
- [x] 4.2 Cause line taken from the coverage classification for untraced requests — **done**, now that `add-untraced-view` has landed. `inputFor` no longer derives a cause: it takes `collector/coverage.ts`'s `Cause` and the view prints the untraced tab's own `CAUSE_COPY`, so the two surfaces answer the same question about the same record through the same two functions. This file's three-way `NONE_COPY` is gone; only `TIER2_OFF_COPY` remains, because "tier 2 is off" is the absence of a classification rather than one of them. Two causes the old copy could not express — a subresource the browser issued, a third-party origin — used to render as "no traceparent", i.e. as an instrumentation failure. The handoff's _"Outside your PropagatorConfig.match list"_ is still not used, for the reason recorded in `copy.ts`.
- [x] 4.3 Degraded variant states that tier 2 is unavailable so no traceparent was ever seen
- [x] 4.4 `seen by the SW · never reached the backend` line where the worker observed it — and suppressed where tier 2 is off, since then no worker saw anything. **Tightened by 4.2**: the line is now printed only for `not-propagated`, which is *defined* as the worker holding a record with no traceparent on it. It was previously printed for every non-`tier-2-off` cause, including requests the worker never saw at all (`unseen`) — a claim about an observation that had not happened.

## 5. State 7c — waiting for ingest

- [x] 5.1 Three pulsing dots on `d0-pulse`, staggered 0 / .18s / .36s (the keyframes and `.lag-dot` shipped with `add-panel-shell`; the markup is added here)
- [x] 5.2 Live retry status: `retry N of 5 · next in Xs · backoff`, counting down at 10 Hz, and only while the surface is open
- [x] 5.3 Explanation line stating how long ago the request finished
- [x] 5.4 Never render a spinner that could be read as "missing" — the dots are hidden the moment the machine stops
- [x] 5.5 On `exhausted`, state that the trace did not become queryable and offer a manual retry

## 6. Navigation

- [x] 6.1 Back returns to the list with scroll position and active tab preserved — `popToList()`, against the offset `openRow` recorded on the way in
- [x] 6.2 Escape from the trace view goes back before closing — routed through the same `popToList()`.
      **This was broken on the first real-browser run and is fixed here.** Escape is bound on the
      panel element, never on the host's document, so it only fires while focus is inside the
      panel; pushing this surface hides the row that had focus, Chromium drops focus to `<body>`
      outside the shadow root, and Escape silently stopped popping. `traceView` now exposes
      `focus()` and the panel calls it on entry. Guarded by a unit test and by the Chromium
      assertion in `tests/perf/requests-view.spec.ts`, both run.
- [ ] 6.3 View Transitions between list and trace — **deliberately not done.** `document.startViewTransition` is document-scoped: it freezes and snapshots the _entire host page_, not the panel's shadow subtree. Paying a full-page snapshot on a customer's page to cross-fade a toolbar surface is the exact trade this project refuses. If it lands later it needs a scoped API, not this one.
