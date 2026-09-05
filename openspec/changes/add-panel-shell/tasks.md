# Tasks — panel shell

## 1. Reactive core
- [ ] 1.1 `src/panel/reactive/signal.ts` — `signal`, `computed`, `effect`; synchronous push, no scheduler
- [ ] 1.2 Cycle guard and a dev-only warning on a write inside a computed
- [ ] 1.3 `bind.ts` — `bindText(node, fn)`, `bindStyle(el, prop, fn)`, `bindVar(el, name, fn)`, `bindAttr`
- [ ] 1.4 `list.ts` — keyed list reconciliation, append-only fast path (the streaming case)
- [ ] 1.5 Unit tests: diamond dependency, disposal, no leak after `dispose()`
- [ ] 1.6 `size-limit` row: reactive core ≤ 1.6 KB gzip

## 2. Stage-2 boundary
- [ ] 2.1 Stage 1 opens the panel via `await import('../panel')`; pill shows a pending state if the import is slow
- [ ] 2.2 Background prefetch after `settled` via `scheduler.postTask({priority:'background'})`
- [ ] 2.3 Prefetch failure is non-fatal and silent; the click path retries
- [ ] 2.4 Playwright: assert stage 2 is **not** requested before first open or prefetch
- [ ] 2.5 Playwright: assert prefetch does not overlap the load phase

## 3. Shadow root and styles
- [ ] 3.1 Closed shadow root on `<d0-bar>`; no `part`, no `::slotted`, nothing addressable from the host
- [ ] 3.2 `src/panel/tokens.ts` — vendored token CSS as one `CSSStyleSheet` via `replaceSync`, shared across instances
- [ ] 3.3 Token vendoring script: copy from `design_handoff_d0bar/tokens/`, flatten `@import`, fail the build if a referenced token is missing
- [ ] 3.4 `contain: layout paint style` on the shadow host; assert via the perturbation harness
- [ ] 3.5 `container-type: inline-size` on the panel; sizes respond to the panel, not the viewport
- [ ] 3.6 Assert zero `<style>` / `<link>` added to the host document

## 4. Panel shell chrome
- [ ] 4.1 Panel element as native `popover` (manual), so it renders in the top layer
- [ ] 4.2 CSS anchor positioning tethering panel to pill, progressively enhanced; fixed-offset fallback
- [ ] 4.3 620px fixed width, 12px radius, `--lvl-1-bg`, `--shadow-2xl`, `overflow: hidden` per handoff §2
- [ ] 4.4 Bottom-anchored flex column, `gap: 10px`, pill below panel so the panel grows upward
- [ ] 4.5 Header 42px: "d0bar", current URL in mono, `⌘⇧0` hint, 22px close button with hover state
- [ ] 4.6 Tab row 36px: Requests / Vitals / Untraced, active underline as `inset 0 -2px 0 0 var(--cta-bg)`, right-aligned `buffered: true`
- [ ] 4.7 Untraced badge, hidden at count 0, tab retained
- [ ] 4.8 Responsive: below ~700px viewport, width becomes `calc(100vw - 32px)`; the waterfall column is the first and only column dropped

## 5. Footer observer strip
- [ ] 5.1 32px strip pinned in every view; `white-space: nowrap`, must not wrap at 620px
- [ ] 5.2 Four tier items — `1 PerformanceObserver`, `2 SW`, `3 Server-Timing`, `4 OTel SDK`
- [ ] 5.3 Three dot states: live (`--healthy-bg`), off (`--warning-bg`), planned (hollow ring via inset box-shadow, label at 52% opacity)
- [ ] 5.4 Tier 3 and 4 render as `planned` and are not wired to anything
- [ ] 5.5 Right-aligned perturbation label slot; renders `Δ INP 0.0ms` from a measured value, or `degraded — no trace jump` when tier 2 is off
- [ ] 5.6 Layout test: the row measures ≤ 618px with all four labels; a fifth label must replace, not join

## 6. Tooltips
- [ ] 6.1 Styled popovers, not native `title`: `--lvl-3-bg`, 7px radius, `--shadow-xl`, 7px rotated-square arrow from two borders
- [ ] 6.2 Untraced tooltip, 216px, opens down, arrow at `left: 22px`
- [ ] 6.3 INP tooltip, 268px, opens up, arrow at `right: 22px`
- [ ] 6.4 Tier tooltips, 258px, open up from `left: -8px`, arrow at `left: 14px`; copy carried verbatim from the handoff
- [ ] 6.5 Shown on hover **and on keyboard focus**; dismissed on blur and Escape

## 7. Shell state and keyboard
- [ ] 7.1 `src/panel/shell.ts` — signals for `open`, `view`, `tab`, `sel`, `tip`. No XState
- [ ] 7.2 Everything else derived: tab colours, underline, chip labels, which trace state renders
- [ ] 7.3 `⌘⇧0` toggles; registered in stage 1 so the shortcut works before stage 2 loads
- [ ] 7.4 Escape: from trace view → back to list; from list → close
- [ ] 7.5 Back to list preserves scroll position and active tab
- [ ] 7.6 Focus moves into the panel on open and is restored to the pill on close; focus stays within the panel while open
- [ ] 7.7 Shortcut is configurable, and does not fire while the host page has focus in an editable element

## 8. Motion
- [ ] 8.1 `d0-rise` .18s ease-out (panel) / .12s (tooltip) — `transform` and `opacity` only
- [ ] 8.2 `will-change` added before the animation, removed on `animationend`
- [ ] 8.3 `d0-pulse` 1.1s infinite for the ingest-lag dots, staggered 0 / .18s / .36s
- [ ] 8.4 `prefers-reduced-motion: reduce` → opacity only, no transform, no pulse
