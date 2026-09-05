# add-vitals-view

## Why
The vitals tab's whole claim is provenance: every number is the browser's own, with the
browser's own attribution. That makes the implementation rule unusually strict — if an
attribution field is absent, the UI says so rather than describing the element it guesses at.

## What Changes
- Four cards — LCP, CLS, INP, LoAF — with values coloured by threshold bucket.
- Attribution lines built only from real entry attribution fields.
- The provenance note, verbatim from the handoff.

## Impact
- New capability: `vitals-view`
- New: `src/panel/views/vitals/`, `src/collector/vitals.ts`
- Depends on: `add-panel-shell`, `add-observation-core`
