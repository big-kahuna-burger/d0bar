# requests-view Specification

## Purpose
The tab a developer lives in: every request the page made, as a waterfall, streaming.

Two failure modes are designed out rather than optimised away. A list that re-renders wholesale
as entries arrive would put the toolbar's cost in direct proportion to the host's traffic — so
rows are windowed and recycled, and the DOM holds a viewport's worth however many records exist.
Bar geometry computed in JavaScript would put a layout pass on the main thread every time a
request completes — so geometry is two custom properties on a contained row, and the browser
does the arithmetic it was going to do anyway.

The third property is the one that is easiest to lose and hardest to notice: **an open list has
to keep receiving requests.** It is stated here as its own requirement because it once regressed
silently and no test caught it — the requirements around it covered not *disturbing* the user
and not working while hidden, and between them was a gap where a list that had simply stopped
updating satisfied everything.

## Requirements

### Requirement: Row rendering is windowed
The request list SHALL render only the visible rows plus a small overscan, regardless of how
many requests have been recorded.

#### Scenario: The buffer is full
- **WHEN** the request buffer is at capacity
- **THEN** the number of row elements in the DOM stays proportional to the visible window, and
  continuous scrolling produces no frame with more than 8 ms of toolbar work

#### Scenario: More records than the buffer holds
- **WHEN** more requests arrive than the buffer's capacity
- **THEN** the windowing arithmetic is unchanged for any record count, and the list reports the
  loss rather than presenting a truncated list as complete

### Requirement: Bar geometry is declarative
Waterfall bar position and width SHALL be expressed as CSS custom properties on a contained
row, so that updating a bar does not recalculate style outside that row.

#### Scenario: A request completes
- **WHEN** a new resource entry updates a row's bar
- **THEN** only that row's custom properties are written, and no layout is invalidated outside it

### Requirement: A shared comparison window
Every row SHALL be positioned within one fixed page-relative time window, so bars are directly
comparable between rows.

#### Scenario: Two requests of equal duration
- **WHEN** two requests have equal durations but different start times
- **THEN** their bars have equal widths and differing offsets

### Requirement: Phase segments come from measured timings
Connect, wait and transfer segments SHALL be derived from the resource entry's own phase
timestamps, and SHALL NOT be synthesized.

#### Scenario: Timings unavailable
- **WHEN** a cross-origin entry exposes no phase timings
- **THEN** the bar renders as a single undifferentiated segment that is visually distinguishable
  from a measured breakdown, rather than showing invented proportions

### Requirement: An open list keeps receiving requests
While the list is open and visible, requests arriving after it was opened SHALL appear in it.

#### Scenario: Requests arrive long after load
- **WHEN** the page has gone quiet, the list is open, and new requests are issued
- **THEN** each one appears in the list without the panel being reopened

### Requirement: Streaming does not disturb the user
Appending rows SHALL NOT move the scroll position or change the selected row.

#### Scenario: Requests arrive while scrolled
- **WHEN** the user has scrolled the list and selected a row, and new requests arrive
- **THEN** the viewport stays on the same rows and the selection is retained

#### Scenario: Panel closed
- **WHEN** requests arrive while the panel is closed or the document is hidden
- **THEN** no row DOM is created or updated

### Requirement: Rows are keyboard operable
Each row SHALL be reachable and openable by keyboard, with an accessible name covering its
method, path, status and duration.

#### Scenario: Opening a row without a pointer
- **WHEN** a row has keyboard focus and Enter is pressed
- **THEN** the trace view for that request opens
