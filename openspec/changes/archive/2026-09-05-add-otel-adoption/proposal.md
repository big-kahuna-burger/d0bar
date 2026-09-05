# add-otel-adoption

## Why
Tier 4 is the only tier that reads the host's own spans rather than reconstructing something
like them. Where an OpenTelemetry browser SDK is already installed, the answer the toolbar
spends tiers 1–3 approximating — *which trace is this request part of* — has already been
computed by the host, correctly, including the requests d0bar's own tiers cannot name.

The constraint is the whole design, and it is stated in the handoff: **d0bar will never
install that SDK.** An OTel browser SDK patches `fetch` and `XMLHttpRequest`. That cost is
legitimate for a customer who chose it and unacceptable for a toolbar that measures the page.
So tier 4 is adoption, never installation — d0bar reads what is there, and where nothing is
there it says so and stays at tier 1.

## What Changes
- Detection of an already-registered `@opentelemetry/api` global, by feature test, with no
  dependency added to any bundle.
- A read-only span sink attached to the host's existing provider, collecting ended client
  spans into a bounded ring. It exports nothing, samples nothing, and installs nothing.
- A join from adopted spans to Tier 1 records, reusing the per-URL FIFO from
  `request-correlation`. Tier 1 stays authoritative for timings; tier 4 for span identity.
- Tier 4 state resolution, with each way it can be unavailable reported distinctly.

## Impact
- New capability: `otel-adoption`
- New: `src/collector/otel.ts`, `src/panel/views/requests` gains no new column — the existing
  trace chip is upgraded in place
- Modifies: `src/panel/tier.ts` (tier 4 stops being `planned`), `src/collector/join.ts`
- **Adds no runtime dependency.** `@opentelemetry/api` is read off a global if the host
  registered one; it is never imported, so it cannot enter a bundle.
- Depends on: `add-observation-core`, `add-panel-shell`. Independent of `add-sw-correlator` —
  tier 2 and tier 4 answer the same question by different means, and either alone is enough
  to name a trace.
