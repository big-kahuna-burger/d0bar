## MODIFIED Requirements

### Requirement: Three outcomes are never conflated
Opening a request SHALL resolve to exactly one of trace found, trace not yet queryable, or no
span exists, each with its own distinct presentation.

#### Scenario: Trace returned
- **WHEN** the query returns a trace
- **THEN** the waterfall renders with span, service and log counts
- **AND** the log count is reachable rather than terminal text, per the `correlated-logs`
  capability

#### Scenario: Not yet ingested
- **WHEN** the query returns not-found for a request that carried a trace id
- **THEN** the panel states the trace is not queryable yet, shows the retry count and the time
  until the next attempt, and does not suggest the trace is missing

#### Scenario: Never instrumented
- **WHEN** the request carried no trace id
- **THEN** the panel states that no span exists and gives the specific cause
