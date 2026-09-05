# add-self-attribution

## Why
`Δ INP 0.0ms` is printed in the footer of a tool whose entire pitch is honesty about
measurement. Right now it would be an assumption. It can be a measurement.

`long-animation-frame` entries carry per-script attribution — `sourceURL`,
`sourceFunctionName`, `duration`. So the toolbar can detect **its own script inside a long
animation frame** and report it, using exactly the API it uses to report the host's vitals.
Self-incrimination from the same source, which is a far stronger claim than a CI budget alone.

## What Changes
- Attribute LoAF script entries to d0bar by `sourceURL`, and sum them.
- Mark all toolbar work with a reserved `performance.measure` prefix.
- The footer's perturbation label renders the measured figure; non-zero is shown, not hidden.
- A dev-only self-report panel listing d0bar's own longest frames.

## Impact
- New capability: `self-attribution`
- New: `src/collector/selfcost.ts`
- Depends on: `add-observation-core`, `add-panel-shell`
- Fills the footer's perturbation slot left as a measured zero by `add-panel-shell`
- Related: `add-perturbation-budget` (CI enforcement of the same property)
