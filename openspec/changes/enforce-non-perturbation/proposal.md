# enforce-non-perturbation

## Why

An architecture review checked the four mechanisms the sentence *"d0bar does not distort what it
measures"* rests on. Three of them are weaker than `architecture.md`, `readme.md` and
`observation-core`'s own spec say they are — and the fourth, `destroy()`, does something worse
than nothing.

Verified by reading the code, not inferred:

| | |
| --- | --- |
| `assertSettled` | **one** call site (`otel.ts:147`). Pill mount, the stage-2 prefetch, service-worker registration and the correlation flush all skip it — and `__DEV__` is false in every `tests/perf/` run, so the guard never executes where the moratorium is actually tested. `readme.md` says "anything that derives, touches the DOM, posts to a worker or fetches calls this first." |
| CI | does not exist. No `.github`, no `.gitlab-ci.yml`, no `.circleci`. `readme.md` says "asserted in CI" in three places; `observation-core`'s budget scenario says "**THEN** CI fails". |
| `moratorium.spec.ts` | reads LCP through `performance.getEntriesByType`, which never returns `largest-contentful-paint` — it is observer-only. `lastLcp` is therefore always `0` and the LCP assertion collapses into the `loadEventEnd` assertion above it. The same platform fact broke the vitals recorder in `add-vitals-view` and was fixed there. |
| the A/B budget | gates through `longtask`, which has a 50 ms floor, against a fixture that blocks 240 ms deliberately. A 40 ms main-thread block by d0bar — the example `CLAUDE.md` opens with — produces no long task, no TBT delta, no CLS, and no INP unless it collides with one of five clicks. It also compares long tasks as a **mean**, under a header that says "never at the mean". |
| `destroy()` | resets nothing. `phase`, `lcpSealAt`, the ring's `written`/`dropped`, the vitals totals and the intern table all survive. A subsequent `init()` re-registers every observer with `buffered: true`, so every resource is pushed a second time, every layout shift is added to a session that already contains it, and `loafCount` doubles. `init()` while live also returns the first handle and silently discards the new config. |

Two of these are the same failure as the `onResourceBatch` listener slot fixed in
`add-requests-view`: a property held by a comment, and a test that would pass with the feature
deleted.

## What Changes

- `assertSettled` is called from every operation the moratorium forbids — the pill's DOM write,
  the stage-2 prefetch, worker registration, the correlation flush — and one perf arm runs a
  build where `__DEV__` is true, so the guard is exercised where it matters.
- `moratorium.spec.ts` reads LCP from the fixture's own instrument, which has it, and asserts
  against settle rather than against the load event. It also detects more than a node
  insertion: a fetch, a worker message, or a stylesheet adoption during the load phase must
  fail it.
- The observer-effect budget gains an **attributed** row. `longtask` and the arm delta stay —
  they answer a question worth answering — but the gate on d0bar's own main-thread cost is
  measured per task by script URL, which has no 50 ms floor. The long-task **mean** becomes a
  p95, matching the file's own stated rule.
- `destroy()` restores the toolbar to its pre-`init()` state, so `init()` after `destroy()`
  starts clean rather than double-counting. `init()` while live stops silently discarding a
  differing config.
- **The moratorium is not ended by an interaction that arrives before load.** LCP is final at
  that point and the moratorium may lift, but the network side effects it gates — the stage-2
  prefetch and worker registration — are justified by "cannot compete with the host page's own
  critical requests", which is exactly what they would do.
- CI runs the unit suite, the size gate and the perf suite on every change, so the three
  documents claiming it exist stop being wrong.

## Capabilities

### New Capabilities

None. Every property here is one `observation-core` already claims.

### Modified Capabilities

- `observation-core`: the moratorium requirement gains enforcement and interaction-before-load
  scenarios; `Clean teardown` gains state restoration; `Critical-path budget` gains an
  attributed per-frame row and stops asserting a CI that does not exist.

## Impact

- Changed: `src/collector/index.ts`, `src/collector/pill.ts`, `src/collector/sw.ts`,
  `src/collector/correlate.ts`, `src/collector/phase.ts` (reset completeness),
  `src/collector/ring.ts` / `vitals.ts` / `shared/intern.ts` (their reset seams stop being
  test-only).
- Changed: `tests/perf/moratorium.spec.ts`, `tests/perf/ab.spec.ts`, `bench/budget.json`,
  `bench/fixtures/host/metrics.js` (a load-phase side-effect recorder).
- New: a CI workflow. Assumed GitHub Actions — the repository's remote is GitHub — and
  recorded rather than asked, since the provider does not change the work.
- Stage-1 size: `assertSettled` calls are `__DEV__`-guarded and compile out of production, so
  the added calls cost nothing shipped. The `destroy()` resets do not — they are real bytes on
  the critical path and must be measured before they are written, per `budget.json`'s own
  standing instruction. Current headroom is 0.60 kB.
- Not in scope: the other eleven findings in the same review — correlation running only once at
  panel open, tier-2 state never re-checked, stage-2 code living under `src/collector/`, the
  duplicated `Tier2State`, `bench/budget.json`'s two disagreeing bundle sections. They are real;
  they are not this change.
