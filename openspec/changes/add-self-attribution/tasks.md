# Tasks — self attribution

## 1. Identify own script
- [ ] 1.1 Resolve d0bar's own script URL at init: `import.meta.url` for ESM, `document.currentScript.src` for IIFE
- [ ] 1.2 Handle bundled-into-host-chunk case, where the URL is the host's bundle: fall back to marker-based attribution and label the figure as a lower bound
- [ ] 1.3 Record the resolution mode, so the UI can state which method produced the number

## 2. LoAF self-attribution
- [ ] 2.1 `src/collector/selfcost.ts` — for each `long-animation-frame` entry, sum `scripts[]` durations whose `sourceURL` matches d0bar's
- [ ] 2.2 Accumulate: total self ms, longest self frame, count of frames containing d0bar work
- [ ] 2.3 Attribute separately for the load phase and after settle — load-phase self cost must be zero by construction
- [ ] 2.4 Feature-detect `long-animation-frame`; where unsupported, label the figure unavailable rather than zero

## 3. Own-work marking
- [ ] 3.1 All toolbar work wrapped in `performance.measure` with a reserved `d0bar:` name prefix
- [ ] 3.2 Marks are dev-build only, or behind a config flag — the measure calls themselves cost something
- [ ] 3.3 d0bar excludes its own `measure` entries from anything it displays about the host

## 4. Footer reporting
- [ ] 4.1 Perturbation label renders the measured value: `Δ INP 0.0ms` when zero, the real figure when not
- [ ] 4.2 Non-zero self cost is rendered in the warning colour — never rounded down to 0.0
- [ ] 4.3 Unavailable measurement renders as `Δ INP unmeasured` with a tooltip explaining why
- [ ] 4.4 INP tooltip copy verbatim from handoff, extended with the attribution method in use

## 5. Dev self-report
- [ ] 5.1 Dev-only view listing d0bar's longest self frames with function names
- [ ] 5.2 Playwright: drive the panel hard, assert the self-report is non-empty (proving attribution works) while the CI budget still passes
- [ ] 5.3 Playwright: assert load-phase self cost is exactly zero
