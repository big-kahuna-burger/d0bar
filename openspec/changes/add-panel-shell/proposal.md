# add-panel-shell

## Why
The shell is the layer that must never break a customer's page, and it is the layer that must
not exist on their critical path. Two things follow: isolation comes from the platform rather
than from convention, and none of this code loads until someone opens the panel.

`buffered: true` already means late mounting loses nothing. That turns lazy loading from a
trade-off into a free win.

## What Changes
- Stage-2 boundary: `import()` on first open, prefetched at background priority once settled.
- A ~1.5 KB signals core with direct DOM binding. No UI framework.
- Closed shadow root, `adoptedStyleSheets`, vendored tokens as one constructed stylesheet.
- Native `popover` for the panel — the browser's top layer ends the z-index war outright.
- `contain: layout paint style`; container queries so the panel responds to its own size.
- Hand-rolled shell state: `open`, `view`, `tab`, `sel`, `tip`.
- Header, tab row, footer observer strip (four tiers, live / off / planned), the two tooltips.
- Keyboard: `⌘⇧0` toggles, Escape goes back then closes. Focus captured and restored.

## Impact
- New capability: `panel-shell`
- New: `src/panel/`, `src/panel/reactive/`, `src/panel/tokens.ts`
- Deps: none. **Reverses `plan.md`'s Preact and XState-for-the-shell choices** — see `design.md`
- Blocks: `add-requests-view`, `add-vitals-view`, `add-untraced-view`, `add-trace-view`, `add-panel-detach`
- Δ INP value in the footer strip is supplied later by `add-self-attribution`; until then the
  slot renders from a measured zero
