# Tasks — panel shell

## 1. Reactive core

> The core lives in `packages/spark/` (published as `spark-signals`), not under `src/panel/`.
> It is useful on its own and nothing in it is d0bar-specific, so it is a workspace package
> with its own tests and size budget. Paths below were corrected to match.

- [x] 1.1 `packages/spark/src/signal.ts` — `signal`, `computed`, `effect`; synchronous push, no scheduler
- [x] 1.2 Cycle guard and a dev-only warning on a write inside a computed
- [x] 1.3 `bind.ts` — `bindText(node, fn)`, `bindStyle(el, prop, fn)`, `bindVar(el, name, fn)`, `bindAttr`
- [x] 1.4 `list.ts` — keyed list reconciliation, append-only fast path (the streaming case)
- [x] 1.5 Unit tests: diamond dependency, disposal, no leak after `dispose()`
- [x] 1.6 `size-limit` row: reactive core ≤ 1.6 KB gzip (measured 1.11 kB)

## 2. Stage-2 boundary
- [x] 2.1 Stage 1 opens the panel via `await import('../panel')`; pill shows a pending state if the import is slow
- [x] 2.2 Background prefetch after `settled` via `scheduler.postTask({priority:'background'})`
- [x] 2.3 Prefetch failure is non-fatal and silent; the click path retries
- [x] 2.4 Playwright: assert stage 2 is **not** requested before first open or prefetch — `tests/perf/stage2.spec.ts`, also covering the gated arm and the click/prefetch race
- [x] 2.5 Playwright: assert prefetch does not overlap the load phase

## 3. Shadow root and styles
- [x] 3.1 Closed shadow root on `<d0-bar>`; no `part`, no `::slotted`, nothing addressable from the host
- [x] 3.2 `src/panel/tokens.ts` — vendored token CSS as one `CSSStyleSheet` via `replaceSync`, shared across instances
- [x] 3.3 Token vendoring script: copy from `design_handoff_d0bar/tokens/`, flatten `@import`, fail the build if a referenced token is missing
- [x] 3.4 `contain: layout paint style` on the shadow host; asserted in `tests/perf/panel-shell.spec.ts`. The *panel* deliberately drops `paint` — see 4.3 — and that is asserted too
- [x] 3.5 `container-type: inline-size` on the panel; sizes respond to the panel, not the viewport
- [x] 3.6 Assert zero `<style>` / `<link>` added to the host document

## 4. Panel shell chrome
- [x] 4.1 Panel element as native `popover` (manual), so it renders in the top layer
- [x] 4.2 CSS anchor positioning tethering panel to pill, progressively enhanced; fixed-offset fallback
- [x] 4.3 620px fixed width, 12px radius, `--lvl-1-bg`, `--shadow-2xl` per handoff §2. **Not**
      `overflow: hidden`: it clips every tooltip to the panel, and a tab-row bubble on a short
      panel hangs below the body. `clip-path` clips descendants too, and `contain: paint` is a
      third clip with the same effect — so the panel drops `paint` from its containment and the
      edge rows round their own outer corners instead. The corner is identical; the bubbles
      survive. Paint isolation from the host is unaffected: the panel is a top-layer popover.
- [x] 4.4 Bottom-anchored flex column, `gap: 10px`, pill below panel so the panel grows upward
- [x] 4.5 Header 42px: "d0bar", current URL in mono, `⌘⇧0` hint, 22px close button with hover state
- [x] 4.6 Tab row 36px: Requests / Vitals / Untraced, active underline as `inset 0 -2px 0 0 var(--cta-bg)`, right-aligned `buffered: true`
- [x] 4.7 Untraced badge, hidden at count 0, tab retained
- [x] 4.8 Responsive: below ~700px viewport, width becomes `min(620px, calc(100vw - 32px))` — the
      handoff's bare `calc` resolves *wider* than the design width between 652px and 700px, so
      the panel would have grown as the viewport shrank into the query. The waterfall column is
      dropped by a **container** query on the panel's own inline size, not the viewport: the
      panel is detachable into Picture-in-Picture, where the viewport describes the wrong box.
      Threshold 560px (track 210px + ~350px of columns), not the design width — a container
      query measures the content box, so 620px presents as 618px and a 619px threshold fired at
      full size. Cells opt in with `data-col="waterfall"`; asserted in `tests/perf/panel-shell.spec.ts`

## 5. Footer observer strip
- [x] 5.1 32px strip pinned in every view; `white-space: nowrap`, must not wrap at 620px
- [x] 5.2 Four tier items — `1 PerformanceObserver`, `2 SW`, `3 Server-Timing`, `4 OTel SDK`
- [x] 5.3 Three dot states: live (`--healthy-bg`), off (`--warning-bg`), planned (hollow ring via inset box-shadow, label at 52% opacity)
- [x] 5.4 Tier 3 and 4 render as `planned` and are not wired to anything
- [x] 5.5 Right-aligned perturbation label slot, derived in `shell.ts` from `tier2Live` and
      `inpDelta` so the ladder is testable without a browser. Three readings, not two: degraded
      outranks any measurement, and an *unmeasured* cost renders `Δ INP unavailable` rather than
      `Δ INP 0.0ms` — zero is a claim the toolbar cost nothing, which is the one number it must
      not invent. `add-self-attribution` supplies the value. Tier 2 is now a signal, so losing
      the scope after mount updates the dot, the label (`2 SW off`) and the reading together
- [x] 5.6 Layout test: the row measures ≤ 618px with all four labels; a fifth label must replace, not join

## 6. Tooltips
- [x] 6.1 Styled popovers, not native `title`: `--lvl-3-bg`, 7px radius, `--shadow-xl`, 7px rotated-square arrow from two borders
- [x] 6.2 Untraced tooltip, 216px, opens down, arrow at `left: 22px`
- [x] 6.3 INP tooltip, 268px, opens up, arrow at `right: 22px`
- [x] 6.4 Tier tooltips, 258px, open up from `left: -8px`, arrow at `left: 14px`; copy carried verbatim from the handoff
- [x] 6.5 Shown on hover **and on keyboard focus**; dismissed on blur and Escape

## 7. Shell state and keyboard
- [x] 7.1 `src/panel/shell.ts` — signals for `open`, `view`, `tab`, `sel`, `tip`. No XState
- [x] 7.2 Everything else derived: tab colours, underline, chip labels, which trace state renders
- [x] 7.3 `⌘⇧0` toggles; registered in stage 1 so the shortcut works before stage 2 loads. This is the toolbar's **one** listener on the host page — the zero-listener invariant was narrowed to a named allow-list rather than quietly dropped, and `data-d0bar-shortcut="off"` restores it to zero
- [x] 7.4 Escape: from trace view → back to list; from list → close
- [x] 7.5 Back to list preserves scroll position and active tab. Offset is tracked continuously
      through a passive `scroll` listener into `rememberScroll`, not captured on the way out —
      the list is virtualized, so by the time the exit is observed the rows are gone and
      `scrollTop` reads zero. Restored unconditionally, including zero, or a fresh tab inherits
      its neighbour's offset
- [x] 7.6 Focus moves into the panel on open and is restored to the pill on close; focus stays within the panel while open
- [x] 7.7 Shortcut is configurable (`shortcut:` / `data-d0bar-shortcut`), matched on `event.code` so it is layout-independent, bubble-phase so the host can claim the chord first, and never fires into an editable target — including one inside the host's own shadow DOM

## 8. Motion
- [x] 8.1 `d0-rise` .18s ease-out (panel) / .12s (tooltip) — `transform` and `opacity` only
- [x] 8.2 `will-change` added before the animation, removed on `animationend`
- [x] 8.3 `d0-pulse` (`opacity .35 → 1 → .35`, 1.1s ease-in-out infinite) for the ingest-lag
      dots, staggered 0 / .18s / .36s, and stopped outright under reduced motion — an infinite
      animation is the one kind waiting does not escape. The keyframe and `.lag-dot` ship here;
      the 7c layout that uses them belongs to `add-trace-view`
- [x] 8.4 `prefers-reduced-motion: reduce` → opacity only, no transform, no pulse
