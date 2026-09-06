import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { attributedDuring, isD0bar } from "./attribution";

/**
 * The observer-effect budget: the same fixture loaded with the toolbar enabled and disabled, the
 * difference gated against a committed threshold. p95, never the mean — except where the metric is
 * quantized, which is {@link percentile}'s note.
 *
 * Two corrections are built into the shape:
 *
 * **The baseline is `gated`, not `off`.** The gated arm loads the identical bundle and starts
 * nothing, so it controls for download and parse — a cost a host pays either way, and not the
 * observer effect. `off` stays as a third arm because `off` vs `gated` is itself worth seeing.
 *
 * **The main-thread gate is attributed, not inferred.** Every row but `attributedFrameMs` is a
 * difference between two arms of a fixture that deliberately blocks 240 ms, read through `longtask`
 * and its 50 ms floor. `CLAUDE.md`'s opening example — a toolbar adding 40 ms to a frame — produces
 * no long task, no TBT delta and no CLS, and would have passed every one of them.
 * `attributedFrameMs` reads the browser's own tracer and sums d0bar-URL script time per top-level
 * task, with no floor.
 *
 * Each threshold's history is `bench/budget.json`; the resolution arithmetic is
 * `bench/quantized-metrics.md`. Neither is repeated here.
 */

const RUNS = Number(process.env.D0BAR_RUNS ?? 20);

interface Sample {
  lcp: number;
  cls: number;
  tbt: number;
  longTasks: number;
  inp: number;
  /** The largest d0bar-attributed script total inside any one top-level task, in ms. */
  attributedFrameMs: number;
  /** d0bar-attributed script time across the whole run, in ms. */
  attributedTotalMs: number;
  /** Cheap-tap `event` entries that exceeded the 16 ms reporting floor — a whole quantum. */
  cheapTapsOverQuantum: number;
  /** Every cheap-tap entry delivered at all. Saturates at the floor; reported, never gated. */
  cheapTapEntries: number;
  /** The worst reported cheap tap, in ms. 16 means every one of them sat on the floor. */
  cheapTapMax: number;
}

interface Budget {
  inpSignificance: number;
  cls: number;
  tbtP95: number;
  longTaskCount: number;
  attributedFrameMs: number;
  cheapTapsOverQuantum: number;
}

/** Committed thresholds. Raising one requires reviewer sign-off in the PR body. */
const BUDGET: Budget = {
  cls: 0.001,
  tbtP95: 5,
  longTaskCount: 0.5,
  /**
   * Confidence at which a paired directional shift in INP counts as real. Not a millisecond figure:
   * INP is quantized to 8 ms, so nothing below 8 is expressible and nothing at or above it gates
   * anything a developer would notice. See {@link signTest}.
   */
  inpSignificance: 0.05,
  /**
   * Absolute, not a delta: provenance makes the subtraction unnecessary, since every millisecond
   * counted ran d0bar's own code. 8 ms is `requests-view`'s figure — half a frame — and it ceilings
   * the *worst* task of a run, not an average.
   */
  attributedFrameMs: 8,
  /**
   * How many more cheap-tap `event` entries may exceed the 16 ms floor in `on` than in `gated`,
   * summed over an arm's runs (~300 entries each).
   *
   * The row `inp` cannot be: `#confirm-hold` blocks 84 ms, quantizing to 88 on every run of every
   * arm, so single-digit milliseconds are invisible inside it. `#cheap-tap` flips an attribute.
   * Counted, not timed, because `durationThreshold` clamps to 16 ms — a cheap interaction can only
   * be observed to have exceeded.
   *
   * **A delta, after two wrong versions of this row.** The first counted entries that *reached* the
   * floor and saturated at 297/297/297, because the clamp pins everything cheap there. The second
   * counted entries above the floor and gated each arm at zero — set from two CI runs of 0/0/0, and
   * the third read `off` 0, `gated` 3, `on` 3. A gate at zero against a metric whose per-arm noise
   * is three entries is a threshold finer than its own spread, which is the third time that defect
   * has appeared in this file.
   *
   * `gated` scoring exactly what `on` scored is the answer, not the problem: that arm loads the
   * bundle and starts nothing, so three shared entries are the two-core runner and cannot be the
   * toolbar. The absolutes are still reported — they are what shows the metric is live rather than
   * saturated — but the gate is the difference, which noise hitting both arms cancels out of. Three
   * is the largest per-arm count seen, so the delta must clear a full swing of it; that puts this
   * row's resolution at about 1% of cheap interactions gaining a quantum.
   */
  cheapTapsOverQuantum: 3,
};

type Arm = "off" | "gated" | "on";
const ARMS: readonly Arm[] = ["off", "gated", "on"];

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] as number;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / (values.length || 1);
}

function median(values: number[]): number {
  return percentile(values, 50);
}

/**
 * **A gated metric must resolve finer than its own threshold.** Two rows here violated that, and one
 * CI run on a two-core runner caught both:
 *
 * | row             | threshold | resolution                       | outcome                    |
 * | --------------- | --------- | -------------------------------- | -------------------------- |
 * | `longTaskCount` | 0.5 tasks | 1 task (p95 of an integer count) | failed on ±1 noise         |
 * | `inpP95`        | 2 ms      | 8 ms (Chrome's INP quantum)      | failed on a boundary cross |
 *
 * At n = 20 this is `sorted[18]`, the second largest of twenty: right for a continuous metric with a
 * tail, wrong for a quantized one, where it is one noisy sample with a whole-quantum noise floor.
 * Long tasks use the mean instead (resolution 0.05 tasks). INP cannot be fixed by another order
 * statistic — every order statistic of a quantized metric is quantized — and uses {@link signTest}.
 * Derivation: `bench/quantized-metrics.md`.
 */

interface SignTest {
  /** Runs where `on` was worse than `gated`. */
  worse: number;
  /** Runs where `on` was better. */
  better: number;
  /** Runs where the two landed in the same quantum. */
  ties: number;
  /** One-sided binomial probability of seeing this many `worse` runs by chance. */
  p: number;
}

/**
 * Paired comparison of two arms, run by run. The arms alternate within each loop iteration, so run
 * `i` of each are neighbours in time on the same machine — which makes pairing legitimate and this
 * robust to the drift one order statistic is at the mercy of.
 *
 * One p95 of a quantized metric can only report a multiple of the quantum, so it cannot separate
 * "0.1 ms that crossed a boundary" from "8 ms". Twenty paired comparisons can: a fractional cost
 * pushes *some* runs over and none back, which reads as a direction long before it reads as a
 * shifted percentile. Reported as a probability, so the threshold is a stated confidence rather than
 * a count tuned until CI went green.
 */
function signTest(on: number[], gated: number[]): SignTest {
  let worse = 0;
  let better = 0;
  let ties = 0;
  for (let i = 0; i < Math.min(on.length, gated.length); i++) {
    const a = on[i] as number;
    const b = gated[i] as number;
    if (a > b) worse++;
    else if (a < b) better++;
    else ties++;
  }

  /* P(X >= worse) for X ~ Binomial(worse + better, 0.5). Ties carry no information about
     direction and are excluded, which is the standard treatment. */
  const trials = worse + better;
  if (trials === 0) return { worse, better, ties, p: 1 };
  let tail = 0;
  for (let k = worse; k <= trials; k++) tail += choose(trials, k);
  return { worse, better, ties, p: tail / 2 ** trials };
}

function choose(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

async function measure(page: Page, arm: Arm): Promise<Sample> {
  /* The tracer is started before the navigation, so the load phase — where the moratorium
     applies and where the toolbar's cost would matter most — is inside the window. */
  const attribution = await attributedDuring(page, isD0bar, async () => {
    await page.goto(`/?d0bar=${arm}`, { waitUntil: "load" });
    await page.evaluate(
      () => (window as unknown as { __fixtureReady: Promise<void> }).__fixtureReady,
    );

    /* Real input events, so the browser emits genuine `event` entries with interaction ids.
       `#confirm-hold` blocks 84 ms and gives the fixture its poor INP — two clicks suffice, since
       below fifty interactions INP is just the slowest. `#cheap-tap` does almost nothing, and is
       where a toolbar cost is visible: see `cheapTapsOverQuantum`. */
    for (let i = 0; i < 2; i++) {
      await page.click("#confirm-hold");
      await page.waitForTimeout(120);
    }
    for (let i = 0; i < 5; i++) {
      await page.click("#cheap-tap");
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(300);
  });

  const m = await page.evaluate(() => {
    const metrics = (window as unknown as { __metrics: Sample }).__metrics;
    return {
      lcp: metrics.lcp,
      cls: metrics.cls,
      tbt: metrics.tbt,
      longTasks: metrics.longTasks,
      inp: metrics.inp,
      cheapTapsOverQuantum: metrics.cheapTapsOverQuantum,
      cheapTapEntries: metrics.cheapTapEntries,
      cheapTapMax: metrics.cheapTapMax,
    };
  });
  return {
    ...m,
    attributedFrameMs: attribution.maxTaskMs,
    attributedTotalMs: attribution.totalMs,
  };
}

test(
  "the toolbar does not perturb what it measures",
  { tag: "@timing" },
  async ({ browser }) => {
    const samples: Record<Arm, Sample[]> = { off: [], gated: [], on: [] };

    /* One warm-up per arm, discarded: the first load of a fresh browser pays costs that have
     nothing to do with any arm. */
    for (const arm of ARMS) {
      const page = await browser.newPage();
      await measure(page, arm);
      await page.close();
    }

    /* Arms alternate rather than running in blocks, so machine drift over the run cannot land
     entirely on one of them. */
    for (let i = 0; i < RUNS; i++) {
      for (const arm of ARMS) {
        const page = await browser.newPage();
        samples[arm].push(await measure(page, arm));
        await page.close();
      }
    }

    const pick = (arm: Arm, key: keyof Sample) => samples[arm].map((s) => s[key]);
    const p95 = (arm: Arm, key: keyof Sample) => percentile(pick(arm, key), 95);
    const row = (key: keyof Sample) => ({
      off: p95("off", key),
      gated: p95("gated", key),
      on: p95("on", key),
    });

    const result = {
      runs: RUNS,
      generatedAt: new Date().toISOString(),
      /* Recorded so a reader of `bench/last-budget.json` does not have to know this file: every
       delta below is `on − gated`, not `on − off`. */
      baseline: "gated",
      metrics: {
        /**
         * Reported per arm, gated by `inpSign` rather than a delta between these: the median is the
         * arm's typical quantum and the p95 its tail, and neither can express a difference under
         * 8 ms. Raw per-run values travel with them, so `bench/last-budget.json` can be re-analysed
         * without re-running.
         */
        inp: {
          off: { median: median(pick("off", "inp")), p95: p95("off", "inp") },
          gated: { median: median(pick("gated", "inp")), p95: p95("gated", "inp") },
          on: { median: median(pick("on", "inp")), p95: p95("on", "inp") },
          runs: {
            off: pick("off", "inp"),
            gated: pick("gated", "inp"),
            on: pick("on", "inp"),
          },
        },
        /* The gate. `on` against `gated`, paired run by run. */
        inpSign: {
          ...signTest(pick("on", "inp"), pick("gated", "inp")),
          budget: BUDGET.inpSignificance,
        },
        /* The same test against `off`, reported and not gated. It answers a different question
         — what the whole bundle costs, download and parse included — and it is here because
         the CI run that prompted this rewrite showed `off` and `gated` scoring identically on
         INP, which is worth being able to see again. */
        inpSignAgainstOff: signTest(pick("on", "inp"), pick("off", "inp")),
        tbtP95: { ...row("tbt"), budget: BUDGET.tbtP95 },
        clsMax: {
          off: Math.max(...pick("off", "cls")),
          gated: Math.max(...pick("gated", "cls")),
          on: Math.max(...pick("on", "cls")),
          budget: BUDGET.cls,
        },
        /**
         * The mean, deliberately — this row went p95 and back within one change. "Never at the mean"
         * is about not hiding a tail, but for an integer count the p95 at n = 20 *is* one tail
         * sample, with a whole-task noise floor against a half-task threshold. CI read `off` 7,
         * `gated` 6, `on` 7: `on` tied with the arm that loads no bundle and the baseline scored
         * below both. The mean resolves to 0.05 tasks, which is the property the row needs.
         */
        longTasksMean: {
          off: mean(pick("off", "longTasks")),
          gated: mean(pick("gated", "longTasks")),
          on: mean(pick("on", "longTasks")),
          budget: BUDGET.longTaskCount,
        },
        /* Absolute rather than a delta: provenance makes the subtraction unnecessary. `gated`
         is the bundle's own evaluation and `off` is zero; both are asserted as controls. */
        attributedFrameMsP95: { ...row("attributedFrameMs"), budget: BUDGET.attributedFrameMs },
        attributedTotalMsP95: row("attributedTotalMs"),
        /**
         * Summed across runs, not aggregated at a percentile — the per-run value is a small
         * integer and a percentile of one has the same resolution problem the long-task row
         * had. A sum has resolution one entry, at any count.
         */
        cheapTapsOverQuantum: {
          off: sum(pick("off", "cheapTapsOverQuantum")),
          gated: sum(pick("gated", "cheapTapsOverQuantum")),
          on: sum(pick("on", "cheapTapsOverQuantum")),
          budget: BUDGET.cheapTapsOverQuantum,
        },
        /* For reading, never gated: saturates at the floor — CI measured 297/297/297 — so it
         says the taps happened and the observer was listening, and nothing more. */
        cheapTapEntries: {
          off: sum(pick("off", "cheapTapEntries")),
          gated: sum(pick("gated", "cheapTapEntries")),
          on: sum(pick("on", "cheapTapEntries")),
        },
        /* For reading: what a cheap tap actually cost when it did cross the floor. */
        cheapTapMaxP95: row("cheapTapMax"),
        /* Reported for visibility, not gated: LCP on this fixture is dominated by a fixed
         server delay, so its run-to-run spread is wider than any toolbar effect. */
        lcpP95: row("lcp"),
      },
    };

    const against = (key: keyof typeof result.metrics): number => {
      const metric = result.metrics[key] as { on: number; gated: number };
      return metric.on - metric.gated;
    };

    const deltas = {
      tbtP95: against("tbtP95"),
      cls: against("clsMax"),
      longTasksMean: against("longTasksMean"),
      lcpP95: against("lcpP95"),
      cheapTapsOverQuantum: against("cheapTapsOverQuantum"),
      /* Deliberately absent: `attributedFrameMsP95` is not a difference, and INP is not
       compared as one — see `inpSign`. */
    };

    writeFileSync(
      join(process.cwd(), "bench", "last-budget.json"),
      JSON.stringify({ ...result, deltas }, null, 2),
      "utf8",
    );

    const sign = result.metrics.inpSign;

    console.log("observer-effect deltas (on − gated):", deltas);
    console.log("attributed d0bar main-thread time:", result.metrics.attributedFrameMsP95);
    console.log("cheap-tap entries over the 16 ms floor:", result.metrics.cheapTapsOverQuantum);
    console.log("cheap-tap entries delivered:", result.metrics.cheapTapEntries);
    console.log("worst cheap tap p95 (ms):", result.metrics.cheapTapMaxP95);
    console.log("INP per arm (median / p95):", {
      off: result.metrics.inp.off,
      gated: result.metrics.inp.gated,
      on: result.metrics.inp.on,
    });
    console.log(
      `INP paired sign test (on vs gated): ${sign.worse} worse, ${sign.better} better, ` +
        `${sign.ties} tied, p=${sign.p.toFixed(4)}`,
    );

    expect(deltas.tbtP95, "Δp95 TBT").toBeLessThanOrEqual(BUDGET.tbtP95);
    expect(deltas.cls, "Δ CLS").toBeLessThanOrEqual(BUDGET.cls);
    expect(deltas.longTasksMean, "Δ mean long-task count").toBeLessThanOrEqual(
      BUDGET.longTaskCount,
    );

    /**
     * INP as a direction rather than a magnitude: fails when `on` lands in a worse quantum than
     * `gated` more consistently than chance explains. A fractional cost tips some runs over a
     * boundary and none back; a free one scatters both ways. See {@link signTest}.
     */
    expect(
      sign.p,
      `INP regressed in ${sign.worse} of ${sign.worse + sign.better} decisive runs ` +
        `(${sign.ties} tied); p=${sign.p.toFixed(4)}`,
    ).toBeGreaterThan(BUDGET.inpSignificance);

    /* The row with provenance. Not a delta and not floored: this is d0bar's own script time in
     the worst top-level task of a run, at p95 across runs. */
    expect(
      result.metrics.attributedFrameMsP95.on,
      "p95 of the worst d0bar-attributed task",
    ).toBeLessThanOrEqual(BUDGET.attributedFrameMs);

    /**
     * The control, singular. `off` loads no bundle, so zero is the only correct value rather than a
     * threshold — a non-zero reading means the URL matcher is catching something that is not d0bar.
     *
     * `gated` was gated here too at `<= 2` ms, and was wrong twice: written from a laptop's 0.287 ms
     * and returning 1.32, 3.21 and 2.586 across three CI runs — a threshold finer than the metric's
     * own spread — and gating download-and-evaluation, which is not the observer effect. It is a
     * reading in `bench/last-budget.json` now, not a gate.
     */
    expect(result.metrics.attributedFrameMsP95.off, "the off arm loads no d0bar").toBe(0);

    /**
     * The cheap target: an attribute flip must not cost a whole 8 ms quantum more often with the
     * toolbar running than with it merely loaded. Compared against `gated`, because a count that
     * appears in the baseline too is the runner — see the note on the budget entry.
     */
    expect(
      deltas.cheapTapsOverQuantum,
      `over the 16 ms floor: off ${result.metrics.cheapTapsOverQuantum.off}, ` +
        `gated ${result.metrics.cheapTapsOverQuantum.gated}, ` +
        `on ${result.metrics.cheapTapsOverQuantum.on} ` +
        `of ~${result.metrics.cheapTapEntries.on} entries per arm`,
    ).toBeLessThanOrEqual(BUDGET.cheapTapsOverQuantum);
  },
);
