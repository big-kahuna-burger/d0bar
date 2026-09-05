# add-observation-core

## Why
Budget A — the cost of merely being present — is the product claim, and it is the budget
nobody instruments. `PerformanceObserver` callbacks run on the main thread in bursts during
load, exactly when TBT and LCP are measured. An object allocated per `resource` entry, pushed
to an array, followed by a pill re-render, puts d0bar's cost in direct correlation with the
numbers it reports.

This change makes the closed state structurally near-free, and ships a useful pill with no
auth, no service worker, and no network call.

## What Changes
- `@dash0/d0bar` package scaffold; Vite library build (ESM + IIFE); three-stage load contract.
- Explicit opt-in gate. Not enabled → zero observers, zero DOM, zero network.
- String interning (`Uint32` ids) and a preallocated struct-of-arrays ring buffer.
- Tier 1 observers with `buffered: true` + `ReportingObserver`.
- **Load-phase moratorium**: until LCP is final, the only permitted work is a ring write.
- The collapsed pill, as one custom element with a closed shadow root.

## Impact
- New capability: `observation-core`
- New: `src/collector/`, `src/shared/`
- Runtime dependencies in stage 1: **none**
- Blocks: `add-panel-shell`, `add-requests-view`, `add-vitals-view`
- Verified by: `add-perturbation-budget` (its acceptance gate)
