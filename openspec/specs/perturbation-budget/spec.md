# perturbation-budget Specification

## Purpose
TBD - created by archiving change add-perturbation-budget. Update Purpose after archive.
## Requirements
### Requirement: The toolbar's own cost is measured, not asserted
The observer effect SHALL be measured by comparing the same page with the toolbar enabled and
disabled, and the comparison SHALL run in CI on every change.

#### Scenario: Enabled vs disabled
- **WHEN** the hostile fixture is loaded n ≥ 20 times in each arm under identical throttling
- **THEN** p95 deltas for INP, LCP, CLS and TBT are computed and compared against committed
  thresholds, and CI fails if any threshold is exceeded

#### Scenario: A regression is introduced
- **WHEN** a change pushes Δp95 INP above 2 ms
- **THEN** CI fails and names the regressed metric and its magnitude

### Requirement: Globals are provably untouched
CI SHALL assert that the toolbar leaves host globals identical to a pristine realm.

#### Scenario: fetch and XHR identity
- **WHEN** the toolbar is enabled and has been running
- **THEN** `fetch`, `XMLHttpRequest.prototype.open` and `XMLHttpRequest.prototype.send` are
  strictly identical to a pristine iframe's, by reference and by source text

### Requirement: The host page's styles and layout are untouched
CI SHALL assert the toolbar contributes no rule to the host document and induces no host
layout work.

#### Scenario: Panel opened and driven
- **WHEN** the panel is opened, tabs switched, and a trace view entered
- **THEN** the host document's stylesheet count and rule count are unchanged, and no host
  element is layout-invalidated

### Requirement: Deterministic fixtures
Performance fixtures SHALL be deterministic, so a measured delta reflects a code change rather
than fixture variance.

#### Scenario: Repeated runs of the same commit
- **WHEN** the harness runs twice on an unchanged commit
- **THEN** reported p95 deltas agree within the thresholds' noise allowance

