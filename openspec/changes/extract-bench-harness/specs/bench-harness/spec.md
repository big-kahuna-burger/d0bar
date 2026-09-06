# bench-harness

## ADDED Requirements

### Requirement: Every declared budget row is enforced
The budget file SHALL be the single source of the thresholds that gate, and a declared row that
no measurement checks SHALL fail the suite rather than pass unnoticed.

#### Scenario: A row nothing measures
- **WHEN** the budget file declares a row that no test claims
- **THEN** the suite fails and names the unclaimed row

#### Scenario: A measurement with no row
- **WHEN** a test claims a budget row that the budget file does not declare
- **THEN** the suite fails rather than defaulting to a threshold of its own

#### Scenario: A threshold is edited
- **WHEN** a threshold in the budget file is changed
- **THEN** the gate applied by the measurement changes with it, with no second copy of the
  number anywhere in the test suite

### Requirement: A measured value is recorded, not only asserted
Every measurement SHALL write its observed value into the run report, whether it passed or
failed.

#### Scenario: A budget passes
- **WHEN** a measurement is under its threshold
- **THEN** the observed value is recorded in the run report, so the next threshold decision has
  a number to start from rather than only the knowledge that it passed

### Requirement: A measurement states its instrument and its blind spots
A recorded measurement SHALL name what produced it and what it does not cover.

#### Scenario: Attributed main-thread time is recorded
- **WHEN** per-task time attributed to a script is recorded against a budget row
- **THEN** the record names the instrument, and states that work the browser attributes to no
  script — style recalculation and layout provoked by that script — is not included

### Requirement: Attribution reports the script's own share, not the frame's
Main-thread measurement SHALL report the time attributable to a named script within each
top-level task, and SHALL NOT report the whole task as that script's cost.

#### Scenario: Another script runs in the same frame
- **WHEN** the measured script and an unrelated script both run within one task
- **THEN** only the measured script's own entries are counted toward its per-frame figure

#### Scenario: The script calls itself
- **WHEN** a measured script's function calls another function in the same script
- **THEN** the nested entry is not counted a second time

#### Scenario: Nothing was attributed
- **WHEN** a measurement window attributes no time at all to the named script
- **THEN** the measurement fails as uninstrumented rather than passing as zero cost

### Requirement: The trace reduction is testable without a browser
The reduction from raw trace events to per-task attributed time SHALL be a pure function that
can be exercised directly.

#### Scenario: Reduction over recorded events
- **WHEN** the reduction is given a fixed list of trace events
- **THEN** it returns the per-task totals for those events with no browser and no tracer

### Requirement: The harness never ships
The harness SHALL be a development dependency and SHALL NOT appear in any shipped artifact.

#### Scenario: A shipped bundle is built
- **WHEN** the toolbar's bundles are built
- **THEN** none of them contains any of the harness's code
