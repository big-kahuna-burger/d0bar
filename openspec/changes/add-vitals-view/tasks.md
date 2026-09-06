# Tasks — vitals view

## 1. Vitals accumulation
- [x] 1.1 `src/collector/vitals.ts` — fixed-size slots, no growth: LCP (last), CLS (running sum of non-recent-input shifts), INP (98th percentile of interaction latencies per the standard definition), LoAF (count + longest)
- [x] 1.2 Session-window CLS grouping per the standard definition, not a naive total
- [x] 1.3 Retain only the attribution fields the UI shows; drop entry references so nothing is held alive
- [x] 1.4 LCP stops accruing at the first of interaction or hidden. **`load` is deliberately
      not a seal, and neither is the moratorium's quiet timer** — both are d0bar's own settle
      heuristics, not the standard's definition, and a page that paints something larger 600 ms
      after load with nobody touching it has a larger LCP. Sealing there would report a smaller
      number than the browser's own tooling for the same load, which is the failure this whole
      surface exists to avoid. `phase.ts` already said as much in its module header; this makes
      `vitals.ts` agree with it. The seal is a *timestamp*, not a boolean: observers use
      `buffered: true`, so mounting after an interaction delivers every candidate at once, and a
      boolean seal would drop all of them and report no LCP on a page that plainly had one.
- [x] 1.5 `tests/unit/vitals-reference.test.ts`, 10 tests, against a real dump recorded from
      the bench fixture by `scripts/record-vitals-fixture.mjs` — 2 LCP candidates, a layout shift
      with three sources, 11 event entries, a long frame. The reference implementation is written
      from the standard definitions rather than from `vitals.ts`, since deriving it from the code
      would test that the code equals itself. **The dump is thin on CLS**: one shift, so it
      exercises session-window grouping not at all; that stays covered synthetically in
      `vitals.test.ts`. Recorder note: the first version used `getEntriesByType` and produced a
      dump with two long frames and nothing else — the other three types are observer-only.

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
- [x] 4.1 `tests/unit/vitals-accumulation.test.ts` — 500 entries, warm pass discarded.
      **0.107 / 0.114 / 0.118 / 0.114 µs per entry** across four runs; recorded in
      `bench/budget.json` under `vitals` as reported-not-gated, because a tenth of a microsecond
      is dominated by whatever else the machine is doing. The test carries a 5 µs ceiling, which
      catches a category change rather than drift.
- [x] 4.2 Asserted structurally, **not measured on the heap, and the reason is recorded rather
      than glossed**: forcing a GC and diffing `heapUsed` needs `--expose-gc`, which `pnpm test`
      does not pass, and a test that skips itself without the flag is green on every machine that
      never ran it. `selectorOf` is the only allocation on this path, so the test hands the
      accumulator nodes whose `tagName` is a counted getter — 499 shifts that beat nothing must
      produce zero reads, and a shift after recent input must produce zero from the first. Node
      retention is asserted by mutating each node after accumulation and confirming the snapshot
      does not follow: a stored node would, a derived string cannot.
