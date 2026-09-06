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
}

interface Budget {
  inpP95: number;
  cls: number;
  tbtP95: number;
  longTaskCount: number;
  attributedFrameMs: number;
}

/** Committed thresholds. Raising one requires reviewer sign-off in the PR body. */
const BUDGET: Budget = {
  inpP95: 2,
  cls: 0.001,
  tbtP95: 5,
  longTaskCount: 0.5,
  /**
   * Absolute, not a delta: provenance makes the subtraction unnecessary, because every
   * millisecond counted here ran d0bar's own code. Eight milliseconds is the same figure
   * `requests-view`'s two rows use — roughly half a 16 ms frame — and it is a ceiling on the
   * *worst* task of a run, not an average.
   */
  attributedFrameMs: 8,
};

type Arm = "off" | "gated" | "on";
const ARMS: readonly Arm[] = ["off", "gated", "on"];

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] as number;
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
       rather than synthetic ones that never reach INP. */
    for (let i = 0; i < 5; i++) {
      await page.click("#confirm-hold");
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
    };
  });
  return {
    ...m,
    attributedFrameMs: attribution.maxTaskMs,
    attributedTotalMs: attribution.totalMs,
  };
}

test("the toolbar does not perturb what it measures", async ({ browser }) => {
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
      inpP95: { ...row("inp"), budget: BUDGET.inpP95 },
      tbtP95: { ...row("tbt"), budget: BUDGET.tbtP95 },
      clsMax: {
        off: Math.max(...pick("off", "cls")),
        gated: Math.max(...pick("gated", "cls")),
        on: Math.max(...pick("on", "cls")),
        budget: BUDGET.cls,
      },
      /* p95, not the mean. The header of this file has said "never at the mean" since it was
         written, and this row was a mean until `enforce-non-perturbation`. */
      longTasksP95: { ...row("longTasks"), budget: BUDGET.longTaskCount },
      /* Absolute rather than a delta: provenance makes the subtraction unnecessary. `gated`
         is the bundle's own evaluation and `off` is zero; both are asserted as controls. */
      attributedFrameMsP95: { ...row("attributedFrameMs"), budget: BUDGET.attributedFrameMs },
      attributedTotalMsP95: row("attributedTotalMs"),
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
    inpP95: against("inpP95"),
    tbtP95: against("tbtP95"),
    cls: against("clsMax"),
    longTasksP95: against("longTasksP95"),
    lcpP95: against("lcpP95"),
    /* Deliberately absent from the deltas: `attributedFrameMsP95` is not a difference. */
  };

  writeFileSync(
    join(process.cwd(), "bench", "last-budget.json"),
    JSON.stringify({ ...result, deltas }, null, 2),
    "utf8",
  );

  console.log("observer-effect deltas (on − gated):", deltas);
  console.log("attributed d0bar main-thread time:", result.metrics.attributedFrameMsP95);

  expect(deltas.inpP95, "Δp95 INP").toBeLessThanOrEqual(BUDGET.inpP95);
  expect(deltas.tbtP95, "Δp95 TBT").toBeLessThanOrEqual(BUDGET.tbtP95);
  expect(deltas.cls, "Δ CLS").toBeLessThanOrEqual(BUDGET.cls);
  expect(deltas.longTasksP95, "Δp95 long-task count").toBeLessThanOrEqual(BUDGET.longTaskCount);

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
});
