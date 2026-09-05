# Tasks — trace view

## 1. traceMachine
- [ ] 1.1 `src/trace/traceMachine.ts` — states `fetching`, `found`, `waiting`, `failed`, `exhausted`
- [ ] 1.2 Query as an invoked actor, so it is cancelled automatically on state exit
- [ ] 1.3 404 → `waiting`; other errors → `failed`; success → `found`
- [ ] 1.4 `waiting` → `fetching` after backoff; exponential, ceiling 5 attempts, then `exhausted`
- [ ] 1.5 Actor spawned per inspected request; selecting another request stops the previous actor
- [ ] 1.6 Machine tests, no browser: ingest-lag path, click-away-mid-fetch, retry exhaustion, immediate success

## 2. Query
- [ ] 2.1 `POST /api/trace/details` with trace id and a tight `timeRange` (±2s around the recorded request timestamp)
- [ ] 2.2 Never omit `timeRange` — the API falls back to a full table scan without it
- [ ] 2.3 Request is abortable; abort on selection change and on panel close
- [ ] 2.4 Response handed straight to the layout worker as text — never parsed on the main thread
- [ ] 2.5 Nothing is prefetched; opening the panel issues no query

## 3. State 7a — trace found
- [ ] 3.1 Sub-header: back button, `METHOD /path` ellipsized, trace id right-aligned in mono
- [ ] 3.2 Meta row: span count, service count, log count, `timeRange ±2s`, and the worker-cost claim rendered from the measured value
- [ ] 3.3 Span rows `300px 1fr 56px`, windowed with the same virtualizer as the request list
- [ ] 3.4 Indent from `depth * 14px`; 6px service swatch; root name in the intense colour
- [ ] 3.5 Bars positioned from `--l` / `--w`, filled with the service colour
- [ ] 3.6 Orphan, error and truncation flags rendered visibly
- [ ] 3.7 Correlated-log footer: level, message ellipsized, `N correlated logs` link

## 4. State 7b — no span exists
- [ ] 4.1 Centred column with a dashed warning ring, per handoff §7b
- [ ] 4.2 Cause line taken from the coverage classification for untraced requests
- [ ] 4.3 Degraded variant states that tier 2 is unavailable so no traceparent was ever seen
- [ ] 4.4 `seen by the SW · never reached the backend` line where the worker observed it

## 5. State 7c — waiting for ingest
- [ ] 5.1 Three pulsing dots on `d0-pulse`, staggered 0 / .18s / .36s
- [ ] 5.2 Live retry status: `retry N of 5 · next in Xs · backoff`, counting down
- [ ] 5.3 Explanation line stating how long ago the request finished
- [ ] 5.4 Never render a spinner that could be read as "missing"
- [ ] 5.5 On `exhausted`, state that the trace did not become queryable and offer a manual retry

## 6. Navigation
- [ ] 6.1 Back returns to the list with scroll position and active tab preserved
- [ ] 6.2 Escape from the trace view goes back before closing
- [ ] 6.3 View Transitions between list and trace, progressively enhanced, skipped under reduced motion
