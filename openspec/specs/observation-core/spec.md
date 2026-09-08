# observation-core Specification

## Purpose
TBD - created by archiving change add-observation-core. Update Purpose after archive.
## Requirements
### Requirement: Explicit opt-in gate
The package SHALL be inert until `init()` is called with an explicit enable, and SHALL make no
observation, no DOM change, no network request, and no storage write while inert.

#### Scenario: Imported but not enabled
- **WHEN** the module is imported and `init()` is not called
- **THEN** no `PerformanceObserver` is constructed, no node is added to the host document, no
  request is issued, and `fetch` is strictly identical to a pristine realm's `fetch`

### Requirement: Allocation-free entry capture
Capturing one browser performance entry SHALL write only into preallocated typed arrays and
SHALL NOT allocate a per-entry object or retain the browser's entry.

#### Scenario: Burst of resource entries
- **WHEN** 300 `resource` entries are delivered in one callback
- **THEN** every entry is recorded, and no per-entry object is retained after the callback returns

### Requirement: Load-phase moratorium
While the page is still in its load phase, the system SHALL perform no work beyond recording
entries — specifically no derivation, no DOM write, no worker message, and no network request.

Every operation the moratorium forbids SHALL announce itself to the guard before performing the
work, so that a violation fails in development rather than costing a host main-thread time in
production. The guard SHALL be exercised by at least one test arm that runs with it enabled.

#### Scenario: Requests during load
- **WHEN** the host page issues requests before LCP is final
- **THEN** entries are recorded, and the toolbar's shadow root receives zero mutations until the
  settled phase begins

#### Scenario: A forbidden operation is added outside the deferral
- **WHEN** code that writes DOM, posts to a worker, fetches, or derives is reached during the
  load phase
- **THEN** it fails loudly in development, rather than depending on its caller having been
  written inside the deferral

#### Scenario: The guard is compiled out
- **WHEN** the perturbation suite measures a production build, where the guard is absent
- **THEN** at least one arm exercises a build in which the guard is present, so the guard is
  never a claim that no test has run

#### Scenario: LCP rendered from JavaScript
- **WHEN** the host application paints its largest element from JavaScript, well after the
  load event
- **THEN** the toolbar does not change the LCP the page reports, and it mounts no earlier than
  every candidate the browser had produced at that moment

  The previous wording — "the moratorium is still in force at that moment" — is not a property
  any implementation can hold, and measuring it is what showed that. LCP is final only at first
  input or at hidden; on a page nobody touches, a larger paint may arrive at any time. The
  fixture paints its hero from an 800 ms-delayed fetch and reports LCP at ~1.58 s while the
  toolbar settles at ~0.60 s, and the toolbar cannot know at 0.60 s that 1.58 s is coming. What
  it can hold is that its presence does not move the number: five runs per arm gave
  `on` [1588, 1580, 1580, 1564, 1568] ms against `gated` [1560, 1560, 1568, 1564, 1580] ms.

#### Scenario: A page that never stops painting
- **WHEN** LCP entries keep arriving indefinitely
- **THEN** the moratorium ends at a bounded ceiling, so the toolbar still appears

#### Scenario: The page interacts before it has loaded
- **WHEN** a user interacts while the host page is still loading
- **THEN** LCP is final and the moratorium may lift, but the toolbar issues no network request
  of its own until the page has loaded — a prefetch justified by not competing with the host's
  critical requests SHALL NOT compete with them

#### Scenario: Nothing lost by deferring
- **WHEN** the settled phase begins after the toolbar mounted late
- **THEN** every entry recorded from page start is present, because observers were registered
  with `buffered: true`

#### Scenario: The moratorium is asserted against a real signal
- **WHEN** the suite asserts that the toolbar mounted after the page's LCP candidates
- **THEN** the LCP it compares against is one the page actually reported, and the assertion
  fails if that value is unavailable rather than passing against a default

#### Scenario: A guard the suite cannot make fail
- **WHEN** a test asserts that a load-phase side effect did not happen
- **THEN** it has been observed failing with the deferral it guards removed, and where the
  fixture's own load window is too short to observe the violation, the fixture provides a
  longer one rather than the test being kept as a passing tautology

### Requirement: Bounded storage with visible loss
The entry ring SHALL have fixed capacity, SHALL overwrite oldest on overflow, and SHALL expose
a dropped count that the UI surfaces.

#### Scenario: Ring overflows
- **WHEN** more entries arrive than the ring's capacity
- **THEN** the oldest are overwritten, the dropped count increments, and the UI reports that
  entries were dropped rather than presenting the list as complete

### Requirement: Unsupported fields are declared, not guessed
Where a browser does not expose a field the UI shows, the system SHALL flag it as unknown and
the UI SHALL render it as unknown.

#### Scenario: responseStatus unsupported
- **WHEN** `PerformanceResourceTiming.responseStatus` is unavailable
- **THEN** the status is flagged unknown and rendered unlabelled, never inferred

### Requirement: Coalesced ambient updates
Pill updates SHALL be coalesced to at most one per 500 ms, and SHALL be suppressed while the
document is hidden or the load phase is active.

#### Scenario: Hidden tab
- **WHEN** `visibilityState` is `hidden`
- **THEN** no pill DOM write occurs

### Requirement: Critical-path budget
The stage-1 bundle SHALL be measured on every build against a committed threshold, and SHALL
NOT statically import stage-2 or stage-3 code.

#### Scenario: Budget exceeded
- **WHEN** a build pushes stage 1 over the threshold recorded in `bench/budget.json`
- **THEN** the build fails, and it does so in an automated check that runs on every change
  rather than only where a contributor chooses to run it

#### Scenario: A later stage is reachable from stage 1
- **WHEN** stage-1 code gains a static import of panel, trace, auth or worker code
- **THEN** the build fails, because that import would pull the later stage into the
  load-phase bundle

### Requirement: Clean teardown
`destroy()` SHALL leave no observer, listener, node, or timer belonging to the toolbar, and
SHALL restore the toolbar's own accumulated state so that a subsequent `init()` measures the
page rather than the page plus its own history.

#### Scenario: Teardown after use
- **WHEN** `destroy()` is called after the toolbar has been running
- **THEN** every observer is disconnected, every listener removed, and the host document is
  unchanged in style and structure from before `init()`

#### Scenario: Re-initialised after teardown
- **WHEN** `init()` is called after `destroy()`
- **THEN** no entry is counted twice, despite observers re-registering with `buffered: true`
  and the browser re-delivering every buffered entry

#### Scenario: Initialised while already running
- **WHEN** `init()` is called with a configuration differing from the running one
- **THEN** the difference is not silently discarded

### Requirement: No host event listeners
The toolbar SHALL register no event listener on `window`, `document`, or any host element for
lifecycle observation, taking load and visibility signals from performance entry types instead.

#### Scenario: Load phase completes
- **WHEN** the document finishes loading
- **THEN** the load signal is taken from a `navigation` entry whose `loadEventEnd` is greater
  than zero, and no `load` listener has been registered

#### Scenario: Navigation entry delivered incomplete
- **WHEN** a `navigation` entry is delivered with `loadEventEnd` equal to zero
- **THEN** it is ignored and the later delivery carrying a non-zero `loadEventEnd` is used

#### Scenario: Page hidden before settle
- **WHEN** the page becomes hidden during the load phase
- **THEN** the state is observed via the `visibility-state` entry type and no `visibilitychange`
  listener has been registered

#### Scenario: Entry type unavailable
- **WHEN** `visibility-state` is not supported
- **THEN** the toolbar reads `document.visibilityState` once at start rather than registering a
  listener, and treats the state as unknown thereafter

#### Scenario: Listener count asserted
- **WHEN** the non-perturbation suite runs
- **THEN** it asserts zero toolbar-registered listeners on `window` and `document`

### Requirement: Cache status is reported, not inferred, where the platform supplies it
Where `PerformanceResourceTiming.deliveryType` is available it SHALL be the cache signal. The
transfer-size heuristic SHALL be used only where it is absent, and a value obtained that way
SHALL be distinguishable from a reported one.

#### Scenario: deliveryType available
- **WHEN** a resource entry exposes `deliveryType`
- **THEN** the cached flag reflects that value and the heuristic is not consulted

#### Scenario: deliveryType absent
- **WHEN** the property is unavailable on this browser
- **THEN** the heuristic supplies the flag and the record is marked as inferred

#### Scenario: Inferred value displayed
- **WHEN** a row's cache status was inferred
- **THEN** the UI does not present it with the same confidence as a reported one

### Requirement: The fixture exercises a cache hit
The benchmark fixture SHALL serve at least one cacheable subresource requested twice, so that
cache-status handling is measured against a real cache hit.

#### Scenario: Second request for a cacheable asset
- **WHEN** the fixture requests a `max-age` asset a second time
- **THEN** a resource entry with a non-network `deliveryType` is produced and asserted against

### Requirement: The toolbar's own main-thread cost is attributed, not inferred
The perturbation budget SHALL gate the main-thread time attributable to the toolbar's own
scripts, at a resolution finer than the platform's long-task threshold.

#### Scenario: A cost below the long-task floor
- **WHEN** the toolbar spends tens of milliseconds on the main thread, without producing a
  long task
- **THEN** the budget fails, rather than passing because the fixture's own deliberate blocking
  dominates every aggregate the suite compares

#### Scenario: Aggregating across runs
- **WHEN** a continuous metric is compared between the enabled and disabled arms across many
  runs
- **THEN** it is compared at a high percentile, because a toolbar that is usually free and
  occasionally expensive is not free

#### Scenario: A metric coarser than the threshold it gates
- **WHEN** a budget row gates on a value the platform reports in quanta, or on an integer count
  aggregated at an order statistic
- **THEN** the row compares something the instrument can actually resolve — a direction, a rate,
  or a count of regressions — rather than a difference smaller than one step of the underlying
  metric, which can only ever report zero or a full step
