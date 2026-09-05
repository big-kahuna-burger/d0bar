# untraced-view

## ADDED Requirements

### Requirement: Causes are distinguished, never lumped
Each untraced request SHALL be attributed to a specific cause, and requests with different
causes SHALL NOT be presented under one label.

#### Scenario: An XHR request
- **WHEN** an untraced request used `XMLHttpRequest`
- **THEN** the cause states that the SDK instruments fetch only, so no traceparent was attached

#### Scenario: A deliberately excluded fetch
- **WHEN** an untraced fetch's URL falls outside the configured propagator match list
- **THEN** the cause states it was deliberately not propagated, distinctly from the transport case

#### Scenario: Cause cannot be established
- **WHEN** no cause can be determined
- **THEN** the card states the cause is unknown rather than asserting one

### Requirement: Coverage requires tier 2, and says so
Where tier 2 is unavailable, the toolbar SHALL state that coverage cannot be determined.

#### Scenario: Tier 2 off
- **WHEN** the service worker is unavailable
- **THEN** the tab explains that coverage is unknown without tier 2, and does not display zero
  gaps as though coverage were complete

### Requirement: One source for the untraced count
The count shown on the pill, the tab badge and the tab body SHALL come from one derivation.

#### Scenario: Requests stream in
- **WHEN** new untraced requests are recorded
- **THEN** pill badge, tab badge and headline all update together and agree

#### Scenario: No gaps
- **WHEN** every request on the page produced a span
- **THEN** both badges are hidden, the tab remains present, and the body states that coverage
  is complete
