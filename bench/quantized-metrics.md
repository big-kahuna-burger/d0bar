# Gating on a metric coarser than its own threshold

A budget row must be able to express a value smaller than the threshold it gates on. Two rows
in `ab.spec.ts` could not, and one CI run on a two-core runner failed both. This is what went
wrong, why the obvious fixes do not work, and how the INP row is compared now.

---

## The failure

CI, `ubuntu-24.04`, 20 alternating runs per arm:

| row                    | `off`    | `gated`  | `on`     | threshold     | outcome                    |
| ---------------------- | -------- | -------- | -------- | ------------- | -------------------------- |
| `inpP95`               | 88       | 88       | **96**   | Δ ≤ 2 ms      | failed at Δ = 8            |
| `longTasksP95`         | 7        | **6**    | 7        | Δ ≤ 0.5 tasks | would have failed at Δ = 1 |
| `tbtP95`               | 241      | 241      | 243      | Δ ≤ 5 ms      | passed                     |
| `clsMax`               | 0.006726 | 0.006726 | 0.006726 | Δ ≤ 0.001     | passed                     |
| `attributedFrameMsP95` | 0        | 3.21     | 4.159    | ≤ 8 ms        | passed                     |

Neither failing row is reporting a toolbar that got slower. Both are reporting an instrument
that cannot resolve the question being asked of it.

**Long tasks.** `on` scored 7 and `off` scored 7 — identical. The _baseline_ scored 6, below an
arm that loads no bundle at all. A baseline cannot meaningfully beat "load nothing"; that is
noise, and the delta was manufactured out of it.

**INP.** Chrome reports INP quantized to 8 ms. `on` landed exactly one quantum above `gated`,
which is the smallest non-zero value the metric can take.

```
   Chrome's INP quantization

     ... 80 -------+------- 88 -------+------- 96 -------+------- 104 ...
                   |                  |                  |
     gated --------------------------->                  |
     on    ------------------------------------------->  |

   a delta of exactly 8 is equally consistent with:
       * d0bar costs 0.1 ms, and one value sat on a boundary
       * d0bar costs 8 ms

   the measurement cannot separate these
```

---

## Why the aggregation was wrong

`percentile(values, 95)` at n = 20 computes:

```
   rank = ceil(0.95 * 20) - 1 = 18
```

That is `sorted[18]` — **the second largest of twenty samples**. For a continuous metric with a
long tail, that is the right thing and the reason this file's header says _"p95, never the
mean"_: a mean hides a toolbar that is usually free and occasionally expensive.

For a quantized metric it inverts. The p95 of an integer count _is_ a single sample from the
tail, and its noise floor is one whole unit:

| row                              | threshold | metric resolution | can express Δ < threshold? |
| -------------------------------- | --------- | ----------------- | -------------------------- |
| `longTaskCount`, as a mean of 20 | 0.5 tasks | 0.05 tasks        | yes                        |
| `longTaskCount`, as a p95 of 20  | 0.5 tasks | 1 task            | **no**                     |
| `inpP95`                         | 2 ms      | 8 ms              | **no**                     |

The long-task row had been a mean and was changed to a p95 by `enforce-non-perturbation`,
citing the header rule. The rule was right; it was applied to the one row where it inverts. It
is a mean again, with that reasoning written down beside it.

---

## Why INP cannot be fixed the same way

Every order statistic of a quantized metric is quantized. Median, p95, max, mean-of-quantized-
values — all of them can only move in steps of 8 ms, or report a fraction that is an artefact
of how many samples happened to sit either side of a boundary. Changing which statistic is
compared does not add resolution that the underlying values do not have.

Three fixes that do not work:

| fix                             | why not                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Raise the threshold to 8 ms     | Gates nothing. Any regression a developer would notice is more than one quantum, and one quantum is the noise floor.                                                                                                                                   |
| More runs                       | Narrows the noise band around each arm's percentile. It does not make the percentile able to take a value between 88 and 96.                                                                                                                           |
| Compare means of the raw values | The mean of quantized values _is_ finer-grained, but it weights a single boundary-straddling run by 1/n and is dominated by the fixture's own INP (~88 ms), so a 0.5 ms toolbar cost is a 0.6% shift on a number with several ms of run-to-run spread. |

---

## What replaced it: a paired sign test

The arms alternate within each iteration of the measurement loop, so run `i` of `on` and run
`i` of `gated` are neighbours in time on the same machine. That makes them legitimately
pairable, and pairing is what recovers the lost resolution.

The argument:

```
   a toolbar that costs a fraction of a quantum

     run:   1    2    3    4    5    6    7    8
     gated  88   88   88   96   88   88   88   88
     on     88   96   88   96   96   88   96   88
                 ^         =    ^         ^
            some runs tip over a boundary, none tip back
            -> a consistent DIRECTION, long before a shifted percentile


   a toolbar that costs nothing

     gated  88   96   88   88   96   88   88   96
     on     88   88   96   88   96   96   88   88
                 v    ^         =    ^    =    v
            scatter both ways
```

So the question stops being _"how many milliseconds"_ — which the metric cannot answer — and
becomes _"is `on` worse more often than chance explains"_, which twenty paired comparisons can
answer well below one quantum of resolution.

### The computation

Count the pairs, then ask how surprising the split is.

```
   worse   = #{ i : on[i] >  gated[i] }
   better  = #{ i : on[i] <  gated[i] }
   ties    = #{ i : on[i] == gated[i] }
```

Ties carry no information about direction and are dropped — the standard treatment for a sign
test. On a fast machine almost every run ties, which correctly makes the test unable to fire:
no evidence, no verdict.

Under the null hypothesis _"the toolbar changes nothing"_, each decisive pair is a coin flip.
So the number of `worse` runs is Binomial(`m`, ½) where `m = worse + better`, and the one-sided
p-value is the upper tail:

```
                     m
                    ---
                    \    / m \
   P(X >= worse) =   >   |   |   /  2^m
                    /    \ k /
                    ---
                  k = worse
```

One-sided deliberately: a toolbar that makes the host _faster_ is not a budget failure.

```ts
const trials = worse + better;
if (trials === 0) return { worse, better, ties, p: 1 };
let tail = 0;
for (let k = worse; k <= trials; k++) tail += choose(trials, k);
return { worse, better, ties, p: tail / 2 ** trials };
```

`choose` is computed multiplicatively rather than through factorials, so nothing overflows and
nothing needs a big-integer type:

```ts
function choose(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}
```

The division happens _inside_ the loop, keeping the running value near the final magnitude
rather than climbing through `n!` and back down. Each partial product `result * (n - i) / (i + 1)`
is exact in binomial arithmetic, and at the sizes this runs at (n ≤ a few hundred) the result
is exact in a double.

### What the threshold means now

```json
"inpSignificance": 0.05
```

Not a millisecond figure — a confidence. The row fails when the probability of seeing this
many `worse` runs by chance drops below 5%.

This matters for how the number gets changed. A millisecond threshold invites being nudged
until CI goes green, and `budget.json`'s process exists to make that a reviewed decision. A
p-value cannot be nudged in the same way: moving 0.05 to 0.10 is visibly a statement that the
project accepts a one-in-ten false-pass rate, not a plausible-looking increment.

### What it costs

|                |                                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sensitivity    | With n = 20 and no ties, 15 of 20 worse gives p ≈ 0.021 — fails. 14 of 20 gives p ≈ 0.058 — passes. So the test needs a fairly consistent direction, which is the intended strictness.                                                         |
| Blind spot     | It reports direction, not magnitude. A toolbar that added 200 ms to _one_ run of twenty and nothing to the rest would pass this row. That is what `tbtP95` and `attributedFrameMsP95` are for — both are continuous and both are gated at p95. |
| Tie-heavy runs | On fast hardware `m` is small and the test cannot reach significance. That is honest — it means the machine could not resolve the question — but it also means a green run on a fast machine says less than a green run on CI.                 |

---

## The invariant

The rule the two failures violated, stated so it can be checked before a row is added rather
than discovered by a runner:

> A budget row's metric SHALL resolve finer than the threshold it gates on. Where the
> underlying value is quantized more coarsely than any threshold worth setting, the row
> compares a property that is not a magnitude — a direction, a rate, or a count of
> regressions — rather than gating on a difference the instrument cannot express.

Recorded as a scenario in `openspec/specs/observation-core/spec.md`.

---

## What the first calibration run said

The sign test was pushed to be exercised on CI, because a laptop fast enough to tie every run
cannot calibrate it. CI passed. Then the per-run arrays came back:

```
   on     [88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88]
   gated  [88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88]
   off    [88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88, 88]

   sign test:  0 worse, 0 better, 20 tied, p = 1.0000
```

**Sixty runs, one value.** Two conclusions, and the second is the important one.

The earlier failure was one run of twenty tipping into the next quantum, which `sorted[18]`
picked up. That diagnosis holds.

But the replacement row **cannot fail on this fixture** — not because the toolbar is free,
because there is no variance to read. Twenty ties, p = 1, green by vacuity. A row that fails on
noise was traded for a row that reports nothing, which on the honesty ladder is worse: the old
one at least moved.

### The cause is the fixture, not the statistic

`bench/README.md` describes _"an 84 ms blocking click handler, so INP has something real to
measure"_. That is right for a page that is supposed to be struggling and wrong as the place to
look for a toolbar:

```
   #confirm-hold, 84 ms of deliberate block

     |<---------------- 88 ms bucket ---------------->|
     |                                                 |
     |  fixture's own block  84 ms                     |
     |  d0bar                 3.5 ms  <-- 4% of the number, never shifts the bucket
```

Structurally identical to gating d0bar's main-thread cost through `longtask` against a fixture
that blocks 240 ms of its own accord — the problem `attributedFrameMs` was added to solve. The
same disease was left untreated one row over.

### The cheap target

`#cheap-tap` flips an `aria-pressed` attribute and does nothing else, so INP there is dominated
by the browser's own event-to-paint path and a toolbar cost is a real fraction of the result.

It is **counted, not timed**, and that is a platform constraint rather than a preference:

> `PerformanceObserver`'s `event` entry type clamps `durationThreshold` to a **minimum of
> 16 ms**. An interaction cheaper than that produces no entry at all.

So there is no way to ask the browser how long a sub-16 ms interaction took. What is observable
is only that an entry _exceeded_ the floor.

The first version of this row counted taps that **reached** the floor, at a provisional
threshold of five per twenty-run arm pool. CI falsified it in one run:

```
   cheap taps over the 16 ms floor: { off: 297, gated: 297, on: 297, budget: 5 }
   worst cheap tap p95 (ms):        { off: 16,  gated: 16,  on: 16 }
```

Two mistakes, both worth keeping written down:

|                     |                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wrong unit**      | 297 is `event` _entries_, not taps. One click emits pointerdown, pointerup and click sharing an `interactionId`. 100 clicks, ~300 entries.                                                                      |
| **Wrong direction** | Everything cheap is pinned _at_ the floor by the clamp, so "reached the floor" saturates for every arm including the two that run no toolbar. Green by vacuity again, one row over from where it was diagnosed. |

The signal is **strictly above** the floor. Chrome quantizes to 8 ms, so an entry lands there
only by gaining a whole quantum on an interaction that otherwise costs nothing:

```
   entry duration:   (no entry)  |  16  |  24  |  32 ...
                     -----------ceiling-------------------
                      invisible  | floor|  <-- the readable range
                                 |      |
                     everything cheap   one whole quantum above
                     saturates here     the cheapest observable
```

```
   ~15 entries per run, twenty runs

     arm pool:   0 .. ~300 entries above the floor
     resolution: one entry
     gate:       (on − gated) <= 3
```

Two CI runs then read 0/0/0, the threshold was set to zero — and the third read `off` 0, `gated` 3,
`on` 3.

That is the same defect a third time: a gate at zero against a metric whose per-arm noise is three
entries is finer than its own spread. And the shape of the failure carries its own answer. `gated`
loads the bundle and starts nothing, so three entries appearing there **and** in `on`, in equal
number, are the two-core runner and cannot be the toolbar.

So the gate is the **difference**, `on` minus `gated`, which noise hitting both arms cancels out of;
the absolutes stay in the report, where they show the metric is live rather than saturated. The
threshold is 3 — the largest per-arm count seen — because the delta must clear a full swing of it,
which puts the row's resolution at roughly 1% of cheap interactions gaining a quantum.

The earlier reasoning for gating absolutely — "an entry above the floor is not worse than the
baseline, it is a cheap interaction that cost a whole quantum" — was wrong, and wrong instructively:
it treats the two arms as independent measurements when they share a machine.

`inpSignificance` is kept. It is correct, and it will report a real shift if one ever appears.
It is simply no longer where the claim about d0bar's interaction cost rests.

---

## The pill clock, still open

If a directional cost does show up, the leading suspect is identified: `pill.ts` refreshes on a
500 ms interval, writing a text node and firing a pulse animation, while the A/B test clicks at
120 ms spacing. A repaint landing inside an interaction's presentation window is real INP — and
precisely the blind spot `attribution.ts` documents, since style and layout provoked by d0bar's
writes land in `AnimationFrame::StyleAndLayout`, which the browser attributes to no script.

That probe was not runnable before: toggling the clock and comparing INP gave 88 against 88
either way. Against `#cheap-tap` it becomes a question the instrument can answer.
