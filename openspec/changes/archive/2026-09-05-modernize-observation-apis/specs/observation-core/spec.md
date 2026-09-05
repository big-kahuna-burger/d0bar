# observation-core

## ADDED Requirements

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
