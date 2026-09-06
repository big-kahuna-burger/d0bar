# Tasks — enforce non-perturbation

Four findings, ordered so each one's verification exists before the next one leans on it.
`§0` first, because three of the four cannot be shown to be fixed until something runs them.

## 0. Make the guard runnable

- [ ] 0.1 A `?d0bar=dev` arm in `bench/fixtures/host/index.html`, serving a build with
      `__DEV__` true. The fixture is the instrument: the arm must be inert unless asked for,
      the way `?live` is
- [ ] 0.2 `vite.config.ts` — a `D0BAR_STAGE=dev` build emitting `dist/d0bar.dev.iife.js` with
      the guard compiled in. Not published; excluded from `package.json` `files`
- [ ] 0.3 Confirm the dev build is never what `?d0bar=on` loads — the measured arms must stay
      the shipped bytes

## 1. `assertSettled` guards what it claims

- [ ] 1.1 `pill.ts` — call it before the `document.body` append and before `adoptedStyleSheets`
- [ ] 1.2 `index.ts` — call it in `prefetchStage2()` and before `startTier2()`
- [ ] 1.3 `correlate.ts` — call it in `flushCorrelation` before the IndexedDB read
- [ ] 1.4 `sw/` registration path — call it before `navigator.serviceWorker.register`
- [ ] 1.5 A perf test on the `dev` arm asserting the page reaches settle with no throw, so the
      guard is proved to run rather than merely to exist
- [ ] 1.6 A unit test that calls each guarded entry point pre-settle and expects the throw —
      one per call site, so deleting a call fails a named test
- [ ] 1.7 Correct `readme.md` and `architecture.md` where they describe a guard that did not
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

- [ ] 3.1 `ab.spec.ts` — add an attributed row using CDP per-task script attribution, the
      instrument already in `tests/perf/attribution.ts`. No 50 ms floor, and it names whose
      the work was
- [ ] 3.2 Keep `longtask` and the arm delta. They answer a real question; they are simply not
      the question "what did d0bar cost"
- [ ] 3.3 Long-task count becomes p95, not the mean — the file's own header already says
      "never at the mean"
- [ ] 3.4 Add the `gated` arm to this comparison, per the working agreement that `gated` is the
      baseline rather than `off`
- [ ] 3.5 Record the new row in `bench/budget.json` with instrument, spread and exclusions.
      **Coordinate with `extract-bench-harness`**, which makes that file the thing that gates —
      whichever lands second adopts the other's shape
- [ ] 3.6 Verify it fails: inject a 40 ms block into a dev-only branch of stage 1, confirm red,
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

- [ ] 6.1 `.github/workflows/ci.yml` — pnpm, `pnpm build`, `pnpm test`, `pnpm size`
- [ ] 6.2 `pnpm test:perf` in the same workflow, with the Playwright browser install
- [ ] 6.3 Pin the browser version, and note in the workflow that bundled Chromium, Playwright's
      Chromium and stable Chrome have different `supportedEntryTypes` — a green CI on one says
      nothing about the others
- [ ] 6.4 Only after it is green: the three places in `readme.md` saying "asserted in CI" become
      true. Do not correct them by editing the sentence
