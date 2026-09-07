## 1. The wire shape

- [ ] 1.1 `src/shared/protocol.ts`: `LogRecord` — `severity: number`, `level: string`,
      `body: string`, `bodyKind: LogBodyKind`, `offsetNs: number`, `row: number`,
      `unattached: LogUnattached | 0`. `row` is an index into the row buffer; `-1` when unattached.
      Not optional — an absent field and a deliberate "no owner" are the same JSON.
- [ ] 1.2 `src/shared/protocol.ts`: `LogBodyKind = "string" | "int" | "double" | "bool" | "array"
      | "kvlist" | "bytes" | "absent"`, and `LogUnattached = "no-span-id" | "span-not-in-trace" |
      "span-capped"`. Three reasons, not one: `span-capped` must not render as the span not
      existing.
- [ ] 1.3 `src/shared/protocol.ts`: `LOG_CAP = 200`, with the readability rationale and a note
      that it is overridable in tests exactly as `cap` is for spans.
- [ ] 1.4 `src/shared/protocol.ts`: `F_HAS_LOG = 1 << 5` on the existing `flags` byte. No change to
      `ROW_BYTES`.
- [ ] 1.5 `src/shared/protocol.ts`: `logs: LogRecord[]` and `logsSeen: number` on the `layout-ok`
      reply. Remove `LayoutSummary.log`; keep `logCount` as the pre-cap total.
- [ ] 1.6 `src/shared/protocol.ts`: `LogAttr` — `key: string`, `value: string`,
      `kind: LogBodyKind`. `attrs: LogAttr[]` and `attrsSeen: number` on `LogRecord`.
- [ ] 1.7 `src/shared/protocol.ts`: `ATTR_CAP = 64`, and `timeUnixNano` on `LogRecord` — the detail
      view shows a timestamp, and the list's `offsetNs` cannot be un-subtracted.

## 2. The worker

- [ ] 2.1 `src/worker/layout.ts`: `readLogs` returns the records rather than a count and a
      worst-of. Reads `severityText`, `severityNumber`, `timeUnixNano` (falling back to
      `observedTimeUnixNano`), `spanId`, and the body.
- [ ] 2.2 `src/worker/layout.ts`: body by kind. `stringValue` renders; every other OTLP variant
      returns its kind with an empty `body`; a missing body is `"absent"`. Replaces the current
      `: ""`, which renders a `kvlist` body as an empty log line.
- [ ] 2.3 `src/worker/layout.ts`: resolve `spanId` → `row` using the id→index map already built
      while assembling the tree. Must run **after** the cap is applied, so a span the cap dropped
      resolves to `span-capped` and not to `span-not-in-trace`.
- [ ] 2.4 `src/worker/layout.ts`: `offsetNs` is the record's timestamp minus the trace's start,
      clamped at 0. A log outside the trace's extent is real (clock skew between services) and is
      clamped rather than dropped or rendered negative.
- [ ] 2.5 `src/worker/layout.ts`: select for the cap **by severity first**, arrival order preserved
      within a severity. The footer derives the severest record from the list, so the severest can
      never be the record the cap dropped.
- [ ] 2.6 `src/worker/layout.ts`: set `F_HAS_LOG` on every row a record resolved to.
- [ ] 2.7 `src/worker/layout.ts`: `logsSeen` is the pre-cap count; `logs.length` is what survived.
- [ ] 2.8 `src/worker/layout.ts`: extract one `anyValue(v) => {text, kind}` reader and route the
      body **and** every attribute value through it. One reader, not two — the drift between them
      would be silent, which is the whole reason `layoutViews` is shared.
- [ ] 2.9 `src/worker/layout.ts`: read `attributes` into `LogAttr[]` up to `ATTR_CAP`, recording
      `attrsSeen`. An attribute with a key and no value keeps its key and takes kind `"absent"`.

## 3. The panel

- [ ] 3.1 `src/panel/views/trace/index.ts`: the footer becomes `<details>`/`<summary>` — native
      focus, Enter and Space, and expanded state announced, none of it hand-rolled. `<summary>`
      keeps the count and the severest line, derived from `logs`.
- [ ] 3.2 `src/panel/views/trace/index.ts`: the list. One row per record: level, `offsetNs`
      formatted with the same unit logic the waterfall already uses, body or `⟨kind⟩`.
- [ ] 3.3 `src/panel/views/trace/index.ts`: a record with `row >= 0` gets a **span badge** — a
      sibling button, not a nested one — that selects that row through the **existing**
      row-selection path and scrolls it into view. No second selection mechanism.
- [ ] 3.4 `src/panel/views/trace/index.ts`: a record with `row === -1` is not a button, and states
      its reason — trace-level, span absent from this trace, or span dropped by the cap. Distinct
      copy per reason.
- [ ] 3.5 `src/panel/views/trace/index.ts`: truncation notice when `logsSeen > logs.length`,
      naming both numbers. Absent otherwise.
- [ ] 3.6 `src/panel/views/trace/index.ts`: no footer at all at zero records — an empty
      disclosure occupies the row a reader scans for a warning.
- [ ] 3.7 `src/panel/panel.css`: the list, severity colours reusing the existing error/warning
      tokens, and the `F_HAS_LOG` row marker.

## 3b. The detail view

- [ ] 3b.1 `src/panel/shell.ts`: `View` gains `"log"`, plus the selected record's **index** into
      the reply's `logs` — not the record itself, so a re-layout cannot leave a stale copy live in
      a second view. Escape and `popToList()` behaviour comes from the existing stack.
- [ ] 3b.2 `src/panel/views/log/index.ts`: the view — severity, timestamp, body or `⟨kind⟩`, and
      the attribute table. Back affordance modelled on `views/connect/index.ts:368`.
- [ ] 3b.3 `src/panel/views/log/index.ts`: a record with no attributes says so; an attribute whose
      value is not text shows its kind; a truncated attribute list names both numbers.
- [ ] 3b.4 `src/panel/views/trace/index.ts`: the log row itself opens the detail view, as a
      sibling button of 3.3's span badge — two labelled targets in a grid, never one element
      disambiguated by hit-testing, and never nested buttons. The row action works for every
      record; the badge only for attached ones.
- [ ] 3b.5 `src/panel/index.ts`: mount and destroy the log view alongside the others, and include
      it in `destroy()`. Every other view is torn down there; one that is not would outlive the
      panel.

## 4. Tests

- [ ] 4.1 `tests/unit/layout-logs.test.ts`: body kinds — a `stringValue` renders; `kvlistValue`,
      `arrayValue`, `intValue`, `boolValue` and `bytesValue` each return their kind with no body;
      an absent body is `"absent"`. This is the assertion the current `: ""` would fail.
- [ ] 4.2 `tests/unit/layout-logs.test.ts`: attachment — a `spanId` in the trace resolves to that
      row and sets `F_HAS_LOG`; a missing id gives `no-span-id`; an unknown id gives
      `span-not-in-trace`; **an id belonging to a span the cap dropped gives `span-capped`**, with
      an injected cap.
- [ ] 4.3 `tests/unit/layout-logs.test.ts`: the cap keeps the severest — with `LOG_CAP` injected
      below the record count, an ERROR arriving last still survives, and the tie-break still
      returns the earliest at the worst severity.
- [ ] 4.4 `tests/unit/layout-logs.test.ts`: `offsetNs` clamps at 0 for a record timestamped before
      the trace's start.
- [ ] 4.5 `tests/unit/trace-view.test.ts`: zero records renders no footer; a truncated list names
      both numbers; an unattached record renders as non-interactive with its own copy.
- [ ] 4.6 `tests/unit/layout-logs.test.ts`: attributes — a string value renders; each non-string
      `AnyValue` variant returns its kind; a key with no value keeps its key; `ATTR_CAP` truncates
      and records `attrsSeen`.
- [ ] 4.7 `tests/unit/log-view.test.ts`: the detail view — a record with no attributes says so, a
      truncated list names both numbers, and the back path returns to the trace.
- [ ] 4.8 `tests/unit/teardown.test.ts`: extend for the log view, since `destroy()` gained a
      subject and the existing test is what would catch it being missed.
- [ ] 4.9 `tests/perf/trace-view.spec.ts`: two browser assertions — activating a log selects the
      span it names, and opening a record reaches the detail view and returns. Verify each fails
      with its wiring removed before claiming it holds.

## 5. Gates

- [ ] 5.1 `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm vitest run`, `pnpm build`.
- [ ] 5.2 `pnpm size`. **Stage 2 has under 0.8 kB of headroom and this change is entirely in stage
      2, with a scope deliberately larger than that headroom.** Expect a breach. If it breaches,
      raise the ceiling **with a written rationale in `bench/budget.json`** making the argument
      explicitly — stage 2 is loaded on first open and is off the critical path, which is why it
      has the loosest budget in the project. "The feature needed it" is not that argument. Never
      cut a specified behaviour quietly to make the gate pass, and report the number either way.
- [ ] 5.3 Run `tests/perf/trace-view.spec.ts` and `trace-layout.spec.ts` as named specs: the row
      flags and the reply shape both changed, so a passing unit suite is not sufficient evidence.
- [ ] 5.4 `openspec validate add-correlated-logs --strict`.
