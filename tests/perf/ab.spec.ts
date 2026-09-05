import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The observer-effect budget.
 *
 * d0bar's central claim is that it does not distort what it measures. This is where that
 * stops being a claim: the same fixture is loaded with the toolbar enabled and disabled, and
 * the difference between the two distributions is compared against a committed threshold.
 *
 * Deltas are compared at p95, never at the mean — a toolbar that is usually free and
 * occasionally costs 40ms is not free, and a mean hides exactly that.
 */

const RUNS = Number(process.env.D0BAR_RUNS ?? 20);

interface Sample {
  lcp: number;
  cls: number;
  tbt: number;
  longTasks: number;
  inp: number;
}

interface Budget {
  inpP95: number;
  cls: number;
  tbtP95: number;
  longTaskCount: number;
}

/** Committed thresholds. Raising one requires reviewer sign-off in the PR body. */
const BUDGET: Budget = {
  inpP95: 2,
  cls: 0.001,
  tbtP95: 5,
  longTaskCount: 0.5,
};

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] as number;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / (values.length || 1);
}

async function measure(page: Page, arm: "on" | "off"): Promise<Sample> {
  await page.goto(`/?d0bar=${arm}`, { waitUntil: "load" });
  await page.evaluate(() => (window as unknown as { __fixtureReady: Promise<void> }).__fixtureReady);

  /* Real input events, so the browser produces genuine `event` entries with interaction ids
     rather than synthetic ones that never reach INP. */
  for (let i = 0; i < 5; i++) {
    await page.click("#confirm-hold");
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(300);

  return page.evaluate(() => {
    const m = (window as unknown as { __metrics: Sample }).__metrics;
    return { lcp: m.lcp, cls: m.cls, tbt: m.tbt, longTasks: m.longTasks, inp: m.inp };
  });
}

test("the toolbar does not perturb what it measures", async ({ browser }) => {
  const on: Sample[] = [];
  const off: Sample[] = [];

  /* One warm-up per arm, discarded: the first load of a fresh browser pays costs that have
     nothing to do with either arm. */
  for (const arm of ["off", "on"] as const) {
    const page = await browser.newPage();
    await measure(page, arm);
    await page.close();
  }

  /* Arms alternate rather than running in blocks, so machine drift over the run cannot land
     entirely on one of them. */
  for (let i = 0; i < RUNS; i++) {
    for (const arm of ["off", "on"] as const) {
      const page = await browser.newPage();
      const sample = await measure(page, arm);
      (arm === "on" ? on : off).push(sample);
      await page.close();
    }
  }

  const pick = (samples: Sample[], key: keyof Sample) => samples.map((s) => s[key]);

  const result = {
    runs: RUNS,
    generatedAt: new Date().toISOString(),
    metrics: {
      inpP95: {
        off: percentile(pick(off, "inp"), 95),
        on: percentile(pick(on, "inp"), 95),
        budget: BUDGET.inpP95,
      },
      tbtP95: {
        off: percentile(pick(off, "tbt"), 95),
        on: percentile(pick(on, "tbt"), 95),
        budget: BUDGET.tbtP95,
      },
      clsMax: {
        off: Math.max(...pick(off, "cls")),
        on: Math.max(...pick(on, "cls")),
        budget: BUDGET.cls,
      },
      longTasksMean: {
        off: mean(pick(off, "longTasks")),
        on: mean(pick(on, "longTasks")),
        budget: BUDGET.longTaskCount,
      },
      /* Reported for visibility, not gated: LCP on this fixture is dominated by a fixed
         server delay, so its run-to-run spread is wider than any toolbar effect. */
      lcpP95: { off: percentile(pick(off, "lcp"), 95), on: percentile(pick(on, "lcp"), 95) },
    },
  };

  const deltas = {
    inpP95: result.metrics.inpP95.on - result.metrics.inpP95.off,
    tbtP95: result.metrics.tbtP95.on - result.metrics.tbtP95.off,
    cls: result.metrics.clsMax.on - result.metrics.clsMax.off,
    longTasks: result.metrics.longTasksMean.on - result.metrics.longTasksMean.off,
    lcpP95: result.metrics.lcpP95.on - result.metrics.lcpP95.off,
  };

  writeFileSync(
    join(process.cwd(), "bench", "last-budget.json"),
    JSON.stringify({ ...result, deltas }, null, 2),
    "utf8",
  );

  console.log("observer-effect deltas (on − off):", deltas);

  expect(deltas.inpP95, "Δp95 INP").toBeLessThanOrEqual(BUDGET.inpP95);
  expect(deltas.tbtP95, "Δp95 TBT").toBeLessThanOrEqual(BUDGET.tbtP95);
  expect(deltas.cls, "Δ CLS").toBeLessThanOrEqual(BUDGET.cls);
  expect(deltas.longTasks, "Δ mean long-task count").toBeLessThanOrEqual(BUDGET.longTaskCount);
});
