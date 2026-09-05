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
- [ ] 1.3 **Half done.** `detectOtel` calls `assertSettled`, so running it during the load phase
      throws in development. It is not yet called from `whenSettled` in `collector/index.ts`,
      because nothing consumes its result yet — wiring it now would attach a tier that reports
      live while collecting no spans
- [ ] 1.4 Build-time guard not added. Verified by hand this run (`@opentelemetry` appears 0
      times in all three artifacts), but a manual grep is not a guarantee; it belongs next to
      the `D0bar` global guard in `vite.config.ts`

## 2. The sink
- [ ] 2.1 A span processor that implements the interface and reads only: `onStart` empty,
      `forceFlush`/`shutdown` resolve immediately, no exporter
- [ ] 2.2 `onEnd` copies trace id, span id, name, start, end and URL out and retains no span
- [ ] 2.3 URL read from `url.full`, falling back to `http.url`; a span with neither is counted
      and dropped, never matched by name
- [ ] 2.4 Fixed-capacity ring, interned URLs, no allocation per span beyond the intern
- [ ] 2.5 Unit test asserting no reference to the span object survives the callback

## 3. Attachment
- [ ] 3.1 Attach to a provider that supports it; never patch a provider, prototype or tracer
      that does not
- [ ] 3.2 `otelSpanProcessor()` exported for hosts whose provider is sealed — the analogue of
      `d0bar-sw-module`, installed by the host, never by us
- [ ] 3.3 Attachment failure is non-fatal and resolves to a reported tier state
- [x] 3.4 Lint rule banning any import of `@opentelemetry/*` in `src/**`, verified by making the
      violation and watching it be reported. Adding it exposed a live bug: flat config replaces
      a rule's options rather than merging them, so a broad `src/**` block placed *after* the
      `src/collector/**` one silently switched off the stage-1 import-boundary guard. Block
      order and the restatement in both blocks are load-bearing, and both violations are now
      confirmed to fire

## 4. The join
- [ ] 4.1 Reuse the per-URL FIFO from `join.ts` rather than a second implementation
- [ ] 4.2 Tier 1 keeps timings, size and status; tier 4 supplies identity only, enforced by the
      type of the write-back
- [ ] 4.3 Tier 2 / tier 4 disagreement flagged on the record, not silently resolved
- [ ] 4.4 Unjoinable spans retained and counted, and surfaced the way tier 2's unjoined records
      already are

## 5. Tier state
- [ ] 5.1 `src/panel/tier.ts` — tier 4 stops being `planned` and resolves live / off from real
      detection, with each reason carrying its own copy
- [ ] 5.2 `no-sdk` reads as the ordinary state it is, not as a degradation the host should fix
- [ ] 5.3 A live tier 4 upgrades the trace chip on rows the SW never saw
- [ ] 5.4 Playwright: a fixture page with a real SDK installed, asserting the live path; and one
      without, asserting the off path renders with its reason

## 6. Documentation
- [ ] 6.1 What tier 4 adds, and that d0bar will never install an SDK to get it
- [ ] 6.2 The sealed-provider path, with the exact constructor snippet a host needs
