# observation-core

## ADDED Requirements

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

#### Scenario: Requests during load
- **WHEN** the host page issues requests before LCP is final
- **THEN** entries are recorded, and the toolbar's shadow root receives zero mutations until the
  settled phase begins

#### Scenario: LCP rendered from JavaScript
- **WHEN** the host application paints its largest element from JavaScript, well after the
  load event
- **THEN** the moratorium is still in force at that moment, because the load event is not a
  point at which the browser stops raising LCP

#### Scenario: A page that never stops painting
- **WHEN** LCP entries keep arriving indefinitely
- **THEN** the moratorium ends at a bounded ceiling, so the toolbar still appears

#### Scenario: Nothing lost by deferring
- **WHEN** the settled phase begins after the toolbar mounted late
- **THEN** every entry recorded from page start is present, because observers were registered
  with `buffered: true`

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
- **THEN** CI fails

#### Scenario: A later stage is reachable from stage 1
- **WHEN** stage-1 code gains a static import of panel, trace, auth or worker code
- **THEN** the build fails, because that import would pull the later stage into the
  load-phase bundle

### Requirement: Clean teardown
`destroy()` SHALL leave no observer, listener, node, or timer belonging to the toolbar.

#### Scenario: Teardown after use
- **WHEN** `destroy()` is called after the toolbar has been running
- **THEN** every observer is disconnected, every listener removed, and the host document is
  unchanged in style and structure from before `init()`
