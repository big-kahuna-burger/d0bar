# otel-adoption

## ADDED Requirements

### Requirement: The SDK is adopted, never installed
d0bar SHALL NOT create, register, or bundle an OpenTelemetry SDK, and SHALL NOT patch any host
global in order to obtain spans.

#### Scenario: No SDK is present
- **WHEN** a page has no OpenTelemetry API registered
- **THEN** tier 4 reports itself off with the reason that no SDK is present, and no global is
  patched, wrapped, or replaced

#### Scenario: The dependency cannot reach a bundle
- **WHEN** the shipped artifacts are inspected
- **THEN** no OpenTelemetry package appears in any of them, and the API is reached only through
  a global the host registered

### Requirement: Detection is a feature test
Detection SHALL read the versioned API global and validate its shape, and SHALL treat an
unrecognised version as absent.

#### Scenario: An unrecognised API version
- **WHEN** the registered API global carries a version d0bar does not recognise
- **THEN** tier 4 reports itself off rather than reading the object on the assumption that its
  shape is compatible

### Requirement: The span sink only reads
The attached span processor SHALL NOT export, sample, mutate, or delay any span, and SHALL NOT
retain a span object after the callback returns.

#### Scenario: A span ends
- **WHEN** the host's SDK ends a client span
- **THEN** d0bar copies its identity, timing and URL attribute into a bounded ring, retains no
  reference to the span, and returns without altering it

#### Scenario: The host flushes
- **WHEN** the host's provider is flushed or shut down
- **THEN** d0bar's sink resolves immediately and the host's own export is unaffected

### Requirement: A provider that cannot be extended is reported, not worked around
Where the host's provider does not accept a processor after construction, d0bar SHALL report
tier 4 as unavailable with that reason, and SHALL offer an explicit processor the host can
install themselves.

#### Scenario: A sealed provider
- **WHEN** the registered provider offers no supported way to attach a processor
- **THEN** tier 4 reports itself off with the sealed-provider reason, and d0bar does not
  monkey-patch the provider, its prototype, or its tracers to attach one anyway

#### Scenario: The host installs the processor
- **WHEN** the host passes d0bar's exported span processor to their own provider
- **THEN** tier 4 becomes live with the host named as its owner

### Requirement: A span with no URL is not guessed at
Spans SHALL be joined on a URL attribute read from the span, and a span carrying none SHALL
NOT be matched by any other means.

#### Scenario: A span without a URL attribute
- **WHEN** an ended span carries neither `url.full` nor `http.url`
- **THEN** the span is counted as unjoinable and discarded, and its name is not parsed to infer
  a URL

### Requirement: Tier 1 remains authoritative for timings
Adopted spans SHALL supply trace identity only, and SHALL NOT overwrite any timing, size or
status field recorded from a resource entry.

#### Scenario: A span disagrees with the resource entry
- **WHEN** an adopted span reports a duration different from the resource entry it joins to
- **THEN** the displayed timings remain the browser's, and the span supplies only the trace and
  span identity

#### Scenario: Tier 2 and tier 4 disagree
- **WHEN** a worker-observed `traceparent` and an adopted span name different traces for one
  request
- **THEN** the conflict is recorded and surfaced rather than resolved silently in favour of
  either tier

### Requirement: Adoption happens after the load phase
Provider detection and processor attachment SHALL NOT occur before the load phase has settled.

#### Scenario: A page is still loading
- **WHEN** the host page's LCP is not yet final
- **THEN** no detection, attachment or span reading has taken place
