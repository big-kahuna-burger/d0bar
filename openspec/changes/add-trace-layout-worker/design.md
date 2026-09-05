# Design — trace layout

## Output shape
The worker returns a struct-of-arrays over one transferable `ArrayBuffer`, plus a string table:

| Field | Type | Meaning |
| --- | --- | --- |
| `depth` | u8 | indent level, already resolved from parent links |
| `left`, `width` | f32 | percent of the trace's total span, precomputed |
| `durationNs` | f64 | for the duration column |
| `nameId`, `serviceId` | u32 | index into the returned string table |
| `paletteIndex` | u8 | assigned per service |
| `flags` | u8 | root, error, orphan |

Rows arrive in render order. The main thread never walks a tree, never sorts, and never
computes a percentage.

## Why not send a tree
A tree forces the main thread to traverse in order to render, which is the cost being avoided.
A positioned row array pairs exactly with the windowed renderer from `requests-view`: take a
slice, write `--l` / `--w`, done.

## Parsing
`JSON.parse` inside the worker is already fast enough — tens of milliseconds for 4000 spans,
entirely off the main thread and therefore invisible. Faster options exist and are deliberately
deferred:

- A streaming decoder writing straight into typed arrays, avoiding the intermediate object graph.
- WASM protobuf decode, if the API ever serves binary OTLP rather than JSON.

Neither is justified while the cost is off-thread and under the frame budget. Recorded so the
ceiling is known, not so it gets built now.

## Orphans and malformed traces
A span whose parent is absent from the response is rendered at depth 0 and flagged `orphan`
rather than dropped — a partially ingested trace is a real state, and hiding rows would
misrepresent it. Cycles are broken deterministically and flagged.

## Colour assignment
Palette index is assigned per service on first appearance, so a service keeps one colour for
the whole tree. Assignment order is the traversal order, making it stable across renders of the
same trace.

## Worker lifecycle
One worker, created on first trace open, terminated after an idle period. Module worker with a
typed `postMessage` protocol. Comlink only if the RPC surface grows past a handful of calls.
