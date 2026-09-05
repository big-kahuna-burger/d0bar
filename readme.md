# d0bar

**An in-page observability toolbar that does not distort what it measures.**

[![size](https://img.shields.io/badge/stage%201-4.87%20kB%20gzip-blue)](.size-limit.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```bash
npm i d0bar
```

```html
<script src="/d0bar.iife.js" data-d0bar-enabled defer></script>
```

That's it. A pill appears in the corner of your app showing request count and your worst Core
Web Vital. Click it for the full panel.

---

## Who this is for

**You, if you have ever asked "why is this page slow?" while looking at someone's staging
environment on a phone, on hotel wifi, with no devtools.**

Concretely, d0bar is for:

- **Frontend engineers** debugging performance in an environment where devtools aren't
  practical — a tablet, a kiosk, a colleague's machine, a QA device, a production incident at
  2am on a laptop you don't own.
- **Teams shipping to real users** who want the numbers their users actually experience, in
  the page, rather than a synthetic run in a datacenter.
- **Anyone instrumenting with OpenTelemetry** who wants to see which requests are traced,
  which are not, and jump from a slow request to its trace.
- **People who don't trust performance tools** — reasonably. See below.

**This is probably not for you if** you are profiling a build step, need a flame graph of your
own JavaScript (use devtools — it's better at that and always will be), or want a
production-wide RUM product. d0bar shows you *this* page, *this* session, right now.

---

## Why it exists

Most in-page performance tools patch `fetch`, flatten a trace on the main thread, and add
40 ms to your INP. Then they show you your INP.

That is not a small flaw. It is the tool being wrong about the only thing it claims to know.

d0bar is built around one constraint — **it must not distort what it measures** — and that
single rule explains every design decision in it:

| | |
| --- | --- |
| **Nothing is patched** | Not `fetch`, not `XMLHttpRequest`, not `history`. The browser already records every request with a full timing breakdown; d0bar reads that. Asserted in CI with strict identity checks. |
| **Zero event listeners on your page** | Load, visibility and first input all arrive as performance entries instead. Verified through the browser's real listener registry via CDP, not by counting our own calls. |
| **Nothing runs during load** | Until your LCP is final, the only permitted work is writing a number into a preallocated buffer. No derivation, no DOM, no network. A development guard throws if anything tries. |
| **No allocation in the hot path** | Requests go into a fixed struct-of-arrays ring over one `ArrayBuffer`. URLs are interned to integers. GC pressure from the toolbar can't correlate with the numbers it reports. |
| **The panel isn't there until you open it** | 4.87 kB gzip on your critical path. The panel is a separate 3.08 kB file fetched on first click. |
| **Absence is disclosed, never guessed** | If the browser doesn't report a cache status, d0bar says the value was inferred. If attribution is missing, it says so instead of naming a likely element. |

The claim is tested, not asserted. `bench/` runs the same hostile fixture with the toolbar on
and off, 20+ alternating runs, and compares **p95** deltas — a toolbar that is usually free
and occasionally costs 40 ms is not free, and a mean hides exactly that.

Current measured deltas, toolbar on vs off: **INP 0 · TBT 0 · CLS 0 · long tasks 0.**

---

## Install

```bash
npm i d0bar        # pnpm add d0bar · yarn add d0bar
```

**Script tag** — nothing to configure:

```html
<script src="/d0bar.iife.js" data-d0bar-enabled defer></script>
```

**ES module** — explicit opt-in:

```ts
import { init } from "d0bar";

if (import.meta.env.DEV) {
  init({ enabled: true });
}
```

Without `data-d0bar-enabled` or `init({ enabled: true })` the bundle loads and does **nothing
at all** — no observers, no DOM, no network. That inert path is asserted in CI, so shipping
d0bar to production behind a flag is safe by construction.

`init()` returns a handle with `destroy()` and `diagnostics()`.

---

## What you see

A pill in the corner: request count, worst vital, and a count of dropped records if the ring
overflowed. Click it for the panel:

- **Requests** — a waterfall with real phase timings, cache status, and status codes.
- **Vitals** — LCP, CLS, INP and long animation frames, with the browser's own attribution.
- **Untraced** — requests that left your app without trace context, which is usually the
  reason a trace has a hole in it.
- **Footer** — which of the four observation tiers are actually live, so you always know the
  provenance of what you're looking at.

---

## Browser support

Chrome and Edge get everything. Firefox and Safari get tier-1 observation and degrade
honestly — the UI tells you which capabilities are missing rather than silently showing you
less. d0bar never claims a measurement it did not take.

---

## Related

**[⚡ spark-signals](packages/spark)** — the ~1 kB signals core built for d0bar's panel, published
separately because it's useful on its own. No virtual DOM, no scheduler, no framework.

---

## Development

```bash
pnpm install
pnpm dev              # fixture at :8732 with live reload
pnpm test             # unit tests
pnpm test:perf        # the A/B observer-effect budget
pnpm size             # bundle budgets
```

`?d0bar=on`, `?d0bar=gated` and `?d0bar=off` select the three benchmark arms.

Architecture, including the ring layout and the epoch model, is in
**[architecture.md](architecture.md)**.

---

## Glossary

Terms that carry a specific meaning in this codebase. Where a word has a loose industry
meaning and a precise one here, the precise one wins.

### The constraint

**Observer effect** — the amount by which the toolbar's presence changes the host page's own
numbers. The thing this project exists to keep at zero. Measured, not asserted: see
`bench/README.md`.

**Budget A (closed / ambient)** — what every page load pays whether or not anyone opens the
panel. The dominant risk, and the one that is gated in CI. Must be indistinguishable from zero.

**Budget B (open / active)** — what a developer pays while deliberately looking at the numbers.
Allowed to cost something; they asked for it.

**Perturbation** — any effect on the host page that is not reading. Patching a global, adding
a listener, adding a stylesheet, writing to storage. Distinct from *cost*: a change can be
free in milliseconds and still be perturbation.

**Non-perturbation suite** — `tests/perf/non-perturbation.spec.ts`. Asserts properties a timing
budget cannot express, such as `window.fetch` being strictly `===` to its original value.

### Lifecycle

**Load phase** — page start until LCP is final. During it the only permitted work is a ring
write: no derivation, no DOM, no worker message, no fetch.

**Moratorium** — the rule enforcing that. Free because every observer uses `buffered: true`, so
deferring loses no data.

**Settle** — the moment the moratorium lifts. Reached when LCP has gone quiet for 500 ms after
load, or at a 10-second ceiling. **Not** the load event: an app that renders its largest element
from JavaScript reports LCP long after load.

**LCP quiet period** — the 500 ms without a new `largest-contentful-paint` entry that is taken
as the browser having stopped raising it.

**`assertSettled`** — the development-only guard. Anything that derives, touches the DOM, posts
to a worker or fetches calls it first, so a moratorium violation throws in development instead
of silently costing a customer main-thread time in production.

### Storage

**Ring** — the request store: struct-of-arrays over one preallocated `ArrayBuffer`, fixed at
512 records. Allocation-free on the write path.

**Struct-of-arrays (SoA)** — one typed array per *field* rather than one object per record. A
record is a slot index read across every column, not a contiguous struct.

**Slot** — a record's index within the ring, `written & 511`. Reused on wraparound.

**Stride** — the bytes one record occupies across all columns. Currently 88.

**Dropped** — records lost to overflow. Counted and surfaced, never hidden: a truncated list is
not presented as complete.

**Interning** — mapping a repeated string to a `u32` id. URLs repeat heavily, and strings are
the only allocation source in the hot path, so interning makes the load-phase path
allocation-free on a cache hit.

**`ABSENT`** — the intern id meaning "no value", as distinct from the empty string. Used where
the browser genuinely does not report a field, such as a request method.

**Scratch record** — a caller-owned object that `read()` fills, rather than returning a fresh
one. Rendering virtualized rows therefore allocates nothing per frame.

### Epochs

**Epoch** — the time window a view scopes to. On a multi-page app that is the document; on a
single-page app it is a route.

**`navigationId`** — the browser's own epoch id, stamped on *every* `PerformanceEntry`. Read
rather than derived, because it is correct for entries buffered from before the toolbar
mounted, and because the interaction that *causes* a navigation correctly stays in the old
epoch despite sharing its timestamp.

**Soft navigation** — a route change the browser itself recognises: interaction → URL change →
contentful paint. Chrome's definition, adopted rather than second-guessed. A route change that
paints nothing new produces no entry.

**Epoch tier** — which of three sources supplied the boundaries: `soft-navigation` entries,
the Navigation API's `currententrychange`, or a single document-lifetime epoch. Disclosed in
the UI, because tier 3 means there is exactly one epoch and it is the page.

**Context id** — a handle into a side table holding W3C trace context. A trace id is 16 bytes
and cannot live in a `u32`, so the ring stores the handle — the same indirection URLs use.

### Provenance

**Tier** (observation) — which source a measurement came from: `PerformanceObserver`, a service
worker, `Server-Timing`, or the host's own OTel SDK. Each degrades independently.

**Reported vs inferred** — whether the browser stated a value or the toolbar deduced it.
`deliveryType` reports cache status; `transferSize === 0 && encodedBodySize > 0` infers it, and
a 304 produces the same shape. Inferred values are flagged (`F_CACHE_INFERRED`) and must not be
rendered with equal confidence.

**Honest degradation** — the rule that an absent capability is disclosed rather than papered
over. If attribution is missing the UI says so instead of naming a likely element.

**`F_NO_PHASES`** — a cross-origin response without `Timing-Allow-Origin`, whose phase
timestamps the browser zeroes. Drawn as one undifferentiated bar rather than invented
proportions.

### Build & test

**Arm** — one side of the A/B benchmark. `off` omits the bundle, `gated` loads it without
starting it, `on` runs it. `gated` is the honest baseline: it controls for the script download.

**Fixture** — `bench/fixtures/host/`, a page that is already struggling, so the toolbar is
measured under realistic pressure. It is the measuring *instrument* and is identical in both
arms — never part of what is measured.

**p95, never the mean** — how deltas are compared. A toolbar that is usually free and
occasionally costs 40 ms is not free, and a mean hides exactly that.

**Stage 1 / 2 / 3** — the delivery split. Stage 1 (collector + pill) is the only thing on a
host page's critical path and is measured alone. Stage 2 is the panel, loaded on first open.

---

## License

[MIT](LICENSE).
