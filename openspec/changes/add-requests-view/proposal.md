# add-requests-view

## Why
This is the tab people will actually live in, and the one that streams. Two failure modes to
design out: a row list that re-renders wholesale as entries arrive, and bar geometry computed
in JavaScript on every update.

Both are avoidable. Rows are windowed, and geometry is handed to the browser as two CSS custom
properties on a contained row — so appending a request touches one row's worth of DOM and
recalculates nothing above it.

## What Changes
- Windowed row list: ~30 live rows plus overscan, translated spacer, fixed 21px row height.
- Bar geometry as `--l` / `--w` custom properties; a shared 3000 ms page-relative window.
- Phase segments derived from real `connectStart` / `requestStart` / `responseStart` /
  `responseEnd`, never from synthesized percentages.
- Streaming appends that do not scroll-jump and do not lose selection.
- Trace chip, status colours, duration formatting per handoff §4.

## Impact
- New capability: `requests-view`
- New: `src/panel/views/requests/`, `src/panel/virtual.ts`
- Depends on: `add-panel-shell`, `add-observation-core`
- Adds a budget row: 2000 rows scrolled at 60 fps
