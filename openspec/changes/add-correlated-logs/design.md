## Context

`readLogs` in `src/worker/layout.ts` already walks the OTLP `resourceLogs` of every trace response.
It keeps two things — a count, and the single most severe record as `{level, message}` — and drops
`spanId`, `timeUnixNano`, attributes and every other record. `views/trace/index.ts` renders the
count as a `<div>` of text. So the parsing exists, the data is thrown away one function call before
it could be used, and the panel advertises a finding it cannot open.

Three existing constraints shape everything below.

| | |
| --- | --- |
| Rows carry no span id | `ROW_BYTES` is `durationNs, nameId, serviceId, left, width, depth, paletteIndex, flags`. Nothing in the buffer identifies a span, so the **main thread cannot match a log's `spanId` to a row.** |
| The response is never parsed on the main thread | `LayoutRequest.body` is text and the worker is the only thing that parses it. That is the point of the worker and is not negotiable. |
| Stage 2 is at 24.23 kB of 25 kB | The tightest headroom in the project, and this change is entirely inside it. The scope chosen is larger than that headroom, deliberately — see the risk on the ceiling. |

## Goals / Non-Goals

**Goals:**

- The log count becomes reachable, and a log that names a span in the trace selects that span.
- A log that cannot be attached is listed and says why, without a guessed owner.
- A log's full attribute set is readable, in a detail view reached from the list.
- Log extraction stays on the worker thread.
- No new row bytes and no second transfer.

**Non-Goals:**

- Log **search or filtering.** A trace's logs are bounded and short; a filter box would cost stage-2
  bytes to solve a problem a reader does not have at this scale.
- Fetching logs the trace response did not contain. The panel renders what the query returned; a
  second API call for logs is a separate capability with its own credential and failure surface.
- Timeline placement. Logs are not drawn on the waterfall as marks at their timestamp — see the
  risk below.

## Decisions

### The worker resolves the span attachment, not the panel

The worker emits `row: number` — an index into the row buffer — rather than the record's `spanId`.

The main thread has no span ids, so the alternative is not "the panel matches instead"; it is
"widen every row by 8 bytes so the panel can match", which pays 64 kB at the 8192-row cap to
duplicate work the worker is already positioned to do. The worker holds the span list, the id→index
map it built while assembling the tree, and — decisively — the knowledge of whether the row cap
dropped a span. That last point is a correctness matter, not an efficiency one: only the worker can
tell **"this trace has no such span"** from **"the span exists and the cap dropped it"**, and the
spec forbids reporting the second as the first.

`row: -1` means unattached, with a reason beside it (see below). Not `row?: number` — an absent
field and a deliberate "no owner" are the same shape in JSON, and the panel would have to guess
which it received.

### Logs cross as plain objects, not through the row buffer

The reply already carries `strings: string[]` beside its transferred `ArrayBuffer`, so plain
structured data on a layout reply is established. Logs get a `logs: LogRecord[]` field.

Rejected: packing them into the typed buffer the way spans are. Spans are in a buffer because there
can be 8192 of them and every one is laid out on open; logs are capped two orders of magnitude
lower, are read only when the disclosure is activated, and are mostly *strings*, which a typed array
cannot hold without interning them into the same table. The cost of the buffer is a byte layout that
both realms must agree on — `layoutViews` exists precisely because that is the bug no type test
catches — and it buys nothing here.

`LOG_CAP = 200`. Chosen for the same reason as `SPAN_CAP`: readability, not memory. A trace with more
than 200 correlated logs is not read by scrolling, and the truncation notice is the honest answer.
Overridable in tests, as `cap` already is for spans.

### `LayoutSummary.log` is replaced, not kept alongside

The severest log becomes a derivation over `logs` rather than a separate field. Keeping both would
put two answers to "which log is worst" in one reply, and they would disagree the first time the cap
dropped the record that happened to be the severest — a footer naming a log absent from the list
below it.

This makes the cap's ordering load-bearing: **records are selected for the cap by severity first**,
not by arrival, so the severest record can never be the one dropped. Arrival order is preserved
within a severity, which keeps the existing tie-break ("the earliest at the worst severity, because
it explains the others") intact.

### The row marker is a flag bit, not a field

`F_HAS_LOG = 1 << 5` on the existing `flags` byte. Three bits remain. Zero new row bytes, and it
reuses the mechanism the other five conditions already use.

### Disclosure is native, not a signal

`<details>`/`<summary>` rather than a bound `open` signal and a hidden div. Focusability, Enter and
Space, and the expanded/collapsed state announced to a screen reader all come from the platform —
each of which is otherwise a line of stage-2 bytes and a thing to get wrong. Consistent with the
existing preference for native `popover` in the panel shell.

### The detail view is a fourth `View`, not an overlay

`shell.ts`'s `View` is `"list" | "trace" | "connect"` and already has the stack behaviour the
detail view needs: `popToList()`, an escape path, and a back button the connect surface uses at
`views/connect/index.ts:368`. Adding `"log"` reuses all of it.

Rejected: a nested overlay inside the trace view. It would need its own dismissal, its own focus
trap and its own escape handling — three things the shell already owns and gets right — and it
would put a second modal layer inside a panel that is itself a `popover`.

The record reaches the view by index into the reply's `logs`, not by value. The panel already holds
the array; passing the object would put two copies of one record in two views, and the stale one
would survive a re-layout.

### Two targets on a log row, not one gesture disambiguated

A log row now has two things it could do — select the span it names, and open its own record — and
resolving that by hit-testing one element would be a guess about intent on every click.

So the row carries two labelled targets. The **row itself** opens the detail view: the record is
what the row *is*, and it is the action that works for every record including the unattached ones.
The **span badge**, rendered only when `row >= 0`, selects and scrolls to that span. Nesting two
buttons is invalid HTML, so the row is a grid of two sibling buttons rather than a button
containing one.

Rejected: click selects the span, a chevron opens the record. It makes the primary gesture do the
thing that is unavailable for a third of the records, so the same click does different things on
different rows — and the unattached rows would have to be inert or lie.

### Attribute values reuse the body's kind reader

One function reads an OTLP `AnyValue` and returns `{text, kind}`; the body and every attribute
value go through it. Two readers would drift, and the drift would be silent — a `kvlistValue`
rendering as text in one place and as `⟨kvlist⟩` in the other, with nothing failing.

`ATTR_CAP = 64` per record, with the count stated when it bites. Chosen for the same reason as the
other two caps rather than by measurement: an attribute list longer than this is not read in a
toolbar, and the OTLP spec puts no bound on it, so an unbounded list is an unbounded reply.

### Body kinds are named, never blanked

Today `typeof body?.stringValue === "string" ? body.stringValue : ""` renders every non-string body
as empty. A record whose body is a `kvlistValue` currently shows a level, a time, and nothing —
which reads as an empty log line rather than as a body this panel does not render. The worker
returns a `kind` alongside the text, and the panel says `⟨kvlist⟩` where it cannot render.

Rejected: serialising structured bodies to JSON in the worker. It is unbounded in size, it would
have to be truncated with its own rules, and a half-printed object is worse than a named kind.

## Risks / Trade-offs

- **A log's `spanId` may point at a span the cap dropped** → The worker distinguishes the two cases
  and the panel renders them differently. This is called out because it is the one place where the
  obvious implementation produces a confident lie.
- **Selecting a span from a log fights the reader's scroll position** → Selection reuses the
  existing row-selection path, which already restores scroll deliberately (`restoreScroll`, and the
  reason it retries across frames). No second mechanism.
- **Stage 2 has under 0.8 kB of headroom and this change is entirely in stage 2** → The list *and*
  the attribute detail view were both chosen over that headroom deliberately, so the ceiling is
  expected to move. If the build breaches 25 kB the answer is a raised ceiling **with a written
  rationale in `bench/budget.json`** — never a feature quietly cut so a gate passes, and never a
  threshold lowered to meet a number. The measurement decides which; predicting it here would be
  guessing, and `pnpm size` is one command.
- **A raised ceiling is a real cost, not a formality** → Stage 2 is the panel, loaded on first open
  and therefore off the critical path, which is why it has the loosest budget in the project. That
  is the argument the rationale has to make explicitly if it is made at all; "the feature needed
  it" is not one.
- **Logs are not placed on the timeline** → Deliberate. A log carries one timestamp, so a mark
  would sit at a point on a scale computed from span extents; where the log's `spanId` is absent the
  mark would imply a correlation the record does not support. Listing is honest at a fraction of the
  bytes. Revisit only with a reader who asked for it.
- **`readLogs` returning records makes the reply larger** → Bounded by `LOG_CAP` and measured, not
  assumed; the reply is already carrying a row buffer that dwarfs it.

## Migration Plan

`LayoutSummary.log` is consumed only by `views/trace/index.ts`, in one binding. Both realms are
built from the same `shared/protocol.ts`, and a stale worker paired with a fresh panel is already
refused by the `version` field on every reply — so there is no mixed-version window to design for.
No stored data and no schema: nothing here persists.

## Open Questions

None. "Clickable" was asked about and answered as **both**: activating a log selects the span it
names *and* the record opens a detail view with its full attribute set. Both are specified above
and in `specs/correlated-logs/spec.md`, and the size consequence is accepted rather than deferred.
