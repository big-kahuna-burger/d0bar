# trace-view Specification

## Purpose
Answers "what happened to this request on the backend" for one selected request, and — the
harder half — says which of three different things the answer is.

A trace is not queryable the instant a request finishes. So "found", "not queryable yet" and
"no span exists at all" are three distinct facts about three different systems: the backend
has it, the backend does not have it yet, or nothing ever produced it. A single spinner that
stands for all three turns ingest lag into an apparent instrumentation gap, and turns d0bar's
own missing credential into a finding about the host. The capability SHALL keep them apart, in
the copy and in the state machine.

The second constraint is that this surface opens over a page whose INP the toolbar is still
reporting. A four-thousand-span trace parsed on the main thread would be the toolbar
manufacturing the long task it exists to measure, so the response body SHALL cross to a worker
without being read here.
## Requirements
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

### Requirement: In-flight queries cannot outlive their selection
A query SHALL be aborted when the user selects another request or closes the panel.

#### Scenario: Clicking away mid-fetch
- **WHEN** a query is in flight and the user selects a different request
- **THEN** the first query is aborted and its response can never populate the panel

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
