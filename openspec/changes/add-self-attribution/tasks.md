# Tasks — self attribution

## 1. Identify own script
- [x] 1.1 Resolve d0bar's own script URL at init: `import.meta.url` for ESM, `document.currentScript.src` for IIFE
- [x] 1.2 Handle bundled-into-host-chunk case, where the URL is the host's bundle: fall back to marker-based attribution and label the figure as a lower bound
- [x] 1.3 Record the resolution mode, so the UI can state which method produced the number

## 2. LoAF self-attribution
- [x] 2.1 `src/collector/selfcost.ts` — for each `long-animation-frame` entry, sum `scripts[]` durations whose `sourceURL` matches d0bar's
- [x] 2.2 Accumulate: total self ms, longest self frame, count of frames containing d0bar work
- [x] 2.3 Attribute separately for the load phase and after settle — load-phase self cost must be zero by construction
- [x] 2.4 Feature-detect `long-animation-frame`; where unsupported, label the figure unavailable rather than zero

## 3. Own-work marking

**Corrected while building — `performance.measure` was the wrong mechanism.** Measure entries
never appear in `long-animation-frame`'s `scripts[]`, which is the only thing attribution reads,
and a measure pair costs two calls and an entry allocation inside the callback it wraps. What
Chrome reports is the root callback's `sourceFunctionName`, so d0bar's batch-level callbacks are
*named* `d0bar:<what>` instead, at zero runtime cost — which also makes 3.2's dev-only gate
unnecessary, so the marks ship in every build. See `src/shared/mark.ts`.

- [x] 3.1 Batch-level toolbar callbacks named with a reserved `d0bar:` prefix, via a quoted method
      key so V8 fixes the debug name at parse time — a runtime-built key yields the right `.name`
      and an empty `sourceFunctionName`
- [x] 3.2 No gate needed: naming costs one call frame, so the marks are in the shipped build and
      `self-attribution.spec.ts` can assert against the bytes a customer runs
- [x] 3.3 `collector/vitals.ts` excludes `d0bar:`-named scripts when naming the host's worst
      script — d0bar's own frame must never be reported as the page's

## 4. Footer reporting
- [x] 4.1 Perturbation label renders the measured value: `Δ INP 0.0ms` when zero, the real figure when not
- [x] 4.2 Non-zero self cost is rendered in the warning colour — never rounded down to 0.0
- [x] 4.3 Unavailable measurement renders as `Δ INP unmeasured` with a tooltip explaining why
- [x] 4.4 INP tooltip copy verbatim from handoff, extended with the attribution method in use

## 5. Dev self-report
- [x] 5.1 Dev-only view listing d0bar's longest self frames with function names
- [x] 5.2 Playwright: drive the panel hard under CPU throttling, assert the self-report is
      non-empty and that at least one frame was recognised by the *mark* rather than by URL.
      Corrected from the original: unthrottled, an empty report means d0bar was free, so the
      assertion as written would have failed exactly when the product was good
- [x] 5.3 Playwright: assert load-phase self cost is exactly zero
