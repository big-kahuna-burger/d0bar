## Context

Three files hold thresholds today and they do not agree by construction:

```
  bench/budget.json      "committed thresholds"        read by NOTHING
  tests/perf/ab.spec.ts  const BUDGET = { ... }        gates the observer-effect arms
  .size-limit.json       limit: "8.5 kB"               gates the bundles
  requests-view.spec.ts  const FRAME_BUDGET_MS = 8     gates the two new frame rows
```

`bench/README.md` tells a contributor to *"update `budget.json` — both the threshold and the
rationale"*, and doing exactly that changes nothing a gate checks. The rationales in that file
are the most valuable thing in it — they are the written record of every raise — and they are
attached to numbers with no teeth.

The instrument being extracted, `attributedDuring()`, arrived while closing the requests view's
frame budget. It reads per-task main-thread time out of CDP tracing attributed by script URL. The
alternatives were measured and rejected: `long-animation-frame` and `longtask` have a 50 ms floor
and report the whole frame rather than one script's share, and instrumenting the product to time
itself is the thing this repo exists not to do.

## Goals / Non-Goals

**Goals:**

- One place a threshold lives, and it is the place the gate reads.
- A declared row and a measurement that claims it are mutually required — neither can exist alone.
- Measured values land in the run report on success, not only in an assertion message on failure.
- The attribution reduction is a pure function with its own unit tests.
- Reusable outside d0bar: nothing in the package knows what a toolbar is.

**Non-Goals:**

- The two-arm fixture comparison and the `p95`/`mean` statistics in `ab.spec.ts`. They are the
  obvious second tenant, and the row shape below is designed so they fit later, but moving them
  in the same change would put a rewrite of the observer-effect suite inside a refactor.
- The bundle-size gate. `size-limit` already enforces `.size-limit.json`; re-implementing it
  would create a fourth threshold rather than removing the third. The budget file may *record*
  bundle numbers, as it does now, without claiming to gate them.
- Cross-browser measurement. See the risk below.

## Decisions

### One budget file, two directions of completeness

A row is declared in `bench/budget.json` and claimed by exactly one measurement. The gate reads
the declared threshold; the measurement supplies the observed value and the metadata. Both
directions are checked, because only checking one leaves the original problem in place:

| direction | failure it catches |
| ------------------------- | ---------------------------------------------------------- |
| declared → claimed | a row someone lowered while the test that used it was deleted |
| claimed → declared | a test inventing its own threshold, which is where we are now |

**Why not just have tests import a constant from the JSON.** That fixes the second direction and
not the first: a row can still go stale with nothing noticing. The check has to be bidirectional
to be a property rather than a convention.

**Where the check runs: a Playwright reporter.** It is the only thing that sees every test's
annotations after the run, and `onEnd` can fail the run. Alternatives considered: a final test in
the suite (cannot see other tests' state without a file on the side, and ordering is not
guaranteed), and `globalTeardown` (runs, but has no access to results in a form that can fail).

**The check is scoped to a full run.** A reporter cannot distinguish "row not claimed" from "that
test was filtered out by `-g`", so completeness is asserted only when the run was unfiltered.
This is a real hole — a contributor running one test will not be told a row went unclaimed — and
the mitigation is that CI runs unfiltered, which is where it matters. Making it stricter would
mean failing every targeted run, which would train people to ignore it.

### The row shape carries the reasoning, not just the number

Rows already carry `rationale`, and that is the file's whole value. The gate adds three fields it
requires rather than merely tolerates: the `instrument` that produced the number, what the number
`excludes`, and the observed `lastMeasured`. A row whose measurement cannot say what it is blind
to is a row that will be over-trusted — the frame rows do not include style and layout the script
provoked, because the browser attributes that work to no script at all, and a reader who does not
know that will read the number as the whole cost.

### Attribution mechanics, and the two traps already paid for

- `RunTask` is emitted **only** under `disabled-by-default-devtools.timeline`. Tracing with just
  `devtools.timeline` yields script events and no tasks, and every attributed call then lands in
  its own bucket — which reports two entries into the script within one frame as two frames, and
  flatters exactly the maximum being gated. Observed while building this.
- A measured script calling itself produces nested `FunctionCall` events covering the same
  microseconds. Only the outermost entry counts.
- **Attributing nothing fails.** A window that finds no time for the named script has measured
  the instrument, not the subject — a renamed trace category or a moved bundle URL both look like
  a perfect score otherwise.

### Peer dependency on `@playwright/test`, and Chromium only

The package takes a `Page` and opens a CDP session, so `@playwright/test` is a peer dependency
rather than a bundled one. CDP is Chromium's protocol: on Firefox or WebKit the attribution path
cannot run, and it must say so and fail rather than skip quietly into a green suite. A skip that
reads as a pass is the same lie as a spinner that means three things.

### Maximum, not p95, for per-frame rows

This repo's rule is p95, and it is right for the observer-effect arms, where each run is one
sample. A scroll produces roughly two thousand frames in one run, and a p95 over those reports
the hundredth-worst frame while a user feels the worst one. The rows record the maximum, and the
threshold is set with enough headroom that machine variance does not reach it — the failure being
caught is categorical, not incremental.

## Risks / Trade-offs

- **Tracing overhead lands inside the intervals it reports** → the number is an upper bound on
  the untraced cost, which is the safe direction. Stated in the row's `excludes`.
- **Chromium trace event names are internal and can be renamed** → the attributed-nothing rule
  turns that from a silent pass into a loud failure.
- **A reporter failing the run is easy to misread as a test failure** → the message names the
  unclaimed row and the file it is declared in, not a stack trace.
- **The package is useful enough to grow** → the non-goals above are the boundary; the arm
  comparison is the one candidate for crossing it, and only in its own change.
- **Extraction moves working code** → the requests-view benches are the acceptance test. They
  measure known values (scroll ~0.8–1.6 ms, storm ~1.1–2.2 ms worst frame), so a reduction that
  changed behaviour in the move would show up as numbers that no longer match.

## Migration Plan

The package lands, `tests/perf/attribution.ts` is deleted, and the two frame rows switch to
reading their threshold from the budget file in the same change — no interval where two copies of
a threshold exist. `ab.spec.ts` follows in the same change, since leaving its `const BUDGET`
behind would leave the original defect standing.

## Open Questions

- The package name is assumed, not decided: `frame-budget`. Cheap to change before publish.
- Whether the bundle rows in `bench/budget.json` should be marked as recorded-not-gated, so the
  file states which of its own rows have teeth. Leaning yes; not required by any requirement here.
