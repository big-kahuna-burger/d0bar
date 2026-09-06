# d0bar — architecture

An observability toolbar injected into a customer's own web application. One constraint
governs every decision below:

> **The toolbar must not distort what it measures.**

A profiler that costs 40 ms of main-thread time reports a page that is 40 ms slower than the
one the customer ships. So the design is organised around a single question — *what is this
costing the host page right now?* — and most of it is subtraction.

---

## 1. Two budgets, not one

```
   ┌─────────────────────────────────────────────────────────────────────┐
   │  BUDGET A — closed / ambient          the dominant risk             │
   │  ───────────────────────────          ─────────────────             │
   │  What every page-load pays, on every page, whether or not anyone    │
   │  ever opens the panel. Must be indistinguishable from zero.         │
   │                                                                     │
   │  Gated on:  LCP · INP · CLS · TBT · long-task count                 │
   └─────────────────────────────────────────────────────────────────────┘
   ┌─────────────────────────────────────────────────────────────────────┐
   │  BUDGET B — open / active                                           │
   │  ────────────────────────                                           │
   │  What a developer pays while deliberately staring at the numbers.   │
   │  Allowed to cost something. They asked for it.                      │
   └─────────────────────────────────────────────────────────────────────┘
```

Almost every architectural choice here is bought with budget A.

---

## 2. The load-phase moratorium

The highest-leverage rule in the system, and it costs nothing.

```
  page start                    LCP final                     later
      │                             │                            │
      ▼                             ▼                            ▼
      ├─────────── COLLECTING ──────┼────────── SETTLED ─────────▶
      │                             │
      │  PERMITTED                  │  PERMITTED
      │  ─────────                  │  ─────────
      │  • record entries           │  • everything
      │  • bounded accumulation     │
      │    (CLS session windows,    │
      │     the INP top ten, the    │
      │     LCP element's selector) │
      │                             │
      │  FORBIDDEN                  │
      │  ─────────                  │
      │  • unbounded derivation     │     assertSettled() throws in
      │  • touch the DOM            │     dev if anything on the left
      │  • postMessage to a worker  │     is attempted early
      │  • fetch                    │
```

"Record, and bounded-accumulate" rather than "record": `noteLcp` derives a selector, CLS
maintains its session windows and the INP top ten is kept, all inside observer callbacks
before settle. Each is O(1) per entry against a fixed-size structure and allocates nothing, so
none of it is what the moratorium is about — but the diagram used to say "derive / aggregate:
FORBIDDEN", which was simply false about the code beneath it.

**Why it is free:** every observer registers with `buffered: true`, so deferring loses no
data — an observer attached at any moment still receives every entry from page start. The
toolbar contributes nothing to LCP or TBT as a *structural* property, not as a hope.

**When LCP is final.** Per the standard, at the first of *first input* or *document hidden* —
and at neither, on a page nobody touches. The load event is **not** an LCP finalizer: an app
that renders its largest element from JavaScript reports LCP long after load, and settling at
load would end the moratorium while the very metric it protects is still being recorded.

```
  load ──▶ wait for LCP to go quiet ──▶ settle
             │  no new LCP entry
             │  for 500 ms
             └─ hard ceiling 10 s, so a page that paints forever still
                gets a toolbar
```

---

## 3. Zero contact with the host page

```
                    ┌──────────────────────────────────────┐
                    │        HOST PAGE (untouched)         │
                    │                                      │
   ✗ no fetch patch │   window.fetch    ← strictly ===     │
   ✗ no XHR patch   │   XMLHttpRequest  ← strictly ===     │
   ✗ no listeners   │   window          ← 0 added          │
   ⚠ one listener   │   document        ← 1: keydown       │
   ✗ no stylesheet  │   document.adoptedStyleSheets ← 0    │
   ✗ no storage     │   localStorage / cookies ← untouched │
                    └───────────────┬──────────────────────┘
                                    │  reads only
                                    ▼
                    ┌──────────────────────────────────────┐
                    │   PerformanceObserver × N            │
                    │   (buffered: true, per-type try)     │
                    └──────────────────────────────────────┘
```

Every one of those lines is asserted in `tests/perf/non-perturbation.spec.ts`, not merely
documented. Listener counts are read through CDP against the browser's real registry —
patching `addEventListener` to count calls would be the one thing this file exists to forbid.

**Lifecycle signals come from entry types, never listeners:**

| Signal | Conventional | Here |
| --- | --- | --- |
| load | `addEventListener("load")` | `navigation` entry, 2nd delivery, `loadEventEnd > 0` |
| visibility | `visibilitychange` | `visibility-state` entry type |
| first input | `addEventListener` | `first-input` entry type |

The `navigation` entry is delivered **twice** — first with every field zero, then again once
the load event has run. Measured: 22 ms with `loadEventEnd: 0`, then 47 ms with
`loadEventEnd: 35`, matching the load event exactly.

---

## 4. The request ring

Struct-of-arrays over one preallocated `ArrayBuffer`. Nothing is allocated per request.

```
              ONE ArrayBuffer, allocated once at module load
                        45,056 bytes / 44 KiB
   ┌──────────────────────────────┬────────────────┬──────────────┐
   │     Float64Array region      │  Uint32Array   │  Uint16Array │
   │  8 cols × 512 × 8B = 32,768  │ 5×512×4=10,240 │ 2×512×2=2,048│
   └──────────────────────────────┴────────────────┴──────────────┘
   0                          32768            43008          45056
```

Thirteen columns, each a typed-array **view** onto a slice of that one buffer — no per-column
allocation:

```
   byte     column                            constructed as
   ─────    ─────────────────────────         ──────────────────────────────
       0    startTime        [0 … 511]  ─┐
    4096    duration         [0 … 511]   │
    8192    connectStart     [0 … 511]   │
   12288    requestStart     [0 … 511]   ├─ Float64Array(buf, n*4096, 512)
   16384    responseStart    [0 … 511]   │
   20480    responseEnd      [0 … 511]   │
   24576    transferSize     [0 … 511]   │
   28672    encodedBodySize  [0 … 511]  ─┘
   32768    urlId            [0 … 511]  ─┐
   34816    initiatorId      [0 … 511]   │
   36864    methodId         [0 … 511]   ├─ Uint32Array(buf, 32768+n*2048, 512)
   38912    epochId          [0 … 511]   │
   40960    contextId        [0 … 511]  ─┘
   43008    status           [0 … 511]  ─┐
   44032    flags            [0 … 511]  ─┴─ Uint16Array(buf, 43008+n*1024, 512)
```

A record is **not** a contiguous 88-byte struct. It is slot `k` read across all thirteen
columns:

```
        slot →     0        1        2      ...     510      511
   startTime   [    60 ][    61 ][    74 ]  ...  [      ][      ]
   duration    [   412 ][    88 ][    12 ]  ...
   urlId       [     7 ][     7 ][    12 ]  ...
   epochId     [  4858 ][  4858 ][  4865 ]  ...
   status      [   200 ][   200 ][   404 ]  ...
   flags       [  0x22 ][  0x02 ][  0x20 ]  ...
                    ▲                 ▲
                    │                 └── record 2 — a vertical slice,
                    └── record 0          88 bytes across 5 regions
```

### The write path

This runs inside a `PerformanceObserver` callback during load, while the host's TBT is being
measured. It is the hottest code in the project.

```
   PerformanceObserver("resource", { buffered: true })
         │
         │  entries[i] ── the browser's own object, never retained
         ▼
   pushResource(entry)
         │
         ├─ slot = written & 511            ← mask, not modulo; no branch
         ├─ if (written >= 512) dropped++   ← loss counted, never hidden
         │
         ├─ 8 × f64 stores      startTime … encodedBodySize
         │
         ├─ intern(entry.name) ─────────► ┌──────────────────────┐
         ├─ intern(initiatorType) ──────► │    intern table      │  the ONLY
         │                                │   string → u32       │  allocation
         │                                │  "…/api/x"  →  7     │  in the path,
         │                                │  "…/api/x"  →  7 ◄── │  and only on
         │                                └──────────────────────┘  a cache miss
         │                                   URLs repeat; hits are free
         │
         ├─ 3 × u32 stores      urlId, initiatorId, methodId
         ├─ flags |= …          F_XHR │ F_CACHED │ F_NO_PHASES │ …
         ├─ 2 × u16 stores      status, flags
         └─ 2 × u32 stores      epochId, contextId
                                              no object literal
            written++                         no closure
                                              no retained entry  →  nothing for GC
```

### Overflow is a sliding window, not a truncation

```
   written = 522,  CAPACITY = 512,  dropped = 10

    physical slot    0     1    …    9    10    11   …   510   511
                  ┌─────┬─────┬───┬─────┬─────┬────┬──┬─────┬─────┐
   record number  │ 512 │ 513 │ … │ 521 │  10 │ 11 │… │ 510 │ 511 │
                  └─────┴─────┴───┴─────┴─────┴────┴──┴─────┴─────┘
                     ▲                 ▲   ▲
                     │                 │   └─ read(0) = oldest retained = #10
                     └───── newest ────┘
                            write head has wrapped past the tail

   read(i):  base = written - CAPACITY = 10
             slot = (base + i) & 511
```

`read()` fills a **caller-owned scratch object** rather than returning a new one, so rendering
30 virtualized rows allocates nothing per frame. The `dropped` count is surfaced in the UI —
a truncated list is never presented as complete.

---

## 5. Epochs — the browser computes them for us

On a single-page app the interesting time window is a *route*, not the document. The obvious
implementation records route boundaries and buckets entries by comparing timestamps. That
design is wrong, and measurement showed why.

Chrome stamps `navigationId` on **every** `PerformanceEntry`:

```
   soft-navigation   "/detail"        navigationId 4865   navigationType "push"
                                      interactionId 1107  paintTime 427.9
   interaction-contentful-paint       navigationId 4865
   resource  /probe-asset.json        navigationId 4865   ← fetched after the soft nav
   largest-contentful-paint (initial) navigationId 4858   ← the hard nav
   event  click (which CAUSED it)     navigationId 4858   ← still the OLD epoch
                                                  ▲
                     the click at t=394.3 and the soft nav at t=394.3 are in
                     DIFFERENT epochs — any timestamp-bucketing scheme gets
                     this backwards, on exactly the entry a user asks about
```

So the epoch is a `u32` the browser already computed. No boundary table, no binary search on
the read path, and buffered entries from before mount are attributable — which a
locally-tracked boundary list could never be.

```
   ┌────────┬─────────────────────────────┬──────────────┬──────────────────────────┐
   │  Tier  │  Source                     │  Epoch id    │  What is true            │
   ├────────┼─────────────────────────────┼──────────────┼──────────────────────────┤
   │   1    │  soft-navigation entries    │  browser's   │  boundaries incl.        │
   │        │  Chrome 151+                │  navigationId│  buffered; per-epoch ICP │
   ├────────┼─────────────────────────────┼──────────────┼──────────────────────────┤
   │   2    │  Navigation API             │  ours, 1+n   │  correct from mount on;  │
   │        │  currententrychange         │              │  pre-mount → epoch 0     │
   ├────────┼─────────────────────────────┼──────────────┼──────────────────────────┤
   │   3    │  neither (Firefox, Safari)  │  constant 0  │  one epoch: the document │
   │        │                             │              │  — and the UI says so    │
   └────────┴─────────────────────────────┴──────────────┴──────────────────────────┘
```

Tier 2 matters and is not decoration: `currententrychange` fires on raw `history.pushState`
**and** `replaceState`, so every SPA router bottoms out in it and **nothing needs patching**.
`replace` updates the current epoch's URL rather than opening one — routers use it for
query-string edits, and treating each as a boundary would shred the timeline.

---

## 6. Honest degradation

Every capability is feature-detected and every absence is disclosed. The toolbar never
presents a guess with the confidence of a measurement.

```
   capability present  ──▶  quote the browser        ──▶  render normally
   capability absent   ──▶  infer, and mark it       ──▶  render as inferred
                       ──▶  cannot infer             ──▶  say "unavailable"
                                                          never name a likely cause
```

Worked example — cache status:

```
   deliveryType supported ?
        │
        ├── yes ──▶ F_CACHED = (deliveryType === "cache")        reported
        │
        └── no  ──▶ F_CACHED = (transferSize === 0 && body > 0)  inferred
                    F_CACHE_INFERRED                             ← UI must not
                    ▲                                              present this with
                    │  a 304 and an opaque cross-origin response    equal confidence
                    └─ produce exactly this shape too
```

The same pattern governs `responseStatus` (`F_STATUS_UNKNOWN`), cross-origin phase timings
(`F_NO_PHASES`, drawn as one undifferentiated bar rather than invented proportions), and the
epoch tier above.

---

## 7. Build

```
   src/index.ts
        │
        ▼
   Rollup ── es   ──▶ terser(module: true)  ──▶ dist/d0bar.js       4.26 kB gz
        └─── iife ──▶ terser(module: false) ──▶ dist/d0bar.iife.js  4.33 kB gz
                             │                        │
                             │                        └─ guard: the build FAILS if
                             │                           `var D0bar =` is missing
                             │
                             └─ options are rebuilt per call.
                                terser normalises its argument IN PLACE, so a shared
                                literal leaks the ES pass's `module: true` — which
                                implies `toplevel` — into the IIFE pass, where it
                                deletes the global as an unused top-level variable
                                and takes the script-tag build's whole API with it.
```

Vite is bypassed for both formats: it skips terser entirely for `es` in library mode, and
passes an explicit `toplevel` for `iife` which drops the global.

---

## 8. Where the guarantees are enforced

| Claim | Enforced by |
| --- | --- |
| No perturbation of host metrics | `tests/perf/ab.spec.ts` — n≥20 alternating runs, **p95** deltas vs `bench/budget.json` |
| Globals unpatched, one listener (the shortcut, opt-out), no styles, no storage | `tests/perf/non-perturbation.spec.ts` |
| Nothing touched before settle | `tests/perf/moratorium.spec.ts` |
| Critical-path size | `.size-limit.json`, both artifacts |
| No dev assertions shipped | `__DEV__` from Vite's `mode`, stripped at build |

Deltas are compared at **p95, never the mean**. A toolbar that is usually free and
occasionally costs 40 ms is not free, and a mean hides exactly that.
