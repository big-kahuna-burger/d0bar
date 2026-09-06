# d0bar

**An in-page observability toolbar that does not distort what it measures.**

[![size](https://img.shields.io/badge/stage%201-5.47%20kB%20gzip-blue)](.size-limit.json)
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
production-wide RUM product. d0bar shows you _this_ page, _this_ session, right now.

---

## Why it exists

Most in-page performance tools patch `fetch`, flatten a trace on the main thread, and add
40 ms to your INP. Then they show you your INP.

That is not a small flaw. It is the tool being wrong about the only thing it claims to know.

d0bar is built around one constraint — **it must not distort what it measures** — and that
single rule explains every design decision in it:

|                                                             |                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nothing is patched**                                      | Not `fetch`, not `XMLHttpRequest`, not `history`. The browser already records every request with a full timing breakdown; d0bar reads that. Asserted in CI with strict identity checks.                                                                                                                                       |
| **One event listener on your page, and you can decline it** | Load, visibility and first input all arrive as performance entries, costing nothing. The single exception is the keyboard shortcut — there is no entry type for a keypress — and `data-d0bar-shortcut="off"` removes even that. Verified through the browser's real listener registry via CDP, not by counting our own calls. |
| **Nothing runs during load**                                | Until your LCP is final, the only permitted work is writing a number into a preallocated buffer. No derivation, no DOM, no network. A development guard throws if anything tries.                                                                                                                                             |
| **No allocation in the hot path**                           | Requests go into a fixed struct-of-arrays ring over one `ArrayBuffer`. URLs are interned to integers. GC pressure from the toolbar can't correlate with the numbers it reports.                                                                                                                                               |
| **The panel isn't there until you open it**                 | 5.47 kB gzip on your critical path. The panel is a separate 4.15 kB file fetched on first click.                                                                                                                                                                                                                              |
| **Absence is disclosed, never guessed**                     | If the browser doesn't report a cache status, d0bar says the value was inferred. If attribution is missing, it says so instead of naming a likely element.                                                                                                                                                                    |

The claim is tested, not asserted. `bench/` runs the same hostile fixture with the toolbar on
and off, 20+ alternating runs, and compares **p95** deltas — a toolbar that is usually free
and occasionally costs 40 ms is not free, and a mean hides exactly that.

Current measured deltas, toolbar on vs off: **INP 0 · TBT 0 · CLS 0 · long tasks 0.**

---

## How this differs from the tool you're thinking of

d0bar is a **field** tool. Most performance tooling is a **lab** tool, and the distinction is
the whole reason this exists.

|                                                  | Lighthouse / PageSpeed             | Devtools                       | RUM (Sentry, Datadog…)      | d0bar                        |
| ------------------------------------------------ | ---------------------------------- | ------------------------------ | --------------------------- | ---------------------------- |
| **measures**                                     | a synthetic load it started itself | the page, in depth             | aggregates across all users | the session you are in       |
| **can reach**                                    | a URL it can open                  | wherever you can open devtools | everywhere, always          | wherever you can open a page |
| **behind auth, on page 3 of a wizard**           | no                                 | yes                            | yes                         | **yes**                      |
| **on a tablet, kiosk, or someone else's laptop** | no                                 | no                             | yes                         | **yes**                      |
| **answers "why is it slow _right now_"**         | no — it's a different load         | yes                            | no — it's a percentile      | **yes**                      |
| **trace correlation**                            | no                                 | no                             | yes                         | **yes**                      |
| **cost to the page**                             | n/a — separate run                 | large while open               | an agent, always on         | 5.5 kB, measured at zero     |

Concretely: Lighthouse cannot tell you why _this_ customer's shipment page is slow, because it
cannot log in and get to it. Devtools can — if you are sitting at a machine that has them. RUM
knows your p75 across a million sessions but cannot tell you about the one session in front of
you. d0bar is for the case those three leave open: a real session, on a real device, where you
need the answer now.

It is not a replacement for any of them. Lighthouse is better at auditing, devtools is better
at profiling your own JavaScript, and RUM is the only one of the four that can tell you about
users who never filed a ticket.

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

### You pay for what you use

The ESM build is side-effect free, so a bundler drops what you do not call. Measured with
esbuild against the published bundle:

| what you write                    | ships                                                 |
| --------------------------------- | ----------------------------------------------------- |
| `import "d0bar"` and never use it | **0 bytes**                                           |
| `import { init }` and call it     | **5.36 kB** gzip                                      |
| open the panel                    | **+4.15 kB** gzip, fetched on the click, never before |

Three stages, and a host page only ever pays for the ones it reaches. Stage 1 is the collector
and the pill. Stage 2 is the panel, a separate file behind `import()` — prefetched at
background priority _after_ the load phase settles, so it cannot compete with your own critical
requests. Anything heavier lands in a stage 3 that most pages never fetch at all.

The script-tag build cannot code-split, so it carries stage 1 only and loads stage 2 by URL at
runtime — same boundary, same bytes on the critical path.

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
a listener, adding a stylesheet, writing to storage. Distinct from _cost_: a change can be
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

**`assertSettled`** — the development-only guard. Every operation the moratorium forbids calls
it first — the pill's DOM write and stylesheet adoption, the stage-2 prefetch, service-worker
registration, OpenTelemetry detection — so a violation throws in development instead of
silently costing a customer main-thread time in production. Compiled out of the published
build, which is why `?d0bar=dev` exists: it loads a stage-1 build with the guard in, and
`tests/perf/dev-guard.spec.ts` runs a page against it. A guard no test executes is a comment,
and until that arm existed this one had a single call site while this paragraph described
many.

### Storage

**Ring** — the request store: struct-of-arrays over one preallocated `ArrayBuffer`, fixed at
512 records. Allocation-free on the write path.

**Struct-of-arrays (SoA)** — one typed array per _field_ rather than one object per record. A
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

**`navigationId`** — the browser's own epoch id, stamped on _every_ `PerformanceEntry`. Read
rather than derived, because it is correct for entries buffered from before the toolbar
mounted, and because the interaction that _causes_ a navigation correctly stays in the old
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

**Tier** (observation) — which source a measurement came from. The four are **additive, not
alternatives**: each answers a question the others cannot, so a tier going dark subtracts a
column rather than downgrading the whole reading. The footer strip states which are live
precisely because the set is a sum.

| tier                      | answers                                                                                                 | its absence costs                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1 · `PerformanceObserver` | _when_ — the timing spine. Every request and every vital, read rather than intercepted                  | never absent; the other three only ever add to it                                         |
| 2 · Service worker        | _which trace_ — a worker sees the request headers the page cannot, so it is what supplies `traceparent` | timings with no way to name the trace they belong to, which is what the Untraced count is |
| 3 · `Server-Timing`       | _where in the backend_ — the response carries the server's own phases                                   | one opaque wait bar instead of server-side segments                                       |
| 4 · Host OTel SDK         | _the spans themselves_ — the host already builds them, so reading them beats reconstructing them        | the jump from a slow request to its trace is a search rather than a link                  |

Tier 3 is not wired to anything yet and renders as `planned`.

## Tier 2 — the service worker

`PerformanceResourceTiming` deliberately exposes no request headers, so tier 1 can never see a
`traceparent`. A service worker can. d0bar's worker **reads headers and returns** — it never
calls `respondWith`, so the browser services every request exactly as it would with no worker
registered. That ban is enforced by a lint rule over `src/sw/**` and by an assertion against
the shipped bundle, not by care.

### What a host has to serve

|           |                                                                                 |
| --------- | ------------------------------------------------------------------------------- |
| The file  | `dist/d0bar-sw.js`, served **same-origin and from the scope root**              |
| Opting in | `data-d0bar-sw="/d0bar-sw.js"` on the script tag, or `sw: { path }` to `init()` |
| CSP       | `worker-src 'self'` (or `child-src 'self'` on older policies)                   |
| Context   | HTTPS, or localhost                                                             |

Serving the worker from the root is a **constraint, not a preference**: a worker script
controls a scope no wider than its own directory, so a file at `/dist/d0bar-sw.js` sees only
requests under `/dist/` — none of the page's traffic. A host that must serve it from a
subdirectory has to widen the scope explicitly with a `Service-Worker-Allowed: /` response
header.

There is no default path. Registering a service worker is a persistent, origin-scoped side
effect on someone else's site, and a path d0bar invented would 404 against their routing.
Omit it and tier 2 stays off — which the panel states rather than hides.

### If the host already has a worker

One worker controls a scope, and d0bar will not take or unregister anyone's. Three outcomes,
in order:

```
no worker registered        ──▶  d0bar registers its own      ──▶  tier 2 live
host worker imports d0bar   ──▶  nothing to register          ──▶  tier 2 live (owner: host)
host worker will not import ──▶  registration refused         ──▶  tier 2 off, and it says so
```

The middle path is the importable module:

```js
// the host's own sw.js — classic
importScripts("/d0bar-sw-module.js");
D0barSW.observe();

// or as a module worker
import { observe } from "/d0bar-sw-module.mjs";
observe();
```

The listeners are additive. Because d0bar's `fetch` handler never responds, the host's handler
decides the response exactly as it did before — a property of the ban, not of registration
order.

### What tier 2 adds, and what is lost without it

|                          | with tier 2             | without                                  |
| ------------------------ | ----------------------- | ---------------------------------------- |
| Trace id per request     | read from `traceparent` | **unavailable** — no trace jump          |
| HTTP method              | reported                | absent (tier 1 does not expose it)       |
| Un-instrumented requests | detected and counted    | **invisible** — the page never sees them |
| Timings, sizes, status   | tier 1, unchanged       | tier 1, unchanged                        |

Without it the footer reads `2 SW off`, the perturbation slot reads `degraded — no trace
jump`, every request resolves to the no-span state, and **no global is patched as a
substitute**. Patching `fetch` would change the calls it observes, miss everything issued
before mount, and fight every other library patching the same global.

### Cost

The worker's own dispatch overhead, measured across 250 requests on the bench fixture:

```
p50 0.5ms    p90 3.3ms    p95 3.4ms    p99 3.5ms    max 3.6ms
```

This bounds service-worker dispatch, which any registered worker imposes. It does not yet
attribute that cost between d0bar's handler and the browser's own machinery — that needs the
registered-vs-not comparison, which is not built.

The request log lives in the worker's IndexedDB, bounded by count and age, pruned on activate.
It survives a reload on purpose: the request that caused the error is still there after the
refresh someone did to go looking for it. If storage is denied or fills up, logging stops and
the UI reports it as degraded rather than presenting a log with a hole in it as complete.

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
measured under realistic pressure. It is the measuring _instrument_ and is identical in both
arms — never part of what is measured.

**Δ INP** — the figure in the footer strip's right-hand slot. INP is _Interaction to Next
Paint_, the browser's own measure of how fast the page responds to input; the delta is how much
d0bar's presence moves it. It reads `degraded — no trace jump` instead when tier 2 is off,
because a missing capability is the more useful thing to say.

**p95, never the mean** — how deltas are compared. A toolbar that is usually free and
occasionally costs 40 ms is not free, and a mean hides exactly that.

**Stage 1 / 2 / 3** — the delivery split. Stage 1 (collector + pill) is the only thing on a
host page's critical path and is measured alone. Stage 2 is the panel, loaded on first open.

---

## Tier 4 — adopting the host's OpenTelemetry spans

**d0bar never installs an SDK.** An OpenTelemetry browser SDK patches `fetch` and
`XMLHttpRequest`; that is a legitimate cost for a customer who chose it and an illegitimate one
for a toolbar whose entire claim is that it does not move the numbers it reports. So tier 4
reads a provider the host already registered, or says there is none.

What it adds, on a page that has one:

- a trace id for requests the service worker never saw — anything issued before the worker took
  control, and everything on a page where tier 2 is off entirely;
- a second, independent reading of the trace id on requests tier 2 _did_ see. Where the two
  disagree, the record is flagged (`F_TRACE_CONFLICT`) and the disagreement is reported.
  Neither wins: tier 2 read the header the browser actually sent, tier 4 read the span the SDK
  intended to send, and a disagreement means one of the two joins matched the wrong pair.

No OpenTelemetry package is a dependency of d0bar, and none is bundled. The API is read off its
own registered global or it is absent, which is what makes this tier cost nothing on the
overwhelming majority of pages — and the build **fails** if `@opentelemetry/` ever appears in a
shipped artifact.

### Turning it on

On `@opentelemetry/sdk-trace-web` 2.x — what a browser host actually installs today — a
provider takes its span processors at construction and offers no supported way to add one
afterwards. Measured, not assumed: `addSpanProcessor` is `undefined` on the 2.x line. So the
host installs d0bar's processor themselves:

```js
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

const provider = new WebTracerProvider({
  spanProcessors: [D0bar.otelSpanProcessor()],
});
provider.register();
```

The processor **reads and never exports**: `onStart` is empty, `onEnd` copies five fields out
and drops the span, and `forceFlush`/`shutdown` resolve immediately because nothing is
buffered. There is no second exporter and no extra network.

On a 1.x provider, which does expose `addSpanProcessor`, d0bar attaches itself at settle and
the host does nothing. The one thing d0bar will not do on either line is reach into the
provider's private `_activeSpanProcessor` — that is the monkey-patching this project exists to
refuse, and it is why a sealed provider reports `provider-sealed` rather than quietly working.

### What a span must carry

A URL, in `url.full` or the older `http.url`. Spans with neither are counted and dropped, never
matched by name — a host is free to name a span `GET /api/quote` for a request to a different
origin, or to name three spans the same, so matching on it would be a plausible inference
rather than an observation.

## License

[MIT](LICENSE).
