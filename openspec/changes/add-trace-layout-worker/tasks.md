# Tasks — trace layout worker

## 1. Protocol
- [ ] 1.1 `src/shared/protocol.ts` — discriminated-union message types, versioned
- [ ] 1.2 Request: raw OTLP JSON text plus the trace's time bounds
- [ ] 1.3 Response: transferable `ArrayBuffer` (SoA rows) plus a string table plus a summary
- [ ] 1.4 Error response type — malformed payload never throws across the boundary as an unhandled rejection
- [ ] 1.5 Type tests asserting main thread and worker agree on the layout constants

## 2. Worker
- [ ] 2.1 `src/worker/layout.worker.ts` as a module worker; built as its own entry
- [ ] 2.2 Created lazily on first trace open; terminated after an idle period
- [ ] 2.3 Parse OTLP `resourceSpans` → spans, `resourceLogs` → correlated logs, `webEvents` → the browser root
- [ ] 2.4 Resolve parent links to depth; emit rows in render order
- [ ] 2.5 Compute `left` / `width` as percentages of the trace's total bounds
- [ ] 2.6 Assign palette index per service on first appearance; stable across renders
- [ ] 2.7 Flags: root, error (from span status), orphan
- [ ] 2.8 Summary: span count, service count, log count, total duration

## 3. Robustness
- [ ] 3.1 Orphan spans rendered at depth 0 and flagged, never dropped
- [ ] 3.2 Cycles broken deterministically and flagged
- [ ] 3.3 Zero-duration and negative-duration spans clamped to a minimum visible width, flagged
- [ ] 3.4 Malformed JSON returns an error response with a reason
- [ ] 3.5 Span count cap with an explicit truncation flag the UI must surface
- [ ] 3.6 Unit tests for each of the above against crafted fixtures

## 4. Budget
- [ ] 4.1 Bench: 4000-span fixture end to end — worker time recorded, main-thread time asserted at zero beyond the message handler
- [ ] 4.2 Assert the response buffer is transferred, not copied
- [ ] 4.3 Playwright: open a 4000-span trace while measuring INP — assert no long task on the main thread
- [ ] 4.4 Budget rows committed for worker time and main-thread time

## 5. Independent cross-check
- [ ] 5.1 Test that takes a trace id the toolbar rendered and fetches it via the Dash0 MCP `getTraceDetails` tool
- [ ] 5.2 Assert the span sets agree — catches flattening bugs the UI would hide
