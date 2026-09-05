# Design — OTel adoption

## Adoption, never installation
An OpenTelemetry browser SDK instruments the page by patching `fetch` and `XMLHttpRequest`.
That is the correct trade for a customer who chose it, and it is precisely the trade this
toolbar exists not to make on someone's behalf. So the rule is absolute:

| d0bar does | d0bar does not |
| --- | --- |
| Read a provider the host already registered | Create a provider |
| Attach a sink that only reads ended spans | Install an SDK, or add one to any bundle |
| Report that no SDK is present | Patch a global to compensate |

`@opentelemetry/api` appears in no `package.json` dependency list and is never imported. It is
detected as a global or it is absent, which means tier 4 cannot cost a host that does not use
it a single byte.

## Finding the host's SDK
`@opentelemetry/api` registers itself on a versioned symbol, `Symbol.for("opentelemetry.js.api.1")`,
so detection is a property read on `globalThis` and a shape check on what is there. Nothing is
imported and no module resolution is involved, which is what makes this free.

The symbol is versioned by design — it is how two copies of the API on one page avoid fighting.
d0bar must treat an unrecognised version as *absent*, not as an error and not as an assumption
that the shape is close enough.

## The three outcomes
Deliberately the same ladder as scope contention in `request-correlation`, because it is the
same shape of problem: a resource the host owns, which d0bar may use but never seize.

1. **No API global** → tier 4 off, reason `no-sdk`. The common case, and not a degradation:
   most pages have no OTel SDK and are entitled to a toolbar that says so plainly.
2. **Provider accepts a processor** → d0bar attaches its own read-only span sink → tier 4
   live, owner `d0bar`.
3. **Provider cannot be extended after construction** → d0bar attaches nothing. The host adds
   `D0bar.otelSpanProcessor()` to their own provider's constructor, exactly as a host with
   their own service worker imports `d0bar-sw-module`. If they do, tier 4 is live with owner
   `host`; if they do not, tier 4 is off with reason `provider-sealed`.

Outcome 3 is not an edge case. **On the current SDK line it is the only outcome available**,
which inverts the emphasis of this whole change: the host-installed processor is the primary
path and self-attachment is the legacy convenience.

### Measured, 2026-09-05

Both lines installed and inspected in a throwaway package. `provider.register()` on 1.x,
`api.trace.setGlobalTracerProvider(provider)` on 2.x, which no longer carries `register` on
`BasicTracerProvider`:

| SDK package | `api` | symbol keys | `trace` is | unwrapped delegate | `addSpanProcessor` |
| --- | --- | --- | --- | --- | --- |
| `sdk-trace-base` 1.30.1 | 1.9.1 | `version`, `trace`, `propagation` | `ProxyTracerProvider` | `BasicTracerProvider` | **function** |
| `sdk-trace-base` 2.11.0 | 1.9.1 | `version`, `trace` | `ProxyTracerProvider` | `BasicTracerProvider` | **undefined** |
| `sdk-trace-web` 2.11.0 | 1.9.1 | `version`, `trace`, `propagation`, `context` | `ProxyTracerProvider` | `WebTracerProvider` | **undefined** |

The third row is the one that matters — it is what a browser host installs. Note also that the
symbol's key set varies with what the host registered (`context` and `propagation` appear only
when a provider registers them), so the shape check must require `trace` and tolerate the rest
being absent rather than matching a fixed key set.

Two further measurements that simplify the detection code:

- **Importing the API does not create the global.** With `@opentelemetry/api` loaded and
  nothing registered, `globalThis[Symbol.for("opentelemetry.js.api.1")]` is `undefined`.
  Registration is what creates it. So "an SDK was bundled and never started" reads as `no-sdk`,
  which is the truthful answer about a page whose SDK is producing nothing.
- **An unregistered proxy's delegate is not identifiable by surface.** `getDelegate()` returns
  a `NoopTracerProvider` that answers `getTracer` and has no `addSpanProcessor` — the same
  shape as a sealed real provider. Since the point above makes that state unreachable, the
  detection code does not try to tell them apart; the alternative was matching a class name,
  which the host's own minifier renames.

Three consequences, each of which corrects something this document said before the probe:

1. **The version cannot be used to decide anything.** The symbol's `version` is the *API*
   package's version, and it is `1.9.1` on both lines — the API is 1.x while the SDK is 2.x.
   Attachability MUST be feature-tested on the unwrapped delegate. An earlier draft of the
   ladder read the version to pick a branch, which would have taken the 1.x branch on a 2.x
   SDK and attached nothing while reporting live.
2. **The registered provider is always a proxy.** `trace` on the global is a
   `ProxyTracerProvider` on both lines, so `getDelegate()` is not an optional refinement — it
   is required before any capability test, or every test runs against the proxy's own surface
   rather than the real provider's.
3. **2.x exposes `_activeSpanProcessor` as an own field** and nothing but `constructor` on its
   prototype. Reaching into that underscore is the only way to self-attach on 2.x, and it is
   exactly the monkey-patching this change forbids. It is not a fallback; it is the thing we
   do not do.

Probe limits worth stating: this measured the JS SDK's own providers under Node, not a real
page, and it did not test a host running two API copies at once. Neither changes the ladder —
the capability test is a property read on an object the page hands us — but neither has been
observed in a browser either.

## The sink
A span processor's `onEnd` runs on the host's own pipeline, on the main thread, in the middle
of their instrumentation. It gets the same treatment as `pushResource`:

- Copy the primitives out — trace id, span id, name, start, end, and the URL attribute — and
  drop the span. A `ReadableSpan` holds attributes, links, events and the resource; retaining
  one retains all of it.
- Intern the URL to a `u32` and write into a fixed ring. No object literal, no closure.
- `onStart` does nothing. `forceFlush` and `shutdown` resolve immediately. The sink exports
  nothing and has no exporter — it is a reader wearing a processor's interface, which is the
  only interface the SDK offers for reading spans as they end.

Registration happens after settle, never during the load phase.

## The URL attribute
Semantic conventions renamed the field: `http.url` in the old HTTP conventions, `url.full` in
the stable ones. Both are read, and a span carrying neither is counted and dropped rather than
matched on its name — a span name like `HTTP GET` is not a URL and guessing from it would
manufacture joins.

## The join
The same per-URL FIFO as `request-correlation`, keyed on the interned URL, popped in order.
Authority is split and neither side may write the other's fields:

| Source | Authoritative for |
| --- | --- |
| Tier 1 `resource` entry | timings, transfer size, status |
| Tier 4 adopted span | trace id, span id, span name, sampled flag |

Where tier 2 and tier 4 both name a trace they should agree, and where they do not, the
disagreement is data: it means the worker saw a `traceparent` the SDK did not produce, or the
reverse. The record keeps tier 4's identity and flags the conflict rather than silently
preferring one.

## Rejected
- **Importing `@opentelemetry/api` as a dependency.** It would put the API surface in d0bar's
  bundle for every host, including the overwhelming majority with no SDK, to read a global
  that a two-line feature test reads for nothing.
- **Installing an SDK when none is found.** This is the whole point of the change, restated:
  it would patch `fetch` on a page whose owner did not ask for it, and every number the
  toolbar then reported about that page would include the cost of the toolbar's own decision.
- **Reading `trace.getActiveSpan()` when recording a resource entry.** The `PerformanceObserver`
  callback runs after the request completed and outside the host's context, so the active span
  there is whatever happens to be current — usually none, occasionally something unrelated.
  It would produce confident, wrong joins.
- **Wrapping the host's exporter.** It reads spans, but it also puts d0bar in the path of the
  host's telemetry export, where a mistake loses the customer's data rather than ours.
