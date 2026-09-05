# add-trace-view

## Why
A trace is not queryable the instant a request finishes, which makes ingest lag the most
bug-prone part of the whole toolbar. Three outcomes must never be conflated: the trace was
found, the trace is not queryable yet, and no span exists at all. A spinner that means all
three is the failure to avoid.

This is also where an invoked-actor state machine earns its keep: the in-flight query must be
cancelled on state exit, so clicking another request can never leave a stale response to arrive
and overwrite the panel.

## What Changes
- `traceMachine` in XState v5, spawned per inspected request.
- Exponential backoff, ceiling of 5 attempts, abort on selection change.
- A tight `timeRange` on every query — the toolbar is the one client that knows the exact
  request timestamp.
- The three panel states, and the correlated-log footer.

## Impact
- New capability: `trace-view`
- New: `src/trace/`, `src/trace/traceMachine.ts`
- Deps: XState v5 — stage 3 only, never on the critical path
- Depends on: `add-trace-layout-worker`, `add-sw-correlator`, `add-panel-shell`
- Blocks: `add-credential-broker` (which supplies the credential this view's query needs)
