# Design — panel shell

## Why no framework
The handoff specifies every element, and the panel's structure is static — only text, colours
and bar geometry change. A VDOM diff pays for generality that is not used here.

| Option | Cost | Verdict |
| --- | --- | --- |
| Preact + signals (`plan.md`) | ~5 KB + diff per update | Rejected. Diff buys nothing over a static tree |
| Solid | Right model, wrong packaging — build-time transform for one component | Rejected |
| **Hand-rolled signals → direct DOM binding** | ~1.5 KB, no diff | **Chosen** |

The core is three primitives: `signal`, `computed`, `effect`. Bindings write to a text node or
a single style property. Bar geometry is a CSS custom property write, so the browser does the
layout arithmetic and nothing recalculates outside the contained row.

XState stays for `traceMachine` and `authMachine`, where the state genuinely is a machine and
the async coordination is the bug-prone part. `shellMachine` is five fields with no async; it is
hand-rolled and stays in stage 2.

## Isolation
| Option | Verdict |
| --- | --- |
| Closed shadow root + `adoptedStyleSheets` + `contain: layout paint style` | **Chosen.** Host cannot reach in; no rule reaches the host document |
| Same-page iframe | **Disqualified** — a separate document cannot read the host's `PerformanceObserver` entries, which kills Tier 1. Recorded because "iframe = isolation" is the instinct |
| Custom stacking context with a high z-index | Loses to any host `transform`/`filter` ancestor. Native `popover` puts the panel in the top layer instead, which cannot be lost |

## Staging
Stage 1 holds the pill and a click handler that awaits `import('../panel')`. After `settled`,
stage 2 is prefetched inside `scheduler.postTask({priority:'background'})` so the first open is
instant without competing with the page. A failed prefetch is not an error — the click path
imports again.

## Motion
Animate `transform` and `opacity` only. `will-change` is added immediately before the entry
animation and removed on `animationend`; left permanently it costs compositor memory for a
panel that is closed almost always. `prefers-reduced-motion: reduce` drops to an opacity fade.
