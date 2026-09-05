# Tasks — observation core

## 1. Package scaffold
- [x] 1.1 `package.json`: name `@dash0/d0bar`, `type: module`, `sideEffects: false`, exports map — `.` (ESM), `./iife`, `./sw`
- [x] 1.2 Vite library build, `target: es2022`, formats `["es","iife"]`, no polyfills, no vendor chunk in stage 1
- [x] 1.3 Three-stage entry contract: `src/collector/index.ts` (stage 1) statically imports nothing from `src/panel/` or `src/trace/`
- [x] 1.4 ESLint rule banning static imports from stage 2/3 inside `src/collector/**`
- [x] 1.5 vitest (node, pure functions) + Playwright project (anything touching real observers)
- [ ] 1.6 ESLint + Prettier + SPDX header check in CI
- [x] 1.7 `size-limit` gate, thresholds in `bench/budget.json`. CI fails over budget

## 2. String interning
- [x] 2.1 `src/shared/intern.ts` — `intern(s): u32`, `str(id): string`; 0 = absent, 1 = saturated, real ids from 2
- [x] 2.2 Cap table at 4096; past cap return `OVERFLOW_ID` and set a counter
- [x] 2.3 Unit tests: id stability across calls, round-trip, cap behaviour, 0 reserved

## 3. Ring buffer
- [x] 3.1 `src/collector/ring.ts` — single `ArrayBuffer`, SoA views, capacity 512, mask indexing
- [x] 3.2 Field table and byte offsets per `design.md`; `FLAGS` as named bit constants
- [x] 3.3 `push(entry)`: typed-array writes only, no object literal, no closure allocation
- [x] 3.4 `head` / `count` / `dropped` counters maintained incrementally — never a scan
- [x] 3.5 Overflow overwrites oldest and increments `dropped`
- [x] 3.6 Reader API: `at(i)` fills a caller-owned scratch object (no allocation per read)
- [ ] 3.7 Bench: `push()` p99 < 200 ns on the CI machine class; recorded as a baseline artifact

## 4. Tier 1 observers
- [x] 4.1 `src/collector/observe.ts` — one `PerformanceObserver` per entry type, each in its own try/catch (Safari throws on unknown types)
- [x] 4.2 `resource` with `buffered: true` → `ring.push`
- [x] 4.3 Feature-detect `responseStatus`; when absent set `STATUS_UNKNOWN` and leave `status` at 0
- [x] 4.4 Derive phase segments from `connectStart` / `requestStart` / `responseStart` / `responseEnd`; never synthesize percentages
- [x] 4.5 Classify initiator → `XHR` flag from `initiatorType === 'xmlhttprequest'`
- [x] 4.6 `largest-contentful-paint`, `layout-shift`, `event` (`durationThreshold: 40`), `long-animation-frame`, `navigation` → vitals slots, attribution fields retained
- [x] 4.7 `ReportingObserver` (`buffered: true`) for deprecation / intervention / csp-violation
- [ ] 4.8 `destroy()` disconnects every observer and removes every listener; assert zero remaining

## 5. Load-phase moratorium
- [x] 5.1 `src/collector/phase.ts` — `collecting` → `settled`, transition per `design.md`
- [x] 5.2 `assertCollecting()` dev-only guard that throws if derive/DOM/postMessage is attempted while `collecting`
- [x] 5.3 Flush scheduler: `scheduler.postTask({priority:'background', signal})`, `requestIdleCallback` fallback, `setTimeout` only as a declared last resort reported in diagnostics
- [x] 5.4 Playwright: fixture fires 300 requests; assert **zero** mutations on the d0bar root before `settled` (MutationObserver on the host)
- [ ] 5.5 Playwright: assert zero `postMessage` and zero `fetch` from d0bar before `settled`

## 6. Collapsed pill
- [x] 6.1 `<d0-bar>` custom element, **closed** shadow root, `adoptedStyleSheets` only
- [x] 6.2 One constructed stylesheet built from the vendored tokens; assert zero `<style>` and zero `<link>` added to the host document
- [x] 6.3 Host styles: `position: fixed; left: 24px; bottom: 22px`, `contain: layout paint style`
- [x] 6.4 Pill per handoff §1 — 34px, logo ring + dot, req count, divider, worst-vital dot + value, untraced badge (hidden at 0)
- [x] 6.5 Worst-vital bucket from a threshold table (healthy / warning / error); dot colour follows it
- [x] 6.6 Text updates coalesced to ≥500 ms, and only when `settled` **and** `visibilityState === 'visible'`
- [x] 6.7 Counts read from ring counters, never a scan
- [x] 6.8 `prefers-reduced-motion` honoured

## 7. Opt-in gate
- [x] 7.1 `init(config)` is the only entry point; ESM export does nothing on import
- [x] 7.2 IIFE build reads config from `data-*` attributes on its own `<script>` tag
- [x] 7.3 Not enabled → zero observers, zero DOM nodes, zero network, zero storage
- [x] 7.4 Playwright non-regression: gate off, assert `fetch` identical to a pristine iframe's `fetch`, `document.styleSheets` unchanged, no registered worker
