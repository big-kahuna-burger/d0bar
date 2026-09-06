import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { attributedDuring, isD0bar } from "./attribution";

/**
 * The observer-effect budget.
 *
 * d0bar's central claim is that it does not distort what it measures. This is where that
 * stops being a claim: the same fixture is loaded with the toolbar enabled and disabled, and
 * the difference between the two distributions is compared against a committed threshold.
 *
 * Deltas are compared at p95, never at the mean — a toolbar that is usually free and
 * occasionally costs 40ms is not free, and a mean hides exactly that.
 *
 * Two things about the shape of this file, both of them corrections:
 *
 * **The baseline is `gated`, not `off`.** The gated arm loads the identical bundle and starts
 * nothing, so comparing against it controls for the script download and parse — which a host
 * pays whether or not they opt in, and which is not the observer effect. `off` is kept as a
 * third arm because the difference between `off` and `gated` is itself worth seeing.
 *
 * **The gate on d0bar's own main-thread cost is attributed, not inferred.** Every metric below
 * except `attributedFrameMs` is a difference between two arms of a fixture that deliberately
 * blocks for 240 ms, measured through `longtask`, which has a 50 ms floor. The example
 * `CLAUDE.md` opens with — a toolbar that adds 40 ms to a frame — produces no long task, no TBT
 * delta, no CLS, and an INP delta only if it collides with one of five clicks. It would have
 * passed every row here. `attributedFrameMs` reads the browser's own tracer and sums the script
 * time whose URL is d0bar's, per top-level task, with no floor at all.
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
  /** Taps on the fixture's cheap target that were slow enough to be reported at all, of 5. */
  cheapTapsOverFloor: number;
  /** The worst reported cheap tap, in ms. 0 means none crossed the 16 ms reporting floor. */
  cheapTapMax: number;
}

interface Budget {
  inpSignificance: number;
  cls: number;
  tbtP95: number;
  longTaskCount: number;
  attributedFrameMs: number;
  cheapTapsOverFloor: number;
}

/** Committed thresholds. Raising one requires reviewer sign-off in the PR body. */
const BUDGET: Budget = {
  cls: 0.001,
  tbtP95: 5,
  longTaskCount: 0.5,
  /**
   * The confidence at which a paired directional shift in INP counts as real. Not a
   * millisecond figure: INP is quantized to 8 ms, so no millisecond threshold below 8 is
   * expressible and any threshold at or above 8 gates nothing a developer would notice. See
   * `signTest`.
   */
  inpSignificance: 0.05,
  /**
   * Absolute, not a delta: provenance makes the subtraction unnecessary, because every
   * millisecond counted here ran d0bar's own code. Eight milliseconds is the same figure
   * `requests-view`'s two rows use — roughly half a 16 ms frame — and it is a ceiling on the
   * *worst* task of a run, not an average.
   */
  attributedFrameMs: 8,
  /**
   * How many more of the twenty runs' cheap taps may cross the 16 ms reporting floor in `on`
   * than in `gated`, summed across the run.
   *
   * Five taps per run, twenty runs, so the pool is 0-100 per arm and the resolution is one
   * tap. This is the row that answers the question `inp` cannot: `#confirm-hold` blocks for
   * 84 ms deliberately, which quantizes to 88 on every run of every arm — sixty CI runs
   * returned 88 sixty times — so a toolbar costing single-digit milliseconds is invisible
   * inside it. `#cheap-tap` flips an attribute and nothing else, so it sits just under the
   * floor and anything that pushes it over is visible as a count.
   *
   * Five is provisional and marked as such in `bench/budget.json`: it is a fifth of one arm's
   * pool, chosen before the first calibration run rather than after it. The number to replace
   * it with is whatever `gated`'s own run-to-run spread turns out to be on CI.
   */
  cheapTapsOverFloor: 5,
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
 * A metric a budget row may gate on must be able to express a value smaller than its own
 * threshold. Two rows in this file violated that and both were caught by one CI run on a
 * two-core runner:
 *
 * | row              | threshold | metric resolution | outcome                          |
 * | ---------------- | --------- | ----------------- | -------------------------------- |
 * | `longTaskCount`  | 0.5 tasks | 1 task (p95 of an integer count) | failed on ±1 noise |
 * | `inpP95`         | 2 ms      | 8 ms (Chrome's INP quantum)      | failed on one boundary crossing |
 *
 * `percentile(values, 95)` at n = 20 is `sorted[18]` — the *second largest of twenty*. That is
 * the right aggregation for a continuous metric with a long tail and the wrong one for a
 * quantized one, where it is a single noisy sample and its noise floor is a whole quantum.
 *
 * Long tasks go back to the mean, whose resolution at n = 20 is 0.05 tasks — finer than the
 * 0.5 threshold. This file's header says "never at the mean", and that rule is about not
 * hiding a tail; for an integer count over twenty runs the p95 *is* one sample from the tail,
 * so the rule was being applied to the one row where it inverts.
 *
 * INP cannot be fixed by choosing a different order statistic, because every order statistic
 * of a quantized metric is quantized. It is compared as a paired sign test instead — see
 * {@link signTest}.
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
 * Paired comparison of two arms, run by run.
 *
 * The arms alternate within each iteration of the measurement loop, so run `i` of `on` and run
 * `i` of `gated` are neighbours in time on the same machine — which is what makes pairing them
 * legitimate and what makes this robust to the drift a single order statistic is at the mercy
 * of.
 *
 * The resolution argument: one p95 comparison of a quantized metric can only ever report a
 * multiple of the quantum, so it cannot distinguish "0.1 ms of cost that crossed a boundary"
 * from "8 ms of cost". Twenty paired comparisons can: a toolbar that costs a fraction of a
 * quantum pushes *some* runs over a boundary and none back, and that shows up as a consistent
 * direction long before it shows up as a shifted percentile. A toolbar that costs nothing
 * scatters both ways.
 *
 * Reported as a probability rather than gated against a hand-picked count, so the threshold is
 * a stated confidence rather than a number someone tuned until CI went green.
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

    /* Real input events, so the browser produces genuine `event` entries with interaction ids
       rather than synthetic ones that never reach INP.

       Two targets, measuring two different things. `#confirm-hold` blocks 84 ms and gives the
       fixture the poor INP it is supposed to have; two clicks are enough, because with fewer
       than fifty interactions INP is simply the slowest one. `#cheap-tap` does almost nothing
       and is where a toolbar cost is actually visible — see `cheapTapsOverFloor`. */
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
      cheapTapsOverFloor: metrics.cheapTapsOverFloor,
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
         * Reported per arm, gated by `inpSign` below rather than by a delta between these.
         *
         * The median is the arm's typical quantum and the p95 is its tail; both are useful to
         * read and neither can be compared against a 2 ms threshold, because the smallest
         * difference either can express is 8 ms. Raw per-run values travel with them so a
         * future reader of `bench/last-budget.json` can re-analyse without re-running.
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
         * The mean, deliberately, and this row went p95 and back within one change.
         *
         * The file header's "never at the mean" is about not hiding a tail. Long tasks are an
         * integer count, so at twenty runs the p95 is `sorted[18]` — one sample, with a noise
         * floor of a whole task against a threshold of half of one. CI measured `off` 7,
         * `gated` 6, `on` 7: the `on` arm tied with the arm that loads no bundle, while the
         * baseline scored *below* both, which is not a direction a baseline can meaningfully
         * take. The mean's resolution at n = 20 is 0.05 tasks, finer than the threshold, which
         * is the property the row needs.
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
         * Summed across runs, not aggregated at a percentile — the per-run value is 0 to 5 and
         * a percentile of it has the same resolution problem as the long-task row did. The sum
         * over twenty runs is 0 to 100 per arm and its resolution is one tap.
         */
        cheapTapsOverFloor: {
          off: sum(pick("off", "cheapTapsOverFloor")),
          gated: sum(pick("gated", "cheapTapsOverFloor")),
          on: sum(pick("on", "cheapTapsOverFloor")),
          budget: BUDGET.cheapTapsOverFloor,
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
      cheapTapsOverFloor: against("cheapTapsOverFloor"),
      lcpP95: against("lcpP95"),
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
    console.log("cheap taps over the 16 ms floor:", result.metrics.cheapTapsOverFloor);
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
     * INP, as a direction rather than a magnitude.
     *
     * Fails when `on` lands in a worse quantum than `gated` more consistently than chance would
     * explain. A toolbar costing a fraction of a quantum tips some runs over a boundary and
     * none back, which this sees; a toolbar costing nothing scatters both ways, which it does
     * not. See `signTest` for why no millisecond threshold is expressible here.
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

    /* The controls, and the first of them corrected a wrong expectation of this file's author:
     `gated` is not zero and should not be. That arm loads the bundle and evaluates it — the
     IIFE body runs, reads the opt-in attribute, finds nothing and returns — which is real
     d0bar script time and is exactly the cost the gated baseline exists to hold constant.
     Measured at 0.287 ms p95 over four runs. `off` loads no bundle at all, so it is zero. */
    expect(
      result.metrics.attributedFrameMsP95.gated,
      "the gated arm evaluates the bundle and does nothing else",
    ).toBeLessThanOrEqual(2);
    expect(result.metrics.attributedFrameMsP95.off, "the off arm loads no d0bar").toBe(0);
  },
);
