# Tasks — requests view

## 1. Virtualizer
- [ ] 1.1 `src/panel/virtual.ts` — fixed row height 21px, window from `scrollTop`, 6 rows overscan
- [ ] 1.2 Spacer element sized to `count * rowHeight`; rows positioned with one `transform: translateY` on the row container
- [ ] 1.3 Row elements recycled from a pool — never created per scroll frame
- [ ] 1.4 Scroll handler is passive and coalesced to one `rAF` per frame
- [ ] 1.5 `content-visibility: auto` on the scroll container; `contain-intrinsic-size` set so scrollbar geometry is stable
- [ ] 1.6 `max-height: 288px` per handoff; container queries drive it, not viewport media queries

## 2. Row layout
- [ ] 2.1 5-column grid `44px 1fr 40px 54px 210px`, `gap: 10px`, identical template in header and rows
- [ ] 2.2 Column header: `trace`, `request`, `status`, `dur` (right-aligned), `0 → 3.0s`
- [ ] 2.3 Row padding `3px 14px` (~21px tall), bottom rule `--lvl-1-subtle-stroke`, hover `--lvl-1-hover-bg`
- [ ] 2.4 Trace chip strictly 44×15px: `TRACE` / `NONE` with the handoff's `color-mix` backgrounds
- [ ] 2.5 Request cell: method fixed 26px, path ellipsized, `xhr` marker only for XHR
- [ ] 2.6 Status colours: 2xx healthy, 304 subtle, 5xx error; unknown status renders unlabelled
- [ ] 2.7 Duration: `<1000ms` → `412ms`, else `1.24s` (2 dp), tabular-nums, right-aligned

## 3. Bar geometry
- [ ] 3.1 Track 210px × 6px, radius 2px, `--lvl-1-subtle-bg`, `overflow: hidden` so the radius clips segments
- [ ] 3.2 Bar positioned from two custom properties: `--l` = `start/3000`, `--w` = `max(1.2%, dur/3000)`
- [ ] 3.3 Window is a fixed 3000 ms shared by every row, so bars are directly comparable; window value is a single constant
- [ ] 3.4 Phase segments as flex children, widths from real entry timings: connect (`--neutral-500`), wait (`--purple-500`), transfer (`--light-blue-600`)
- [ ] 3.5 Missing phase timings (cross-origin without Timing-Allow-Origin) → single undifferentiated bar, visually distinct from a measured one
- [ ] 3.6 Error rows render solid `--error-bg`
- [ ] 3.7 Update on new data writes only `--l` / `--w`; assert no style recalculation outside the row

## 4. Streaming
- [ ] 4.1 Appends use the list's append-only path — no full reconciliation
- [ ] 4.2 Appending while scrolled does not move the viewport (anchor on the top visible row)
- [ ] 4.3 A selected row keeps its selection across appends and re-sorts
- [ ] 4.4 Updates coalesced to one `rAF`; suppressed entirely while the panel is closed or the document is hidden
- [ ] 4.5 Dropped-entry notice rendered when the ring reported loss

## 5. Interaction
- [ ] 5.1 Row click opens the trace view for that request and records `sel`
- [ ] 5.2 Rows are keyboard reachable; Enter opens; roving tabindex within the list
- [ ] 5.3 Rows expose accessible names covering method, path, status and duration

## 6. Budget
- [ ] 6.1 Bench: 2000 rows, continuous scroll — no frame over 8 ms of d0bar work
- [ ] 6.2 Bench: 300 appends over 3 s while open — no frame over 8 ms, zero scroll jump
- [ ] 6.3 Both recorded as rows in `bench/budget.json`
