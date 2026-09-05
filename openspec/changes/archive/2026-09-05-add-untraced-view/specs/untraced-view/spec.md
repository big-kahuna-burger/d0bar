# untraced-view

## ADDED Requirements

### Requirement: Causes are distinguished, never lumped
Each untraced request SHALL be attributed to a specific cause, and requests with different
causes SHALL NOT be presented under one label.

Every cause SHALL be an observation the toolbar can make. The toolbar does not read the host's
SDK configuration, so no cause may name one. (This requirement replaces an earlier scenario
that attributed a gap to "the configured propagator match list": it was corrected here rather
than worked around in code, because the copy it called for would have been a plausible
explanation presented as a finding.)

#### Scenario: An XHR request
- **WHEN** an untraced request used `XMLHttpRequest`
- **THEN** the cause states that the SDK instruments fetch only, so no traceparent was attached

#### Scenario: A fetch the worker watched go out bare
- **WHEN** the service worker read an untraced same-origin request's headers and found no
  `traceparent`
- **THEN** the cause states that the header was absent, distinctly from the transport case, and
  does not assert why it was absent

#### Scenario: A request issued before the worker took control
- **WHEN** an untraced same-origin request has no service worker record at all
- **THEN** the cause distinguishes it from a request the worker saw and found bare

#### Scenario: A request the browser issued itself
- **WHEN** an untraced request's `initiatorType` is a markup subresource — script, css, img,
  link, font
- **THEN** the cause states that no application code issued it, and the card SHALL NOT present
  it as an instrumentation gap to close

#### Scenario: A cross-origin request
- **WHEN** an untraced request's origin is not the page's, and that origin is not opaque
- **THEN** the cause states it is third party

#### Scenario: Cause cannot be established
- **WHEN** no cause can be determined, including a URL whose origin is opaque
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
