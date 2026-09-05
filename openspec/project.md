# Project: d0bar

## Purpose
`@dash0/d0bar` — an in-page observability toolbar injected into a customer's own web app.
Shows this page's requests, browser-recorded vitals, requests that produced no span, and the
backend trace behind any request.

## Governing constraint
The toolbar must not distort what it measures. Every requirement traces back to this.
Two budgets, tracked separately:

| Budget | Scope | Target |
| --- | --- | --- |
| **A — closed** | ~99.9% of page lifetime. Cost of merely being present. | < 1 ms/s main thread, 0 host layout invalidations, 0 steady-state allocation, < 2 KB gzip on the critical path |
| **B — open** | Seconds, on demand. | No d0bar task > 8 ms; never > 50 ms |

Budget A is the product claim. `PerformanceObserver` callbacks run on the main thread in bursts
during load — exactly when TBT and LCP are measured. Any per-entry allocation or render puts
d0bar's cost in correlation with the numbers it reports.

## Tech stack
- TypeScript, ESM. Vite library build → ESM + IIFE, target `es2022`.
- No UI framework. Hand-rolled signals → direct DOM binding (~1.5 KB). Structure is fully
  specified by the handoff and static; a VDOM diff buys nothing.
- XState v5 **only** for `traceMachine` and `authMachine` (real async coordination). Shell state
  is hand-rolled and lives on the critical path.
- Module Web Worker for OTLP flatten + tree layout. Service Worker for correlation and token
  custody. `documentPictureInPicture` for the detached panel.
- vitest for pure functions; Playwright for anything touching real observers.

## Conventions
- Three load stages. Only stage 1 is on the critical path.
  - **1 — collector**: observers, SoA ring, pill. `src/collector/`.
  - **2 — panel**: dynamic `import()` on first open. `src/panel/`.
  - **3 — trace + auth**: dynamic `import()` on first trace jump. `src/trace/`, `src/auth/`.
- `src/sw/` service worker, `src/worker/` module worker, `bench/` fixtures + budget harness.
- SPDX header on every file, per monorepo convention.
- Design tokens are vendored from `design_handoff_d0bar/tokens/` into one constructed stylesheet.
  Never a `<style>` tag, never a rule in the host document.
- Numbers in the UI come from browser entry fields. d0bar computes no timing of its own.

## Source of truth
- `design_handoff_d0bar/README.md` — high-fidelity visual spec. Authoritative on layout, tokens,
  copy, and the **four**-tier observation stack.
- `plan.md` — architecture narrative. Superseded where it conflicts with the handoff (tier count)
  or with `project.md` (Preact, XState scope).
