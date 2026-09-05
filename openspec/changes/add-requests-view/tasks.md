# Tasks — requests view

## 1. Virtualizer
- [x] 1.1 `src/panel/virtual.ts` — fixed row height 21px, window from `scrollTop`, 6 rows overscan
- [x] 1.2 Spacer element sized to `count * rowHeight`; rows positioned with one `transform: translateY` on the row container
- [x] 1.3 Row elements recycled from a pool — never created per scroll frame
- [x] 1.4 Scroll handler is passive and coalesced to one `rAF` per frame
- [x] 1.5 ~~`content-visibility: auto` on the scroll container~~ — **not done, and it must not be.**
      But marked as such.
      Measured: with `content-visibility: auto` on the scroller, a skipped subtree reports
      `contain-intrinsic-size` as its content extent, so `scrollHeight` was 288px for a
      10,752px list and every restored scroll offset clamped to zero. A probe read `scrollTop`
      0 immediately after a successful write of 840. It also buys nothing here — not creating
      off-screen rows is exactly what the virtualizer already does, and a hidden tab is
      `display: none`, which is free. The task's premise is wrong; the rule is now documented
      against `.rows-scroll` in `panel.css` so it cannot be re-added by someone reading this
      list. `contain: layout style` on the row carries the containment that was actually
      wanted (task 3.7).
- [x] 1.6 `max-height: 288px` per handoff; container queries drive it, not viewport media queries

## 2. Row layout
- [x] 2.1 5-column grid `44px 1fr 40px 54px 210px`, `gap: 10px`, identical template in header and rows
- [x] 2.2 Column header: `trace`, `request`, `status`, `dur` (right-aligned), `0 → 3.0s`
- [x] 2.3 Row padding `3px 14px` (~21px tall), bottom rule `--lvl-1-subtle-stroke`, hover `--lvl-1-hover-bg`
- [x] 2.4 Trace chip strictly 44×15px: `TRACE` / `NONE` with the handoff's `color-mix` backgrounds
- [x] 2.5 Request cell: method fixed 26px, path ellipsized, `xhr` marker only for XHR
- [x] 2.6 Status colours: 2xx healthy, 304 subtle, 5xx error; unknown status renders unlabelled.
      4xx got a tone of its own rather than being folded into 5xx — it is the host's bug or
      the user's, not the network's, and the two send a reader to different places.
- [x] 2.7 Duration: `<1000ms` → `412ms`, else `1.24s` (2 dp), tabular-nums, right-aligned

## 3. Bar geometry
- [x] 3.1 Track 210px × 6px, radius 2px, `--lvl-1-subtle-bg`, `overflow: hidden` so the radius clips segments
- [x] 3.2 Bar positioned from two custom properties: `--l` = `start/3000`, `--w` = `max(1.2%, dur/3000)`
- [x] 3.3 Window is a fixed 3000 ms shared by every row, so bars are directly comparable; window value is a single constant
- [x] 3.4 Phase segments as flex children, widths from real entry timings.
      A fourth segment, `lead`, is emitted for the span between `startTime` and the start of
      the connection — redirects, queueing, worker dispatch. It is deliberately not given a
      phase colour: the entry carries no breakdown of it, and stretching the three measured
      phases to fill from zero would have been the synthesis 3.5 forbids.
- [x] 3.5 Missing phase timings (cross-origin without Timing-Allow-Origin) → single undifferentiated bar, visually distinct from a measured one (hatched)
- [x] 3.6 Error rows render solid `--error-bg`
- [x] 3.7 Update on new data writes only `--l` / `--w`; the row carries `contain: layout style`
      so the recalculation cannot escape it. **The containment is structural; the "assert no
      style recalculation outside the row" half is not asserted** — proving it needs a
      recalculation counter this repo has no harness for yet.

## 4. Streaming
- [x] 4.1 Appends use the list's append-only path — no full reconciliation
- [x] 4.2 Appending while scrolled does not move the viewport, in both cases: appends below
      the viewport leave the offset alone, and eviction from a full ring moves the offset *and*
      the selection down with the records, so the user keeps reading the same rows
- [x] 4.3 A selected row keeps its selection across appends; a selection whose record falls
      out of the ring resolves to "nothing selected" rather than to whichever record inherited
      its index
- [x] 4.4 Updates coalesced to one `rAF`; suppressed entirely while the panel is closed, the
      tab is elsewhere, or the document is hidden
- [x] 4.5 Dropped-entry notice rendered when the ring reported loss

## 5. Interaction
- [x] 5.1 Row click opens the trace view for that request and records `sel`
- [x] 5.2 Rows are keyboard reachable; Enter opens; roving tabindex within the list
      (Arrow keys, Home and End move it; the list is one tab stop, so the row pool cannot
      flood the panel's focus trap)
- [x] 5.3 Rows expose accessible names covering method, path, status and duration — including
      the absences, spelled out as "method unknown" / "status unknown" rather than omitted

## 6. Budget
- [ ] 6.1 **Partly done.** `tests/perf/requests-view.spec.ts` scrolls the full list three times
      and asserts no long animation frame, and asserts the row count stays ≤ 27 for ~310
      records. Two gaps: the fixture produces ~310 records against a 512-record ring, so
      **2000 rows is not reachable in the browser at all** — the 2000-row case is settled
      arithmetically in `tests/unit/virtual.test.ts` instead; and a long-animation-frame entry
      covers the whole frame, so this bounds total main-thread work rather than d0bar's share
      of it. Attributing the cost needs script attribution from `add-self-attribution`.
- [ ] 6.2 **Not done.** The append-storm bench (300 appends over 3 s with the panel open) is
      not written. The no-scroll-jump half of it is covered by the streaming test in
      `tests/perf/requests-view.spec.ts` and by the eviction tests in
      `tests/unit/requests-view.test.ts`; the per-frame cost under a sustained append storm is
      not measured.
- [ ] 6.3 Not done — depends on 6.1 and 6.2 producing numbers worth committing. The two budget
      rows that *were* touched are the bundle sizes, both with written rationale: stage 1
      5.77 → 6.25 kB (limit unchanged at 6.5), stage 2 6.83 → 9.83 kB with the limit raised
      8 → 10.5 kB.
