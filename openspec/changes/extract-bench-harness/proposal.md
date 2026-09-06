# extract-bench-harness

## Why

The measurement code in `tests/perf/` is hand-rolled per spec file, and the committed budget is
not what gates anything. `bench/budget.json` calls itself *"committed thresholds for the
observer-effect budget"*, and **nothing reads it**: `ab.spec.ts` carries its own hardcoded
`const BUDGET`, `.size-limit.json` carries the bundle limits separately, and the two new
`requestsView` rows are checked against a `FRAME_BUDGET_MS` constant in a third file. A number
can be lowered in `budget.json` — or raised — without any gate changing, which is the same
failure this repo names outright: a file claiming a property is not a property.

The instrument itself is now worth keeping. `attributedDuring()` reads per-task main-thread time
out of CDP tracing attributed by script URL, at microsecond resolution and with no 50 ms floor.
That is not available off the shelf — tinybench, mitata, benchmark.js and Vitest's `bench` all
measure function throughput in a JS runtime and cannot see a browser frame at all, and Playwright
has no bench primitive. It arrived as a private helper for one spec; it answers a question
several specs ask.

## What Changes

- New workspace package holding the measurement and the gate, built like `spark-signals`:
  its own `package.json`, `tsconfig.build.json`, tests and README under `packages/`.
- `attributedDuring()` moves into it, with its trace reduction (`reduce()`) exported and unit
  tested — the arithmetic is settleable without a browser and is not today.
- The budget becomes a single source that gates: a declared row is read from the budget file,
  compared against the measurement, and the measured value is recorded back into the run report
  as a test annotation. A row that no test claims, and a test that claims no row, both fail.
- `ab.spec.ts` stops carrying its own `BUDGET` const and reads the same rows.
- **Not in scope, and deliberately**: the two-arm fixture comparison itself, the `p95`/`mean`
  statistics in `ab.spec.ts`, and the bundle-size gate in `.size-limit.json`. The first two are
  a natural second tenant and the package's shape should not preclude them; the third is
  `size-limit`'s job and duplicating it would create a fourth threshold.

## Capabilities

### New Capabilities
- `bench-harness`: how a performance budget is declared, measured, gated and recorded — that
  every declared row is enforced, that a measurement names its instrument and its blind spots,
  and that a threshold cannot be moved without the gate moving with it.

### Modified Capabilities

None. This changes how d0bar's own budgets are enforced, not what any shipped capability does.

## Impact

- New: `packages/<name>/` — the package, its tests, its README.
- Changed: `tests/perf/attribution.ts` (deleted, moves into the package),
  `tests/perf/requests-view.spec.ts` and `tests/perf/ab.spec.ts` (consume the package),
  `bench/budget.json` (gains the shape the gate reads), `bench/README.md`.
- Unchanged: `src/`. No shipped code is touched, and the package is a devDependency — it must
  never appear in a d0bar bundle.
- Assumption recorded rather than asked: the package is named `frame-budget` and is published
  under MIT like `spark-signals`. Both are cosmetic and cheap to change before the first
  publish; neither affects the shape of anything below.
