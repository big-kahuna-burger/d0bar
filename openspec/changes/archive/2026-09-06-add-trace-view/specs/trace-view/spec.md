# trace-view

## ADDED Requirements

### Requirement: Three outcomes are never conflated
Opening a request SHALL resolve to exactly one of trace found, trace not yet queryable, or no
span exists, each with its own distinct presentation.

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

### Requirement: In-flight queries cannot outlive their selection
A query SHALL be aborted when the user selects another request or closes the panel.

#### Scenario: Clicking away mid-fetch
- **WHEN** a query is in flight and the user selects a different request
- **THEN** the first query is aborted and its response can never populate the panel

### Requirement: Retries are bounded and visible
Retries SHALL use exponential backoff with a fixed ceiling, and the current attempt SHALL be
visible.

#### Scenario: Retry ceiling reached
- **WHEN** the retry ceiling is reached without the trace becoming queryable
- **THEN** the panel says so and offers a manual retry, rather than retrying indefinitely

### Requirement: Every query is time-bounded
Trace queries SHALL include a tight time range derived from the recorded request timestamp.

#### Scenario: A trace query is issued
- **WHEN** the toolbar queries for a trace
- **THEN** the request carries a bounded time range around the request's own timestamp, and the
  bound is displayed in the meta row

### Requirement: Nothing is fetched until asked
Opening the panel SHALL issue no trace query.

#### Scenario: Panel opened
- **WHEN** the panel is opened and no request is selected
- **THEN** no network request is made

### Requirement: Response parsing stays off the main thread
The trace response SHALL be handed to the worker without being parsed on the main thread.

#### Scenario: Large response arrives
- **WHEN** a trace response is received
- **THEN** its body is passed to the worker as text, and no `JSON.parse` of it occurs on the
  main thread
