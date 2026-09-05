# Tasks — vitals view

## 1. Vitals accumulation
- [x] 1.1 `src/collector/vitals.ts` — fixed-size slots, no growth: LCP (last), CLS (running sum of non-recent-input shifts), INP (98th percentile of interaction latencies per the standard definition), LoAF (count + longest)
- [x] 1.2 Session-window CLS grouping per the standard definition, not a naive total
- [x] 1.3 Retain only the attribution fields the UI shows; drop entry references so nothing is held alive
- [ ] 1.4 LCP finalization on first input / hidden / load, consistent with the moratorium trigger
- [ ] 1.5 Unit tests against a recorded entry dump, asserting values match a reference implementation

## 2. Attribution
- [x] 2.1 LCP: element selector from the entry's `element`, plus `TTFB` from the navigation entry
- [x] 2.2 CLS: largest shift's `sources[0].node` selector
- [x] 2.3 INP: `event` entry `target` selector
- [x] 2.4 LoAF: longest frame duration plus its dominant script's `sourceFunctionName`
- [x] 2.5 Selector generation is bounded — never walks the whole tree, never retains the node
- [x] 2.6 Absent attribution renders as `attribution unavailable`; never inferred

## 3. Cards
- [x] 3.1 `repeat(4, 1fr)`, `gap: 10px`, `--lvl-2-bg`, 8px radius, padding `10px 12px`
- [x] 3.2 Name 10px mono subtle; value 20px mono tabular-nums; attribution 11px sans, line-height 1.35
- [x] 3.3 Threshold table per vital → healthy / warning / error colour; LoAF count uses the neutral intense colour
- [x] 3.4 Provenance note block, copy verbatim from handoff §5
- [x] 3.5 Values update live while the panel is open, coalesced to one `rAF`

## 4. Budget
- [ ] 4.1 Bench: 500 `layout-shift` entries — accumulation cost per entry recorded
- [ ] 4.2 Assert vitals accumulation performs no allocation per entry
