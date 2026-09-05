# add-untraced-view

## Why
This tab is the strongest argument for Tier 2, and it is a diagnostic Dash0 cannot produce from
the backend — the un-instrumented request never arrives, so no amount of querying would surface
it.

The SDK instruments `fetch` only, with zero `XMLHttpRequest` coverage, and its
`PropagatorConfig.match` regexes deliberately exclude some fetches. Those are two different
problems with two different fixes, so the UI must never lump them together as "missing".

## What Changes
- Cause classification per untraced request: wrong transport vs. deliberate propagator
  exclusion vs. unknown.
- The coverage tab: `3 of 11` headline, one card per gap with its specific cause.
- The closing note explaining why only the worker can see these.

## Impact
- New capability: `untraced-view`
- New: `src/panel/views/untraced/`, `src/collector/coverage.ts`
- Depends on: `add-sw-correlator`, `add-panel-shell`
