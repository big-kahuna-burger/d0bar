# add-perturbation-budget

## Why
`Δ INP 0.0ms` in the footer is a claim about the product's central promise. Unverified, it is
marketing. This change makes it a measured, CI-enforced budget — and gives every later change a
harness to be judged against.

It lands with `add-observation-core` because it is that change's acceptance gate.

## What Changes
- A hostile fixture host page: 300 requests, a mix of fetch and XHR, induced layout shift, a
  long animation frame, a slow LCP image.
- Recorded fixtures: a `PerformanceObserver` entry dump, and a real 4000-span OTLP trace.
- A/B Playwright harness: gate on vs. gate off, n≥20 runs, compared as distributions.
- Non-perturbation assertions: `fetch` pristine, no host style leak, bounded heap delta.
- A committed budget file and a CI job that fails on regression.

## Impact
- New capability: `perturbation-budget`
- New: `bench/fixtures/`, `bench/budget.json`, `tests/perf/`
- Verifies: every other change. Every later change adds its own budget row.
