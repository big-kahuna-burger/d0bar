# Tasks — OTel adoption

## 0. Probe first
The version boundary in `design.md` is the one load-bearing claim that came from knowledge
rather than measurement. Settle it before writing the detection ladder.

- [x] 0.1 Probed `sdk-trace-base` 1.30.1, `sdk-trace-base` 2.11.0 and `sdk-trace-web` 2.11.0
- [x] 0.2 Answered: 1.x has `addSpanProcessor`, both 2.x packages do not. Self-attachment is
      impossible on the current line, which makes the host-installed processor the primary path
- [x] 0.3 The registered `trace` is a `ProxyTracerProvider` on every line; `getDelegate()` is
      required before any capability test
- [x] 0.4 Findings written into `design.md`, including two that changed the design: the API
      version is 1.9.1 on both lines so it cannot be branched on, and the global does not exist
      at all until a provider registers. Probe deleted

## 1. Detection
- [x] 1.1 `src/collector/otel.ts` — reads the versioned API symbol, shape-checks it, returns a
      typed outcome. No OpenTelemetry import anywhere. 12 unit tests, every fake reproducing a
      configuration that was actually measured
- [x] 1.2 An API global that is absent, non-object, throws on read, or carries no `trace`
      resolves to absent. **Reworded from the original task**: it said "unrecognised API
      version", but the probe showed the version cannot be used for anything — it is the API
      package's version and reads 1.9.1 against both SDK lines. The symbol itself is the
      version discriminator, and it is matched exactly
- [x] 1.3 Called from `whenSettled` in `collector/index.ts`, on the same settle boundary as
      tier 2 registration and the stage-2 prefetch. `detectOtel` still calls `assertSettled`,
      so calling it earlier throws in development
- [x] 1.4 Build-time guard added next to the `D0bar` global guard in `vite.config.ts`: the
      build throws if `@opentelemetry/` appears in any emitted chunk. Verified by making the
      violation and watching it fail. The first attempt at that proof did **not** fire, and the
      reason is the point: an unreachable `export const` was tree-shaken before terser ever saw
      it, so the guard checks bytes that actually ship rather than source that might not

## 2. The sink
- [x] 2.1 A span processor that implements the interface and reads only: `onStart` empty,
      `forceFlush`/`shutdown` resolve immediately, no exporter
- [x] 2.2 `onEnd` copies trace id, span id, name, start, end and URL out and retains no span
- [x] 2.3 URL read from `url.full`, falling back to `http.url`; a span with neither is counted
      and dropped, never matched by name
- [x] 2.4 Fixed-capacity ring, interned URLs, no allocation per span beyond the intern
- [x] 2.5 Asserted, but **not the way this task specified**. A `WeakRef` states it directly and
      was written first; it is not observable in this harness — a probe asserting that a plain,
      unreferenced object is collected after ten `global.gc()` calls fails too, so the test
      would have measured vitest rather than the sink. What ships instead asserts the mechanism:
      the span is mutated after the callback and the stored row does not move, and the module's
      whole state is five `TypedArray`s and three counters, which cannot hold an object
      reference at all

## 3. Attachment
- [x] 3.1 Attach to a provider that supports it; never patch a provider, prototype or tracer
      that does not
- [x] 3.2 `otelSpanProcessor()` exported for hosts whose provider is sealed — the analogue of
      `d0bar-sw-module`, installed by the host, never by us
- [x] 3.3 Attachment failure is non-fatal, resolving to `attach-failed` — a new reason,
      distinct from `provider-sealed` because the remedy differs and resolves to a reported tier state
- [x] 3.4 Lint rule banning any import of `@opentelemetry/*` in `src/**`, verified by making the
      violation and watching it be reported. Adding it exposed a live bug: flat config replaces
      a rule's options rather than merging them, so a broad `src/**` block placed *after* the
      `src/collector/**` one silently switched off the stage-1 import-boundary guard. Block
      order and the restatement in both blocks are load-bearing, and both violations are now
      confirmed to fire

## 4. The join
- [x] 4.1 Reuse the per-URL FIFO from `join.ts` rather than a second implementation
- [x] 4.2 Tier 1 keeps timings, size and status; tier 4 supplies identity only, enforced by the
      type of the write-back
- [x] 4.3 Tier 2 / tier 4 disagreement flagged on the record, not silently resolved
- [x] 4.4 Unjoinable spans retained and counted, and surfaced the way tier 2's unjoined records
      already are

## 5. Tier state
- [x] 5.1 `src/panel/tier.ts` — tier 4 stops being `planned` and resolves live / off from real
      detection, with each reason carrying its own copy
- [x] 5.2 `no-sdk` reads as the ordinary state it is, not as a degradation the host should fix
- [x] 5.3 A live tier 4 upgrades the trace chip on rows the SW never saw — `adoptSpan` sets
      `F_HAS_SPAN` and a context handle, which is what the chip already reads
- [x] 5.4 `bench/fixtures/host/otel.html` runs a real `WebTracerProvider` 2.11.0 with
      `D0bar.otelSpanProcessor()` passed at construction; `tests/perf/otel.spec.ts` asserts the
      live path, the adopted chips and an unpatched `fetch` there, and the off path with its
      reason on `/`. **4/4 pass.** `@opentelemetry/*` is a dev dependency of the workspace root
      and reaches the browser only through `scripts/build-otel-fixture.mjs`, which esbuild
      bundles into an ignored, regenerated-per-run file; `/` — the page every observer-effect
      arm measures — loads none of it.

      Two real defects fell out of running it, neither of which any unit test could have found:
      - the panel never repainted after the correlation flush, so trace chips only appeared if
        another resource batch happened to arrive. Tier 2 had the same latent bug, hidden
        because the busy fixture always produced another batch;
      - a span carrying a **relative** `url.full` joined against nothing, silently. The
        resource entry's `name` is always absolute, so the panel showed requests as untraced on
        a page whose SDK had traced them. The sink now resolves the attribute against the
        document

## 6. Documentation
- [x] 6.1 What tier 4 adds, and that d0bar will never install an SDK to get it
- [x] 6.2 The sealed-provider path, with the exact constructor snippet a host needs
