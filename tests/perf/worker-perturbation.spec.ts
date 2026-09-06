import { expect, test, type Page } from "@playwright/test";

/**
 * Task 2.6 — the worker's own cost, isolated.
 *
 * `ab.spec.ts` answers "what does the toolbar cost?" by comparing the bundle enabled against
 * disabled. It cannot answer this one, because both of its arms are on the same side of the
 * question: the worker is registered in one and absent in the other only as a side effect of
 * the whole toolbar being absent.
 *
 * The two arms here differ in exactly one thing. `?d0bar=on` and `?d0bar=on&sw=off` load the
 * identical bundle, start the identical toolbar, and run the identical fixture; the second
 * simply omits the worker path, so no registration happens. Everything the toolbar costs is
 * therefore present in both and cancels, and what is left is the worker.
 *
 * This is the comparison `tier2.spec.ts` says it cannot make. The overhead assertion there
 * bounds `fetchStart - workerStart`, which is service-worker *dispatch* — a cost any registered
 * worker imposes, d0bar's handler or not. It does not separate d0bar's handler from the
 * browser's machinery. This does, because the no-worker arm has neither.
 *
 * Compared at p95, never the mean: a worker that is usually free and occasionally costs
 * milliseconds is not free, and a mean hides exactly that.
 */

const RUNS = Number(process.env.D0BAR_SW_RUNS ?? 6);

/** Above the noise floor measured on this fixture, low enough to catch a real regression. */
const BUDGET_MS = 12;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] as number;
}

/**
 * One load's request durations, in issue order.
 *
 * `responseEnd - startTime` rather than `duration`, so the number is the same shape in both
 * arms: `duration` is defined from `startTime` to `responseEnd` anyway, but reading the two
 * fields explicitly makes it obvious that nothing worker-specific is being folded in.
 *
 * Only the fixture's own API traffic is measured. The bundle, the worker script and the page's
 * static assets are excluded — the worker script is fetched in one arm and not the other, so
 * including it would measure the arm rather than the effect.
 */
async function sample(page: Page, query: string): Promise<number[]> {
  await page.goto(`/${query}`, { waitUntil: "load" });
  await page.evaluate(
    () => (window as unknown as { __fixtureReady: Promise<void> }).__fixtureReady,
  );
  /* Let the post-settle work land, including registration in the arm that has it. Measuring
     while the worker is still installing would compare a page that has one against a page
     that is halfway to having one. */
  await page.waitForTimeout(1500);

  return page.evaluate(() =>
    (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((entry) => entry.name.includes("/api/") || entry.name.includes("/legacy/"))
      .map((entry) => entry.responseEnd - entry.startTime)
      .filter((value) => value > 0),
  );
}

test(
  "registering the worker does not move request latency",
  { tag: "@timing" },
  async ({ page }) => {
    test.setTimeout(180_000);

    const withWorker: number[] = [];
    const without: number[] = [];

    /* Interleaved, not one arm then the other. A machine that gets busy halfway through would
     otherwise load the entire penalty onto whichever arm ran second, and the result would be
     an artefact of scheduling rather than a measurement of the worker. */
    for (let run = 0; run < RUNS; run += 1) {
      withWorker.push(...(await sample(page, "?d0bar=on")));
      without.push(...(await sample(page, "?d0bar=on&sw=off")));
    }

    const onP95 = percentile(withWorker, 95);
    const offP95 = percentile(without, 95);
    const delta = onP95 - offP95;

    const report =
      `worker ON  n=${withWorker.length} p50=${percentile(withWorker, 50).toFixed(1)}ms p95=${onP95.toFixed(1)}ms\n` +
      `worker OFF n=${without.length} p50=${percentile(without, 50).toFixed(1)}ms p95=${offP95.toFixed(1)}ms\n` +
      `delta p95  ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}ms (budget ${BUDGET_MS}ms)`;
    console.log(report);

    expect(withWorker.length, "the worker arm produced no requests to compare").toBeGreaterThan(
      20,
    );
    expect(without.length, "the no-worker arm produced no requests to compare").toBeGreaterThan(
      20,
    );

    /* One-sided. A negative delta means the worker arm was *faster*, which is noise rather than
     a finding, and failing on it would make the suite flaky in the one direction that cannot
     indicate a regression. */
    expect(delta, report).toBeLessThan(BUDGET_MS);
  },
);
