# vitals-view

## ADDED Requirements

### Requirement: Every displayed vital is browser-recorded
The toolbar SHALL display only values obtained from browser performance entries, and SHALL
compute no timing of its own.

#### Scenario: Vitals displayed
- **WHEN** the vitals tab is opened
- **THEN** LCP, CLS, INP and LoAF are derived solely from `largest-contentful-paint`,
  `layout-shift`, `event` and `long-animation-frame` entries

### Requirement: Attribution is quoted, never inferred
Attribution lines SHALL be built only from the attribution fields of the entry itself.

#### Scenario: Attribution present
- **WHEN** an LCP entry carries an `element`
- **THEN** the card shows that element's selector

#### Scenario: Attribution absent
- **WHEN** an entry carries no attribution
- **THEN** the card states that attribution is unavailable rather than naming a likely element

### Requirement: Standard vital definitions
CLS SHALL use session-window grouping and exclude shifts with recent input; INP SHALL use the
standard high-percentile interaction latency rather than the maximum.

#### Scenario: Shift after user input
- **WHEN** a layout shift occurs immediately following user input
- **THEN** it is excluded from CLS

### Requirement: Accumulation is allocation-free
Accumulating a vitals entry SHALL not allocate per entry and SHALL not retain the browser's
entry or any DOM node.

#### Scenario: Many layout shifts
- **WHEN** 500 layout-shift entries are delivered
- **THEN** no DOM node is retained and no per-entry object survives the callback
