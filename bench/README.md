# bench — the observer-effect budget

d0bar's central claim is that it does not distort what it measures. This directory is where
that stops being a claim.

## What runs

| Suite | Asserts |
| --- | --- |
| `tests/perf/ab.spec.ts` | The same fixture, toolbar on vs off, n≥20 alternating runs. Compares p95 deltas against committed thresholds. |
| `tests/perf/non-perturbation.spec.ts` | Properties a timing budget cannot express: `fetch` and `XMLHttpRequest` strictly unpatched, no rule added to the host document, nothing written to host storage, and total inertness when the gate is off. |
| `tests/perf/moratorium.spec.ts` | The toolbar touches nothing in the host document until after the load phase has settled. |

```bash
pnpm build && pnpm test:perf
```

`D0BAR_RUNS=4 pnpm test:perf` shortens the A/B run while iterating. CI uses the default.

The suite is split into two Playwright projects, and CI runs them as two jobs on two runners:

| project | tests | how it runs | why |
| --- | --- | --- | --- |
| `timing` | 7, tagged `@timing` | one worker, alone on the machine | they compare durations against each other, so anything else on the runner is noise |
| `behaviour` | 62 | every core | they assert ordering, DOM state, storage and console output — nothing that cares who else is running |

`pnpm test:perf:timing` and `pnpm test:perf:behaviour` run one each; `pnpm test:perf` runs both
serially, which is what one machine should do. Measured on CI before the split: 317 s of the
suite was timing-sensitive and 158 s was not, and the second 158 s was running one test at a
time because it shared a config with the first.

## The fixture

`fixtures/host/` is a page that is already struggling, so the toolbar is measured under
realistic pressure rather than on an empty document:

- 300 requests — a burst of 120 during load, then a tail. Roughly a quarter are
  `XMLHttpRequest`, and every fifth goes to `localhost` rather than `127.0.0.1`, making it
  genuinely cross-origin and served without `Timing-Allow-Origin`, so the browser zeroes its
  phase timings.
- An LCP element rendered from JavaScript after a fixed 800 ms request. Text, not an image:
  Chrome excludes low-entropy images from LCP candidacy, and a placeholder PNG is exactly
  that — an earlier version of this fixture measured nothing because of it.
- A 120 ms long task during load, so total blocking time is non-zero in both arms.
- A layout shift after load.
- An 84 ms blocking click handler (`#confirm-hold`), so INP has something real to measure.
- A second, near-free interaction target (`#cheap-tap`) that flips one attribute. The blocking
  handler quantizes INP to 88 ms on every run of every arm — sixty CI runs returned 88 sixty
  times — so a toolbar costing single-digit milliseconds is invisible inside it. The cheap
  target is where that cost is a visible fraction of the number.

Every delay is fixed. Nothing depends on wall-clock time or network conditions, so a measured
delta reflects a code change rather than fixture variance.

`fixtures/host/metrics.js` is the measuring instrument and is **identical in both arms** — it
is not part of what is being measured. It reads the browser's own entries for LCP, CLS, long
tasks and interactions, and records when the toolbar first touches the host DOM.

## Reading the results

Each run writes `bench/last-budget.json` with both arms' figures, the deltas, and the budget
each was checked against. `bench/budget.json` holds the committed thresholds and the last
measurement taken against them.

Deltas are compared at **p95, never at the mean**. A toolbar that is usually free and
occasionally costs 40 ms is not free, and a mean hides exactly that.

That rule holds for continuous metrics and inverts for quantized ones — an integer long-task
count, or INP, which Chrome reports in 8 ms steps. A p95 of twenty integers is one sample with
a noise floor of a whole unit, and no millisecond threshold below 8 is expressible for INP at
all. Both rows failed on CI for that reason and neither was reporting a slower toolbar.
[`quantized-metrics.md`](./quantized-metrics.md) has the failure, the arithmetic, and the
paired sign test that replaced the INP comparison.

**Numbers come from CI, never from a dev machine.** A laptop is fast enough to land both arms
in the same INP quantum, which is why the row above could never fail locally.

## Changing a threshold

A threshold is a claim about the product. Raising one is a decision, not a fix:

1. Say in the PR body which threshold, what it moves from and to, and what changed to make
   the old value unattainable.
2. Update `budget.json` — both the threshold and the `rationale` for it.
3. Get a reviewer to agree in writing.

Lowering a threshold after an improvement needs none of that.
