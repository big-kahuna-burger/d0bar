# correlated-logs Specification

## Purpose
TBD - created by archiving change add-correlated-logs. Update Purpose after archive.
## Requirements
### Requirement: The log count is reachable
A trace's correlated log count SHALL be a control that reveals the records behind it, never
terminal text. Where the count is zero the control SHALL be absent rather than disclosing an empty
list.

#### Scenario: A trace with correlated logs
- **WHEN** a trace query returns a response containing log records
- **THEN** the footer states the count and can be activated to reveal the records
- **AND** each revealed record shows its severity level, its offset from the trace start, and its
  body

#### Scenario: A trace with no correlated logs
- **WHEN** a trace query returns a response containing no log records
- **THEN** no log footer is rendered at all, and no empty list can be opened

#### Scenario: Keyboard reaches it
- **WHEN** the reader is navigating by keyboard
- **THEN** the disclosure control is focusable and activates on Enter or Space

### Requirement: A log is attached to a span only on the record's own evidence
A log record SHALL be attached to a waterfall row if and only if the record names a `spanId` that
is present in the rendered trace. The panel MUST NOT infer an owner from timestamps, ordering,
service name, or proximity.

#### Scenario: The record names a span in this trace
- **WHEN** a log record carries a `spanId` matching a span in the waterfall
- **THEN** the record offers a distinct span affordance which selects that span's row and scrolls
  it into view
- **AND** that row carries a marker indicating it has a correlated log
- **AND** the record's own activation still opens its detail view, so the two actions are separate
  targets rather than one gesture resolved by position

#### Scenario: The record names no span
- **WHEN** a log record carries no `spanId`, or an empty or unparseable one
- **THEN** the record is listed, is not activatable, and is labelled as belonging to the trace
  rather than to a span

#### Scenario: The record names a span that is not present
- **WHEN** a log record's `spanId` does not match any span in the rendered trace
- **THEN** the record is listed and not activatable, and states that the span it names is not in
  this trace
- **AND** where the span list was capped, the record SHALL NOT claim the span does not exist

### Requirement: A body that is not a string is disclosed by kind
OTLP permits a log body of `stringValue`, `intValue`, `doubleValue`, `boolValue`, `arrayValue`,
`kvlistValue` or `bytesValue`. A body the panel does not render as text SHALL be identified by its
kind. Rendering it as an empty string is forbidden.

#### Scenario: A string body
- **WHEN** a record's body is a `stringValue`
- **THEN** the body text is rendered

#### Scenario: A structured body
- **WHEN** a record's body is a `kvlistValue` or `arrayValue`
- **THEN** the record names the body's kind rather than showing nothing

#### Scenario: A body that is absent
- **WHEN** a record carries no body at all
- **THEN** the record says so, and remains listed with its severity and offset

### Requirement: The severest log stays visible without opening the list
The collapsed footer SHALL continue to identify the most severe correlated log, so a reader who
never opens the list is not deprived of the finding the count exists to advertise. Where several
records share the worst severity, the earliest SHALL be the one shown.

#### Scenario: An error among warnings
- **WHEN** a trace's logs contain one ERROR and several WARN records
- **THEN** the collapsed footer identifies the ERROR record

#### Scenario: A tie at the worst severity
- **WHEN** two records share the highest severity number
- **THEN** the earlier of the two is the one identified

### Requirement: The record list is capped and says when it is
The number of log records surfaced SHALL be bounded. Where the response held more records than were
surfaced, the panel MUST state that the list is incomplete.

#### Scenario: More records than the cap
- **WHEN** a response holds more log records than the cap
- **THEN** the count reports how many the response held, and the list states that it is truncated

#### Scenario: Within the cap
- **WHEN** a response holds fewer records than the cap
- **THEN** no truncation notice is shown

### Requirement: Parsing log records stays off the main thread
Log records SHALL be extracted from the response body in the layout worker, alongside the spans.
The main thread MUST NOT parse the trace response to obtain them.

#### Scenario: A response with many log records
- **WHEN** a trace response containing log records is laid out
- **THEN** the records are read on the worker thread and delivered with the layout reply
- **AND** the main thread performs no JSON parse of the response body

### Requirement: A log's full record is readable
Every surfaced log record SHALL be openable in a detail view showing its severity, its timestamp,
its body, and its attributes. The detail view SHALL be reached from the log list and SHALL return
to it.

#### Scenario: Opening a record
- **WHEN** the reader opens a log record from the list
- **THEN** the detail view shows that record's severity, timestamp, body and attributes
- **AND** a back affordance returns to the trace and its log list

#### Scenario: A record with no attributes
- **WHEN** a record carries no attributes
- **THEN** the detail view says so explicitly rather than rendering an empty region

#### Scenario: Escape from the detail view
- **WHEN** the reader dismisses the panel from the detail view
- **THEN** the panel closes, and reopening does not strand the reader in the detail view

### Requirement: Attribute values are disclosed by kind, like bodies
An attribute value SHALL be rendered by the same rules as a log body: a string renders as text, and
any other OTLP `AnyValue` variant names its kind. An attribute MUST NOT render as a key with a
blank value when the value is present but not text.

#### Scenario: A string attribute
- **WHEN** an attribute's value is a `stringValue`
- **THEN** the key and its text are rendered

#### Scenario: A structured attribute
- **WHEN** an attribute's value is a `kvlistValue` or `arrayValue`
- **THEN** the key is rendered with the value's kind, not with an empty string

#### Scenario: An attribute with no value
- **WHEN** an attribute carries a key and no value
- **THEN** the key is rendered and identified as having no value

### Requirement: The attribute list is capped and says when it is
The number of attributes surfaced per record SHALL be bounded, and a record whose attributes were
truncated MUST say so.

#### Scenario: More attributes than the cap
- **WHEN** a record carries more attributes than the cap
- **THEN** the detail view renders up to the cap and states how many the record held

#### Scenario: Within the cap
- **WHEN** a record carries fewer attributes than the cap
- **THEN** no truncation notice is shown

