# Tasks — enforce non-perturbation

Four findings, ordered so each one's verification exists before the next one leans on it.
`§0` first, because three of the four cannot be shown to be fixed until something runs them.

## 0. Make the guard runnable

- [x] 0.1 A `?d0bar=dev` arm in `bench/fixtures/host/index.html`, serving a build with
      `__DEV__` true. The fixture is the instrument: the arm must be inert unless asked for,
      the way `?live` is
- [x] 0.2 `vite.config.ts` — a `D0BAR_STAGE=dev` build emitting `dist/d0bar.dev.iife.js` with
      the guard compiled in. Not published; excluded from `package.json` `files`
- [x] 0.3 Confirm the dev build is never what `?d0bar=on` loads — the measured arms must stay
      the shipped bytes

## 1. `assertSettled` guards what it claims

- [x] 1.1 `pill.ts` — call it before the `document.body` append and before `adoptedStyleSheets`
- [x] 1.2 `index.ts` — call it in `prefetchStage2()` and before `startTier2()`
- [~] 1.3 `correlate.ts` — **not done, and must not be.** `flushCorrelation` runs in stage 2,
      which is a separate bundle with its own copy of every module — including `phase.ts`,
      whose phase is never advanced there. `currentPhase()` is `"collecting"` forever in that
      copy, so the guard would throw on every panel open in the `dev` arm. Found by building
      against the task. The underlying defect is stage-2 code living under `src/collector/`,
      which the proposal lists as out of scope
- [x] 1.4 `sw/` registration path — call it before `navigator.serviceWorker.register`
- [x] 1.5 A perf test on the `dev` arm asserting the page reaches settle with no throw, so the
      guard is proved to run rather than merely to exist
- [x] 1.6 A unit test that calls each guarded entry point pre-settle and expects the throw —
      one per call site, so deleting a call fails a named test
- [x] 1.7 Correct `readme.md` and `architecture.md` where they describe a guard that did not
      exist. `architecture.md`'s "derive / aggregate — FORBIDDEN" also overstates: `noteLcp`
      derives a selector, CLS accumulates session windows and the INP top-ten is maintained,
      all inside observer callbacks pre-settle. Bounded and defended; the sentence is still
      false. Say "record, and bounded-accumulate"

## 2. The moratorium test can fail

- [x] 2.1 `moratorium.spec.ts` — read LCP from `__metrics.lcp`, the fixture's own instrument,
      which has it. `performance.getEntriesByType("largest-contentful-paint")` returns nothing:
      LCP is observer-only, and the same fact broke the vitals recorder in `add-vitals-view`
- [x] 2.2 Fail if that value is absent rather than defaulting to `0` — the current `: 0` is what
      turned the assertion into a tautology
- [x] 2.3 Assert against settle, not `loadEventEnd`: settle is load, plus LCP quiet, plus one
      background task
- [x] 2.4 `bench/fixtures/host/metrics.js` records load-phase side effects beyond a node
      insertion — a `fetch`, a `postMessage` to a worker, an `adoptedStyleSheets` write. It is
      the instrument, so it must record without perturbing: capture, do not patch what d0bar
      uses to measure
- [x] 2.5 Verify the test fails when the deferral is removed. A test that has never been seen
      red is the thing this change exists to stop shipping

## 3. The budget measures d0bar

- [x] 3.1 `ab.spec.ts` — add an attributed row using CDP per-task script attribution, the
      instrument already in `tests/perf/attribution.ts`. No 50 ms floor, and it names whose
      the work was
- [x] 3.2 Keep `longtask` and the arm delta. They answer a real question; they are simply not
      the question "what did d0bar cost"
- [x] 3.3 Long-task count becomes p95, not the mean — the file's own header already says
      "never at the mean"
- [x] 3.4 Add the `gated` arm to this comparison, per the working agreement that `gated` is the
      baseline rather than `off`
- [x] 3.5 Record the new row in `bench/budget.json` with instrument, spread and exclusions.
      **Coordinate with `extract-bench-harness`**, which makes that file the thing that gates —
      whichever lands second adopts the other's shape
- [x] 3.6 Verify it fails: inject a 40 ms block into a dev-only branch of stage 1, confirm red,
      remove it

## 4. `destroy()` restores state

- [x] 4.1 `destroy()` calls `resetVitals`, `resetPhase`, the ring reset and the intern reset.
      Their "test seam" comments become false and are rewritten
- [x] 4.2 `phase.ts` — `resetPhase` must clear `lcpSealAt`, `loadedAt` and `lastLcpAt`; confirm
      nothing else survives
- [x] 4.3 `init()` while live with a differing config no longer discards it silently —
      throw in development, warn once in production
- [x] 4.4 Unit test: `init` → entries → `destroy` → `init` → the same buffered entries
      re-delivered → every count is what one page produced, not two
- [x] 4.5 Measure stage 1 before committing. The reset calls are real bytes on the critical
      path and `budget.json` carries a standing instruction to measure first; headroom is
      0.60 kB

## 5. Interaction before load

- [x] 5.1 `index.ts` — the settle-gated network side effects (stage-2 prefetch, tier 2
      registration) additionally wait for load. The moratorium may lift at first input, per the
      standard; the prefetch's own justification is that it must not compete with the host's
      critical requests
- [x] 5.2 Leave the pill mount on settle alone — a DOM write into a closed shadow root is not
      what that justification is about
- [x] 5.3 Perf test: click during load, assert no d0bar network request before `loadEventEnd`
- [x] 5.4 `phase.ts` — start the settle ceiling at `beginPhaseTracking` rather than at
      `noteLoaded`. Today a page whose `load` never fires never reaches the ceiling, and
      `observation-core`'s "bounded ceiling" scenario is false for it

## 6. CI

- [x] 6.1 `.github/workflows/ci.yml` — pnpm, `pnpm build`, `pnpm test`, `pnpm size`
- [x] 6.2 `pnpm test:perf` in the same workflow, with the Playwright browser install
- [x] 6.3 Pin the browser version, and note in the workflow that bundled Chromium, Playwright's
      Chromium and stable Chrome have different `supportedEntryTypes` — a green CI on one says
      nothing about the others
- [~] 6.4 The workflow exists and every command in it has been run locally and observed
      passing — `pnpm lint`, `pnpm size` (5/5 gates), `pnpm test` (407), and each perf spec
      touched by this change. It has **not** been observed green on GitHub Actions, because
      nothing has been pushed. The `readme.md` sentences are left exactly as they were, per
      this task: they become true when the workflow runs, not when they are edited

## 7. The budget rows resolve finer than their thresholds

Found by CI, which is the point: both rows below passed on a laptop and failed on a two-core
runner. `bench/quantized-metrics.md` carries the failure, the arithmetic and the replacement.

- [x] 7.1 `longTaskCount` back to a mean. §3.3 moved it to a p95 citing "never at the mean";
      that rule guards against a hidden tail and inverts for an integer count, whose p95 at
      n=20 is one sample with a noise floor of a whole task against a 0.5 threshold. CI: off 7,
      gated 6, on 7 — `on` tied with the arm that loads nothing, and the baseline scored below
      both
- [x] 7.2 INP compared as a paired sign test rather than a p95 delta. Chrome quantizes INP to
      8 ms, so no millisecond threshold is expressible; CI failed at Δ = 8, the smallest
      non-zero value the metric can take. `off` and `gated` both scored 88, so the baseline
      swap was not the cause
- [x] 7.3 `bench/budget.json` — both rows rewritten with the CI arms that forced them and the
      resolution argument
- [x] 7.4 `bench/quantized-metrics.md` — the writeup, linked from `bench/README.md` and
      `CLAUDE.md`
- [x] 7.5 `CLAUDE.md` — CI calibrates and checks, local runs one targeted spec briefly. Two
      failures established this: a `tier2` p95 of 5.60 ms locally that passed on CI, and an
      INP row that could not fail on hardware fast enough to tie every run
- [x] 7.6 Calibrate on CI. The reworked rows are **implemented, not exercised** — typecheck
      and lint pass and nothing has been run. Push and read the run
- [ ] 7.7 If the sign test reports a real directional cost, probe the pill's 500 ms refresh
      clock: it writes a text node and fires a pulse animation while the A/B test clicks five
      times at 120 ms spacing, and style/layout from d0bar's writes is the blind spot
      `attribution.ts` documents

## 8. The fixture can express a toolbar-sized interaction cost

- [x] 8.1 The first calibration run passed with 20 ties and p=1: every one of sixty runs across
      three arms returned an INP of exactly 88. Green by vacuity — `#confirm-hold` blocks 84 ms
      deliberately and there is no variance to read
- [x] 8.2 `#cheap-tap` in the fixture — one attribute flip, no block, no layout thrash, no
      network. Inert unless clicked, like every other opt-in in `bench/fixtures/host/`
- [x] 8.3 `metrics.js` counts cheap-tap `event` entries **strictly above** the type's 16 ms
      `durationThreshold` floor rather than timing them: a sub-16 ms interaction produces no
      entry at all, so there is no duration to read. The count has no quantum and no order
      statistic
- [x] 8.4 `ab.spec.ts` — two `#confirm-hold` clicks (INP is the slowest interaction below fifty,
      so two preserve the fixture's poor INP) plus five `#cheap-tap` clicks.
      `cheapTapsOverQuantum` summed across runs, gated absolutely in every arm
- [x] 8.5 `budget.json` and `quantized-metrics.md` record the vacuity finding
- [x] 8.6 Calibrated on CI, and the first calibration falsified the row: counting entries that
      *reached* the floor read off 297, gated 297, on 297, every entry at exactly 16 ms — the
      same vacuity in the other direction, and 297 was entries not taps (one click emits
      pointerdown, pointerup and click). Rewritten to count entries above the floor, where the
      signal is; measured 0/0/0, so the threshold is 0 — the measurement, not a tuned number.
      **The 0/0/0 reading is from the previous CI run's saturation data; the rewritten row has
      not itself been run on CI yet**
- [ ] 8.7 Only once the row resolves: the pill-clock probe from 7.7, which was unrunnable
      against an instrument that returned 88 either way
