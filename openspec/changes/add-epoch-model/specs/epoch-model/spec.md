# epoch-model

## ADDED Requirements

### Requirement: The browser's navigation id is the epoch id
Where the platform stamps `navigationId` on performance entries, the toolbar SHALL use that
value as the epoch identifier and SHALL NOT compute an epoch from entry timestamps.

#### Scenario: Resource fetched after a soft navigation
- **WHEN** a resource entry carries the same `navigationId` as a preceding `soft-navigation` entry
- **THEN** the request is attributed to that epoch

#### Scenario: Interaction that caused the navigation
- **WHEN** the `event` entry for the click that triggered a soft navigation carries the previous
  `navigationId`, despite a `startTime` equal to the soft navigation's
- **THEN** the interaction is attributed to the previous epoch

#### Scenario: Entry buffered from before mount
- **WHEN** a buffered entry predating the toolbar's mount carries a `navigationId`
- **THEN** it is attributed to that epoch rather than to a catch-all

### Requirement: Three-tier epoch source with honest degradation
The toolbar SHALL select an epoch source once at start — `soft-navigation` entries, else the
Navigation API, else a single document-lifetime epoch — and SHALL report which tier is in use.

#### Scenario: Soft navigation supported
- **WHEN** `soft-navigation` is in `PerformanceObserver.supportedEntryTypes`
- **THEN** tier 1 is selected and epoch ids are the browser's `navigationId` values

#### Scenario: Navigation API only
- **WHEN** `soft-navigation` is unsupported but `navigation` exists
- **THEN** tier 2 is selected, epoch ids are assigned from a counter starting at 1, and entries
  observed before the first boundary are attributed to epoch 0

#### Scenario: Neither available
- **WHEN** neither is available
- **THEN** every entry belongs to epoch 0 and the UI states that route boundaries are
  unavailable on this browser

#### Scenario: Tiers are never mixed
- **WHEN** an epoch source has been selected
- **THEN** no epoch id from another tier is assigned for the lifetime of the document

### Requirement: Epoch detection adds nothing to the host page
Epoch detection SHALL be observation-only and SHALL NOT patch, wrap, or replace any host API,
including `history` and its methods.

#### Scenario: Router calls pushState directly
- **WHEN** the host calls `history.pushState` with no framework involved
- **THEN** the boundary is detected via `currententrychange` and `history.pushState` is
  strictly equal to its original value

#### Scenario: Non-perturbation suite runs
- **WHEN** `tests/perf/non-perturbation.spec.ts` executes with epochs enabled
- **THEN** it passes unchanged

### Requirement: replace is not a boundary
A same-document navigation whose type is `replace` SHALL update the current epoch's URL rather
than open a new epoch. `push` and `traverse` SHALL open one.

#### Scenario: Query string edited in place
- **WHEN** the host calls `history.replaceState` to amend a query parameter
- **THEN** no new epoch is created and the current epoch's recorded URL is updated

#### Scenario: Back navigation
- **WHEN** the user navigates back and `navigationType` is `traverse`
- **THEN** a new epoch is opened

### Requirement: The epoch registry is bounded and label-only
The registry SHALL hold at most 32 epochs, dropping oldest first, and SHALL be read only to
label an epoch — never to determine which epoch an entry belongs to.

#### Scenario: Long-lived session
- **WHEN** a session passes 32 route changes
- **THEN** memory held by the registry does not grow and the oldest entries are dropped

#### Scenario: Record whose epoch has been dropped
- **WHEN** a stored record references an epoch no longer in the registry
- **THEN** the record remains correctly grouped and is labelled with its raw epoch id

### Requirement: Views scope to the active epoch
Each view SHALL scope to the active epoch by default and SHALL offer an explicit control to
widen to the whole document.

#### Scenario: Route change while the panel is open
- **WHEN** a new epoch opens with the requests view visible
- **THEN** the view scopes to the new epoch and discloses how many records the previous epoch held

#### Scenario: Widened to document
- **WHEN** the user widens the scope
- **THEN** records from every retained epoch are shown, grouped by epoch

### Requirement: Epoch capture stays allocation-free
Recording an entry's epoch SHALL not allocate and SHALL not extend the load-phase moratorium.

#### Scenario: Load-phase request burst
- **WHEN** 300 resource entries are delivered during the load phase
- **THEN** no object is allocated per entry for epoch purposes and the A/B budget remains within
  its committed thresholds
