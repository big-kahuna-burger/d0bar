## Why

The trace view already parses the correlated logs out of the API response and then throws all but
one away. `readLogs` in `src/worker/layout.ts` walks `resourceLogs`, counts the records, keeps the
single most severe as `{level, message}`, and discards every `spanId`, timestamp, body and
attribute. The panel renders the count as dead text — `"3 correlated logs"` — which tells a reader
that the thing they want exists and gives them no way to reach it.

That is the wrong side of this repo's degradation rule. Naming a count is a claim that the logs are
there; offering no way to read them makes the panel the thing standing between the developer and
their own data, on a surface whose entire purpose is to shorten the distance from a symptom to its
cause.

## What Changes

- The layout worker emits the log **records**, not just a count and a worst-of: level, severity
  number, timestamp, body, and the `spanId` the record names.
- `LayoutSummary.log` — the single severest log, currently the footer's whole content — is
  **BREAKING**ly replaced by the record list. The footer keeps showing the severest line; it just
  reads it from the list rather than being handed it separately. Nothing outside the panel consumes
  the field.
- The footer becomes a disclosure control: activating it reveals the correlated logs, newest-first
  within severity, each showing level, offset from the trace start, and body.
- A log record that names a `spanId` present in the trace is **clickable**: activating it selects
  that span's row in the waterfall and scrolls it into view. The corresponding waterfall row carries
  a marker so the relationship is visible in both directions.
- A log whose `spanId` is absent, unparseable, or names a span not in this trace is listed and
  explicitly **not** clickable, labelled as belonging to the trace rather than to a span. Guessing
  an owner would be a fabricated correlation, which is the one thing this panel may not do.
- A body that is not a `stringValue` (OTLP allows `kvlistValue`, `arrayValue`, `intValue`,
  `boolValue`, `bytesValue`) is rendered by kind and marked as such rather than shown blank —
  today's reader silently produces `""` for all of them.
- Records past a cap are dropped and the count says so, matching the span cap's existing contract.
- A log record also opens a **detail view** carrying its full attribute set, reached from the list
  and returning to it — the same view-stack the connect surface already uses (`shell.ts`'s `View`
  gains a fourth member). Attribute values are rendered by the same kind logic as bodies, so a
  non-string value names its kind rather than appearing blank.

## Capabilities

### New Capabilities

- `correlated-logs`: what the panel does with the log records a trace query returns — which are
  surfaced, how a log is attached to a span, what is shown when it cannot be, the detail view and
  its attributes, and the caps.

### Modified Capabilities

- `trace-view`: the log count stops being terminal text. The requirement that the waterfall
  "renders with span, service and log counts" gains the obligation that the log count is reachable,
  and that selecting a log selects its span.

## Impact

| | |
| --- | --- |
| `src/worker/layout.ts` | `readLogs` keeps records instead of collapsing them; a cap; body-kind handling. |
| `src/shared/protocol.ts` | `LayoutSummary.log` replaced by a record list on the reply. Both stages read this file. |
| `src/panel/views/trace/index.ts` | The footer becomes a disclosure; the log list; selection wiring into the existing row selection. |
| `src/panel/shell.ts` | `View` gains `"log"`, so the detail view uses the existing stack and its back path rather than a new overlay. |
| `src/panel/views/log/` | New: the detail view — one record, its body, its attributes. |
| `src/panel/panel.css` | The list, the severity colours, the waterfall marker, the detail view. |
| `openspec/specs/trace-view/spec.md` | One requirement modified. |

Off the hot path entirely: the layout worker runs on its own thread and only when a trace is
opened, so the extra records cost the host nothing.

**The size ceiling is the live constraint and is expected to move.** Stage 2 sits at 24.23 kB
against 25 kB — the tightest headroom in the project — and this change is entirely in stage 2.
Both the list and the attribute detail view were chosen deliberately over the remaining 0.77 kB, so
if the build breaches the ceiling the answer is a raised ceiling **with a written rationale in
`bench/budget.json`**, not a feature quietly cut to make a gate pass. The measurement decides;
guessing which way it falls here would be the thing this repo forbids.
