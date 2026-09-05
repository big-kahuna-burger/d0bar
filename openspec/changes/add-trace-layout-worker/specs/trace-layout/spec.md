# trace-layout

## ADDED Requirements

### Requirement: Trace parsing and layout run off the main thread
Parsing a trace and computing its row layout SHALL happen in a worker, and the main thread SHALL
receive rows that are already positioned.

#### Scenario: A four-thousand-span trace
- **WHEN** a 4000-span trace is opened
- **THEN** parsing, depth resolution, ordering and geometry all occur in the worker, and the
  main thread performs no tree traversal, sort, or percentage computation

#### Scenario: Main thread stays responsive
- **WHEN** a 4000-span trace is opened while interaction latency is being measured
- **THEN** no long task is attributable to the toolbar on the main thread

### Requirement: Results are transferred, not copied
Row data SHALL cross the worker boundary as a transferable buffer.

#### Scenario: Layout completes
- **WHEN** the worker returns row data
- **THEN** the underlying buffer is transferred, leaving no copy in the worker

### Requirement: Incomplete traces are shown as incomplete
Spans with absent parents, cycles, or degenerate durations SHALL be rendered and flagged rather
than dropped or silently repaired.

#### Scenario: Partially ingested trace
- **WHEN** a span's parent is absent from the response
- **THEN** the span renders at the root level flagged as an orphan, and the UI indicates the
  trace is partial

#### Scenario: Span cap reached
- **WHEN** a trace exceeds the span cap
- **THEN** rows are truncated and the UI states that the view is truncated

### Requirement: A service keeps one colour
Palette assignment SHALL be per service and stable for repeated renders of the same trace.

#### Scenario: A service appears at several depths
- **WHEN** one service owns spans at different depths
- **THEN** every one of its spans carries the same palette index

### Requirement: The browser is part of the trace
The browser `webEvent` SHALL be laid out as the root of the tree.

#### Scenario: A trace with a web event
- **WHEN** the response includes a browser web event for the request
- **THEN** it is the depth-0 root, with backend spans as its descendants
