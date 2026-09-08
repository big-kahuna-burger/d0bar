## ADDED Requirements

### Requirement: The query names the connected dataset, resolved per call
Every trace query SHALL send the dataset of the currently connected credential, read at the
moment the query is issued rather than captured when the query function was built — the same rule
the API origin already follows, and for the same reason: a credential can be replaced while the
panel is open.

#### Scenario: A trace query is issued
- **WHEN** the toolbar queries for a trace
- **THEN** the request body names the connected dataset

#### Scenario: The credential changes with the panel open
- **WHEN** the user reconnects to a different dataset and then opens a request
- **THEN** the query names the new dataset

## MODIFIED Requirements

### Requirement: Three outcomes are never conflated
Opening a request SHALL resolve to exactly one of trace found, trace not yet queryable, or no
span exists, each with its own distinct presentation. Where a single API response has more than
one possible cause, the panel SHALL name the causes rather than choosing one.

#### Scenario: Trace returned
- **WHEN** the query returns a trace
- **THEN** the waterfall renders with span, service and log counts

#### Scenario: Not yet ingested
- **WHEN** the query returns not-found for a request that carried a trace id
- **THEN** the panel states the trace is not queryable yet, shows the retry count and the time
  until the next attempt, and does not suggest the trace is missing

#### Scenario: Never instrumented
- **WHEN** the request carried no trace id
- **THEN** the panel states that no span exists and gives the specific cause

### Requirement: Retries are bounded and visible
Retries SHALL use exponential backoff with a fixed ceiling, and the current attempt SHALL be
visible. Because the retried status has two causes — not yet ingested, and not in this dataset —
the exhausted state SHALL NOT attribute itself to either one alone.

#### Scenario: Retry ceiling reached
- **WHEN** the retry ceiling is reached without the trace becoming queryable
- **THEN** the panel says so and offers a manual retry, rather than retrying indefinitely

#### Scenario: The exhausted state names both causes
- **WHEN** the retry ceiling is reached
- **THEN** the panel states that the trace was not found in the connected dataset, names the
  dataset it queried, and does not assert ingest lag as the cause
