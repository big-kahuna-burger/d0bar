# Tasks — extract the bench harness

Package name assumed `frame-budget` throughout; `packages/frame-budget/` is the directory.
Mirrors `packages/signals/`'s layout, which is the only extraction precedent in this repo.

## 1. Package scaffold

- [ ] 1.1 `packages/frame-budget/package.json` — MIT, `type: module`, `sideEffects: false`,
      `@playwright/test` as a **peer** dependency, `build` / `test` / `prepublishOnly` scripts
      matching `packages/signals/package.json`
- [ ] 1.2 `packages/frame-budget/tsconfig.json` and `tsconfig.build.json`, extending
      `tsconfig.base.json` with `declaration`, `declarationMap`, `outDir: dist`, `rootDir: src`
- [ ] 1.3 `packages/frame-budget/vitest.config.ts` for the package's own unit tests
- [ ] 1.4 Add the package to the root `build` script's `pnpm -F` chain, beside `@d0bar/signals`
- [ ] 1.5 `packages/frame-budget/README.md` — what it measures, what it cannot see, and the
      three instruments it exists because of (`long-animation-frame`, `longtask`, in-product
      timing) with the reason each is insufficient

## 2. Attribution

- [ ] 2.1 `src/attribution.ts` — move `attributedDuring()` from `tests/perf/attribution.ts`
      verbatim, then generalise: the script matcher is a caller-supplied predicate, nothing
      names d0bar
- [ ] 2.2 Export `reduce()` as the pure trace-events → per-task totals function
- [ ] 2.3 Keep both trace categories, with the comment explaining why `RunTask` needs
      `disabled-by-default-devtools.timeline` — dropping it flatters the maximum
- [ ] 2.4 Nested-call dedup: only the outermost entry into a matched script counts
- [ ] 2.5 Throw when a window attributes nothing to the matcher — an uninstrumented run must
      not read as a perfect score
- [ ] 2.6 Refuse to run on a non-Chromium browser with a stated reason; never skip silently
- [ ] 2.7 `tests/reduce.test.ts` — the reduction against fixed event lists, no browser: nesting,
      two separate entries in one task, a call with no enclosing `RunTask`, an empty set

## 3. Budget rows

- [ ] 3.1 `src/budget.ts` — read a budget file, resolve a row by id, expose `threshold`,
      `instrument`, `excludes`, `lastMeasured`
- [ ] 3.2 Row validation: a row missing `instrument` or `excludes` is a malformed row and fails
      loudly, per the spec's "states its instrument and its blind spots"
- [ ] 3.3 `expectWithinBudget(rowId, observed, extra)` — asserts against the declared threshold
      and records the observed value as a test annotation, on pass and on fail alike
- [ ] 3.4 Claiming a row id that the budget file does not declare fails rather than defaulting
- [ ] 3.5 `tests/budget.test.ts` — resolution, malformed rows, unknown row id

## 4. The completeness reporter

- [ ] 4.1 `src/reporter.ts` — a Playwright reporter collecting claimed row ids from annotations
- [ ] 4.2 `onEnd` fails the run listing any declared row no measurement claimed
- [ ] 4.3 Skip the completeness half when the run was filtered (`--grep`, a file argument, or a
      test-level `only`), since an unclaimed row is then indistinguishable from a filtered one
- [ ] 4.4 The failure message names the row and the budget file, not a stack trace
- [ ] 4.5 `tests/reporter.test.ts` — driving `onEnd` with synthetic results: all claimed, one
      unclaimed, filtered run

## 5. Adoption

- [ ] 5.1 `bench/budget.json` gains the fields the gate requires on the two `requestsView` rows
- [ ] 5.2 `tests/perf/requests-view.spec.ts` uses the package; `FRAME_BUDGET_MS` is deleted
- [ ] 5.3 `tests/perf/attribution.ts` deleted — no interval where two copies exist
- [ ] 5.4 `ab.spec.ts`'s `const BUDGET` deleted; its four rows read from the budget file, with
      its `p95` statistics staying in the spec file for now (non-goal)
- [ ] 5.5 Register the reporter in `playwright.config.ts` beside `list` and `json`
- [ ] 5.6 `bench/README.md` — the "update budget.json" instruction becomes true: say that the
      threshold there is what gates, and which rows are recorded rather than gated

## 6. Verification

- [ ] 6.1 Both requests-view benches still measure what they measured before the move —
      scroll ~0.78–1.56 ms, storm ~1.14–2.24 ms worst frame. A reduction that changed behaviour
      in the extraction shows up here as numbers that no longer match
- [ ] 6.2 Deliberately unclaim a row and confirm the run fails; deliberately claim an undeclared
      row and confirm the same. Both restored afterwards
- [ ] 6.3 Confirm no harness code reaches any shipped artifact — grep the built bundles, the way
      `budget.json` records `deliveryType` and `openCursor` being checked for
- [ ] 6.4 Full perf suite green, and `pnpm size` run — neither has been run since the
      `onResourceBatch` fix landed in `add-requests-view`
