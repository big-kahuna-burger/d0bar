# request-correlation

## Purpose

Correlates the requests a page makes with the traces they belong to, by reading request headers
from inside a service worker instead of patching `fetch` or `XMLHttpRequest`. It exists because
the trace id travels in a header the page's own JavaScript cannot see without intercepting the
call that carries it — and intercepting it would change the thing being measured. Where no
worker scope is available the capability turns itself off and says so, because a correlation the
toolbar cannot honestly make is better named than faked.

## ADDED Requirements

### Requirement: Observation without interception
The service worker SHALL NOT call `respondWith` for any request, and SHALL NOT alter latency,
caching semantics, or response content.

#### Scenario: A request passes through
- **WHEN** the host page issues a request while the worker is active
- **THEN** the worker records the request's headers and returns without responding, and the
  browser services the request natively

#### Scenario: Worker overhead bounded
- **WHEN** resource timings are read for an observed request
- **THEN** the gap between `workerStart` and `fetchStart` stays within a committed budget,
  asserted at p95, and the time it represents is carried in the request's bar rather than
  dropped from it

#### Scenario: The worker's own cost is isolated
- **WHEN** the same page is loaded with the worker registered and with it absent, everything
  else held identical
- **THEN** the difference in request latency stays within a committed budget, so the cost of
  registering the worker is a measured number and not an assumption

> Corrected against the platform. This scenario previously read "`workerStart` shows no
> worker-attributable delay", which was written as though `workerStart` were zero for a
> pass-through worker. It is not: the field marks when service-worker handling *began*, and
> it is stamped on every request once a worker controls the page, whether or not the handler
> calls `respondWith`. A zero assertion could only pass on a page with no worker, which
> proves nothing about one that has a worker. Measured over 250 requests: p50 0.5ms, p95
> 3.4ms, max 3.6ms.
>
> Corrected a second time, on the wording rather than the platform. The scenario also
> required the overhead to be "disclosed in the UI rather than omitted", and that was not
> true: the time is folded into the waterfall's `lead` segment along with redirects and
> queueing, and `geometry.ts` declines to give it a colour of its own because the record
> carries no breakdown of it. So the time is *not dropped* — it occupies the bar and the
> measured phases start where they really started — but it is not attributed to the worker,
> and no user could learn from the panel that the worker costs anything. Attributing it would
> mean carrying a fourth number across the stage boundary for a p95 of 3.4ms, which is not a
> trade this design wants to make silently. The scenario now says what is true, and the
> second scenario below carries the claim that actually matters: what registering the worker
> costs, measured against not registering it.

### Requirement: Globals remain unpatched
Correlation SHALL be achieved without modifying `fetch`, `XMLHttpRequest`, or any other host
global.

#### Scenario: Correlation active
- **WHEN** trace correlation is working
- **THEN** `fetch` and `XMLHttpRequest` are strictly identical to a pristine realm's

### Requirement: Each tier stays authoritative for what it measures best
The join SHALL take timings and status from Tier 1 and request headers from Tier 2, and neither
source SHALL overwrite the other's fields.

#### Scenario: Both sources present
- **WHEN** a resource entry and a fetch-event record describe the same request
- **THEN** the joined record carries Tier 1's timings and status and Tier 2's trace id

#### Scenario: Ambiguous join
- **WHEN** two identical URLs are issued concurrently and cannot be ordered with confidence
- **THEN** the record is flagged low-confidence and its trace id is not presented as certain

### Requirement: Requests Tier 1 never saw are retained
Fetch-event records with no matching resource entry SHALL be retained and surfaced.

#### Scenario: An un-instrumented request
- **WHEN** the worker observes a request that produces no resource entry the page can read
- **THEN** the request is still listed, marked as seen only by the worker

### Requirement: The log survives reload
The request log SHALL persist across page reloads and SHALL be bounded in size and age.

#### Scenario: Reload after an error
- **WHEN** a request fails and the page is reloaded
- **THEN** the failed request is still present in the log

#### Scenario: Storage quota exhausted
- **WHEN** IndexedDB rejects a write
- **THEN** logging stops, the UI reports logging as degraded, and no error propagates into a
  fetch handler

### Requirement: Honest degradation when the scope is unavailable
Where a service worker scope cannot be obtained, the toolbar SHALL run Tier 1 only, SHALL label
itself degraded, and SHALL state what is missing.

#### Scenario: Host owns the scope and will not import
- **WHEN** the host has its own service worker and does not import d0bar's module
- **THEN** tier 2 shows as off, trace jump is disabled, every request resolves to the no-span
  state, and no global is patched as a substitute

### Requirement: Correlation work stays off the critical path
Registration and joining SHALL occur only after the load phase has settled.

#### Scenario: Load phase
- **WHEN** the page is still loading
- **THEN** no worker registration and no join work occurs
