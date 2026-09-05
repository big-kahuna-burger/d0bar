# add-trace-layout-worker

## Why
Traces run to thousands of spans. Parsing one and laying out its tree is exactly the work that
must not land on the thread whose INP the toolbar is reporting. The trace header asserts
`flattened in worker · 0 ms on main thread`; this change is what makes that literal.

The worker returns **positioned rows**, not a tree. All depth, ordering, and x/width arithmetic
happens off-thread, so the main thread's job is reduced to placing rows it is handed.

## What Changes
- A module Web Worker that parses OTLP JSON and emits a flat, positioned row array.
- Typed-array output, transferred rather than copied.
- Per-service colour assignment, stable down the tree.
- A 4000-span budget row.

## Impact
- New capability: `trace-layout`
- New: `src/worker/`, `src/shared/protocol.ts`
- Depends on: `add-perturbation-budget` (the 4000-span fixture)
- Blocks: `add-trace-view`
- Requires `worker-src 'self' blob:` in the host CSP — already present in the dogfood target
